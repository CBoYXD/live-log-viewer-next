"use client";

import { useState } from "react";

import { ArrowRight, X } from "@/components/icons";

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
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      resolve({ base64, mime: file.type || "image/png", preview: dataUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error("не вдалося прочитати картинку"));
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
    const picks = files.filter((entry) => entry.type.startsWith("image/"));
    if (!picks.length) return;
    Promise.all(picks.map(readImage))
      .then((pending) => {
        setImages((prev) => [...prev, ...pending]);
        handlers.onAdded?.();
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
