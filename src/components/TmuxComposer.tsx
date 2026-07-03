"use client";

import { useRef, useState } from "react";

import { useTmuxTarget } from "@/hooks/useTmuxTarget";

interface PendingImage {
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
 * Compact composer that sends text and pasted clipboard images to the tmux pane
 * a running agent lives in. Renders nothing until a tmux target is resolved for
 * the given pid, so callers can mount it unconditionally for live processes.
 */
export function TmuxComposer({ pid }: { pid: number }) {
  const target = useTmuxTarget(pid);
  const [text, setText] = useState("");
  const [image, setImage] = useState<PendingImage | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (target === null) return null;

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    readImage(file)
      .then((pending) => {
        setImage(pending);
        setStatus(null);
      })
      .catch((error: unknown) => {
        setStatus({ kind: "err", text: error instanceof Error ? error.message : "помилка картинки" });
      });
  };

  const send = async () => {
    if (sending || (!text.trim() && !image)) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pid,
          text,
          image: image ? { base64: image.base64, mime: image.mime } : undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; imagePath?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося надіслати" });
        return;
      }
      setText("");
      setImage(null);
      setStatus({ kind: "ok", text: json.imagePath ? `надіслано шлях: ${json.imagePath}` : "надіслано" });
      inputRef.current?.focus();
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
  };

  const canSend = !sending && (Boolean(text.trim()) || Boolean(image));

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1 border-b border-line bg-[#fbfbfd] px-2.5 py-1.5"
      aria-label={`Надіслати повідомлення агенту в tmux ${target}`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="shrink-0 rounded-full bg-chip px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#555]"
          title={`tmux ${target}`}
        >
          ▤ {target}
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={handlePaste}
          placeholder="написати агенту…"
          aria-label="Текст для агента"
          disabled={sending}
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-[#222] placeholder:text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Надіслати агенту"
          className="shrink-0 rounded-[8px] border border-line bg-accent px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
        >
          {sending ? "…" : "▸"}
        </button>
      </div>
      {image ? (
        <div className="flex items-center gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.preview} alt="прев'ю картинки" className="h-6 w-6 shrink-0 rounded border border-line object-cover" />
          <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-dim">🖼 буде надіслано шляхом до файлу</span>
          <button
            type="button"
            onClick={() => setImage(null)}
            aria-label="Скасувати картинку"
            className="shrink-0 rounded-[6px] border border-line bg-panel px-1.5 py-0.5 text-[10px] font-semibold text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            ✕
          </button>
        </div>
      ) : null}
      {status ? (
        <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
          {status.text}
        </span>
      ) : null}
    </form>
  );
}
