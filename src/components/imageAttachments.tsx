"use client";

import { useRef, useState } from "react";

import { ArrowRight, ImageIcon, X } from "@/components/icons";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";

export interface PendingImage {
  base64: string;
  mime: string;
  preview: string;
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        reject(new Error("не вдалося прочитати картинку"));
        return;
      }
      const base64 = dataUrl.slice(comma + 1);
      resolve({ base64, mime: file.type || "image/png", preview: dataUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error("не вдалося прочитати картинку"));
    reader.onabort = () => reject(new Error("читання картинки перервано"));
    reader.readAsDataURL(file);
  });
}

/**
 * Pending image attachments for a text field: paste from the clipboard or add
 * via a file picker, preview, remove, clear after send. Shared by the pane
 * composer and the spawn dialog so both accept images the same way.
 */
export function useImageAttachments(handlers: { onError: (message: string) => void; onAdded?: () => void }) {
  const [images, setImages] = useState<PendingImage[]>([]);

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    /* Validated against the same whitelist and size limit the server enforces
       (src/lib/imagePolicy.ts), so a rejected file is reported here instead of
       round-tripping to the API first. */
    const accepted: File[] = [];
    for (const file of files) {
      if (inboxImageExt(file.type) === null) {
        handlers.onError(`непідтримуваний формат картинки: ${file.name || file.type || "невідомий файл"}`);
        continue;
      }
      if (file.size > MAX_INBOX_IMAGE_BYTES) {
        handlers.onError(`${file.name || "картинка"}: завелика (ліміт 10 МБ)`);
        continue;
      }
      accepted.push(file);
    }
    if (!accepted.length) return;
    /* onAdded clears the status line at both call sites; a mixed batch keeps
       the rejection message on screen instead of wiping it right away. */
    const rejectedSome = accepted.length < files.length;
    Promise.all(accepted.map(readImage))
      .then((pending) => {
        setImages((prev) => [...prev, ...pending]);
        if (!rejectedSome) handlers.onAdded?.();
      })
      .catch((error: unknown) => {
        handlers.onError(error instanceof Error ? error.message : "помилка картинки");
      });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const picks = Array.from(event.clipboardData.items)
      .filter((entry) => entry.type.startsWith("image/"))
      .map((entry) => entry.getAsFile())
      .filter((entry): entry is File => entry !== null);
    if (!picks.length) return;
    event.preventDefault();
    addFiles(picks);
  };

  return {
    images,
    addFiles,
    handlePaste,
    removeAt: (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx)),
    clear: () => setImages([]),
  };
}

export function ImagePreviewStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (idx: number) => void }) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {images.map((image, idx) => (
        <div key={idx} className="group/img relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.preview} alt={`прев'ю картинки ${idx + 1}`} className="h-10 w-10 rounded border border-line object-cover" />
          <button
            type="button"
            onClick={() => onRemove(idx)}
            aria-label={`Прибрати картинку ${idx + 1}`}
            className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-line bg-panel text-dim shadow-card hover:text-err group-hover/img:flex focus-visible:flex focus-visible:outline-none"
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </div>
      ))}
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-dim">
        {images.length} {images.length === 1 ? "картинка" : "картинки"} <ArrowRight className="h-3 w-3" aria-hidden /> шляхами до файлів
      </span>
    </div>
  );
}

/** Hidden file input plus its trigger button, wired to a picker ref it owns
    internally. Shared by the pane composer and the spawn dialog. */
export function ImagePickerButton({
  onFiles,
  ariaLabel,
  className,
}: {
  onFiles: (files: File[]) => void;
  ariaLabel: string;
  className: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button type="button" aria-label={ariaLabel} onClick={() => fileRef.current?.click()} className={className}>
        <ImageIcon className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}
