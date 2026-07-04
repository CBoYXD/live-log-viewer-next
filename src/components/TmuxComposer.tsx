"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, Loader2, Play, SquareTerminal, X } from "@/components/icons";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import type { FileEntry } from "@/lib/types";

import { ImagePickerButton, ImagePreviewStrip, useImageAttachments } from "./imageAttachments";
import { MicButton } from "./MicButton";

interface SentEntry {
  id: number;
  text: string;
  at: number;
  /** How the message left: into an existing pane or by booting a new window. */
  via: "pane" | "spawn";
}

const SENT_LIMIT = 8;
const SPAWN_TTL_MS = 90_000;
const PANE_TTL_MS = 10 * 60_000;
const sentKey = (path: string) => "llvSent:" + path;

function readSent(path: string): SentEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sentKey(path)) ?? "[]") as SentEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Conversations that accept a message without a live pane: root sessions
    reopen through resume; subagents relay through their root conversation. */
function canMessageWithoutPane(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "сесія" || file.kind === "субагент";
  return file.root === "codex-sessions";
}

const draftKey = (path: string) => "llvDraft:" + path;

const hhmm = (at: number) => new Date(at).toLocaleTimeString("uk", { hour12: false, hour: "2-digit", minute: "2-digit" });

/**
 * Chat-style composer pinned under the feed. A live pane gets the text typed
 * straight into its tmux pane; a finished resumable conversation boots a new
 * agent window in the current tmux session with the text as the first prompt.
 * Sent messages stay visible as a queue above the input until dismissed.
 */
export function TmuxComposer({ file }: { file: FileEntry }) {
  const target = useTmuxTarget(file.pid, canMessageWithoutPane(file) ? file.path : undefined);
  /* Column reshuffles can remount the composer mid-typing; the draft lives in
     sessionStorage so the text survives the remount. */
  const [text, setTextState] = useState(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(draftKey(file.path)) ?? "";
  });
  const setText = (value: string) => {
    setTextState(value);
    if (value) sessionStorage.setItem(draftKey(file.path), value);
    else sessionStorage.removeItem(draftKey(file.path));
  };
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useImageAttachments({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onAdded: () => setStatus(null),
  });

  /* The field grows with its content up to ~6 rows, then scrolls inside
     itself. Measured from scrollHeight on every text change, which also
     covers restored drafts and dictation inserts. */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight + 2, 160) + "px";
  }, [text]);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => setSent(readSent(file.path)), [file.path]);

  /* The queue drains itself: a pane message is delivered once the transcript
     grew after the send moment; a spawn prompt lands in a fresh window whose
     transcript is a different file, so it expires by time instead. A pane
     relay into a subagent that has since finished never grows its transcript
     again, so pane entries also fall back to a TTL, just a longer one than
     spawn entries since a live pane can legitimately go quiet for a while. */
  useEffect(() => {
    const prune = () =>
      setSent((prev) => {
        const next = prev.filter((entry) => {
          if (entry.via === "pane") return file.mtime * 1000 < entry.at + 2_000 && Date.now() - entry.at < PANE_TTL_MS;
          return Date.now() - entry.at < SPAWN_TTL_MS;
        });
        if (next.length !== prev.length) sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
        return next.length !== prev.length ? next : prev;
      });
    prune();
    const timer = setInterval(prune, 5_000);
    return () => clearInterval(timer);
  }, [file.mtime, file.path]);

  const resumable = canMessageWithoutPane(file);
  if (target === null && !resumable) return null;
  const spawnMode = target === null;
  const relayMode = spawnMode && file.root === "claude-projects" && file.kind === "субагент";

  const persistSent = (next: SentEntry[]) => {
    setSent(next);
    sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
  };

  const send = async () => {
    if (sending || (!text.trim() && !attachments.images.length)) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pid: file.pid ?? undefined,
          path: file.path,
          text,
          images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; imagePaths?: string[]; target?: string; spawned?: boolean };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося надіслати" });
        return;
      }
      const imgCount = attachments.images.length;
      const entry: SentEntry = {
        id: Date.now(),
        text: text.trim() || (imgCount ? `${imgCount} ${imgCount === 1 ? "картинка" : "картинки"}` : ""),
        at: Date.now(),
        via: json.spawned ? "spawn" : "pane",
      };
      persistSent([...sent, entry].slice(-SENT_LIMIT));
      setText("");
      attachments.clear();
      setStatus({
        kind: "ok",
        text: json.spawned
          ? `запущено агента в tmux ${json.target ?? ""}`
          : json.imagePaths?.length
            ? `надіслано ${json.imagePaths.length} шлях(и)`
            : "надіслано",
      });
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

  const canSend = !sending && (Boolean(text.trim()) || attachments.images.length > 0);

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1 border-t border-line bg-[#fbfbfd] px-2.5 py-1.5"
      aria-label={spawnMode ? "Запустити агента з промптом у tmux" : `Надіслати повідомлення агенту в tmux ${target}`}
    >
      {sent.length ? (
        <div className="flex flex-col gap-0.5" aria-label="Черга надісланих повідомлень">
          {sent.map((entry) => (
            <div key={entry.id} className="flex items-center justify-end gap-1.5">
              <span
                className="min-w-0 max-w-[85%] truncate rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2 py-0.5 text-[11px] text-[#333]"
                title={entry.text}
              >
                {entry.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[9.5px] text-dim">
                {entry.via === "spawn" ? <Play className="h-2.5 w-2.5" aria-hidden /> : <ArrowRight className="h-2.5 w-2.5" aria-hidden />}
                {hhmm(entry.at)}
              </span>
              <button
                type="button"
                aria-label="Прибрати з черги"
                className="inline-flex shrink-0 items-center rounded px-0.5 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => persistSent(sent.filter((item) => item.id !== entry.id))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-1.5">
        <span
          className="mb-[3px] inline-flex shrink-0 items-center gap-1 rounded-full bg-chip px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#555]"
          title={relayMode ? "передасться через кореневу сесію гілки" : spawnMode ? "нове tmux-вікно з відновленим агентом" : `tmux ${target}`}
        >
          {relayMode ? (
            <>
              <ArrowUpToLine className="h-3 w-3" aria-hidden /> корінь
            </>
          ) : spawnMode ? (
            <>
              <Play className="h-3 w-3" aria-hidden /> resume
            </>
          ) : (
            <>
              <SquareTerminal className="h-3 w-3" aria-hidden /> {target}
            </>
          )}
        </span>
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onPaste={attachments.handlePaste}
          onKeyDown={(event) => {
            /* Enter sends like the old single-line input; Shift+Enter makes a
               new line. Composition guard keeps IME confirms from sending. */
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={relayMode ? "написати — передам через кореневу сесію…" : spawnMode ? "промпт — агент запуститься в tmux…" : "написати агенту…"}
          aria-label="Текст для агента"
          disabled={sending}
          className="min-w-0 flex-1 resize-none overflow-y-auto rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] leading-[18px] text-[#222] placeholder:text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <MicButton
          onText={(spoken) => {
            setText(text ? text.trimEnd() + " " + spoken : spoken);
            setStatus(null);
            inputRef.current?.focus();
          }}
          onError={(message) => setStatus({ kind: "err", text: message })}
        />
        <ImagePickerButton
          ariaLabel="Додати картинки"
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-panel px-2 py-1 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onFiles={attachments.addFiles}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={spawnMode ? "Запустити агента" : "Надіслати агенту"}
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-accent px-2.5 py-1 text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />
      {status ? (
        <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
          {status.text}
        </span>
      ) : null}
    </form>
  );
}
