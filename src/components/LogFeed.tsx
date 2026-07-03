"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLogTail } from "@/hooks/useLogTail";
import type { FileEntry } from "@/lib/types";

import { buildFeed, FeedItem } from "./feed/renderers";
import { isAuxTask } from "./projectModel";
import { TaskHeader } from "./TaskHeader";

/** Items rendered initially and added per «показати раніше» step. */
const RENDER_STEP = 1500;

/** Animated presence row: the agent of a live transcript is mid-turn right now. */
function WorkingRow({ label }: { label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-ok">
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok [animation-delay:300ms]" />
      </span>
      {label}
    </div>
  );
}

interface Props {
  file: FileEntry | null;
  files: FileEntry[];
  onSelect: (file: FileEntry) => void;
  showSvc: boolean;
  lineFilter: string;
  onStatus: (status: string) => void;
  paused: boolean;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  compact?: boolean;
}

export function LogFeed({ file, files, onSelect, showSvc, lineFilter, onStatus, paused, follow, setFollow, compact = false }: Props) {
  const tail = useLogTail(file, paused, compact ? 2500 : 0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_STEP);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => setVisibleCount(RENDER_STEP), [file?.path]);

  const feed = useMemo(
    () => (file ? buildFeed(file, tail.lines, showSvc, lineFilter.toLowerCase()) : { items: [], hiddenServiceCount: 0 }),
    [file, tail.lines, showSvc, lineFilter],
  );
  const hiddenLocal = Math.max(0, feed.items.length - visibleCount);
  const visibleItems = hiddenLocal ? feed.items.slice(-visibleCount) : feed.items;

  useEffect(() => {
    const time = tail.tickTime?.toLocaleTimeString("uk", { hour12: false }) ?? "";
    if (tail.error) onStatus(tail.error);
    else if (file) onStatus(`${(tail.size / 1024).toFixed(0)} kB${time ? " · " + time : ""}`);
    else onStatus("");
  }, [tail.error, tail.size, tail.tickTime, file, onStatus]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [feed.items.length, follow]);

  /* Older history grows the content above the viewport; keep what the user
     was reading in place by compensating the scroll offset. */
  useLayoutEffect(() => {
    const el = scroller.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [tail.prependGen, visibleCount]);

  const revealOlder = () => {
    const el = scroller.current;
    if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    if (hiddenLocal) setVisibleCount((value) => value + RENDER_STEP);
    else if (tail.hasMore) void tail.loadOlder().then(() => setVisibleCount((value) => value + RENDER_STEP));
  };
  const canRevealOlder = hiddenLocal > 0 || tail.hasMore;

  const lastItem = feed.items.at(-1);
  const workingLabel =
    lastItem?.kind === "cmd" && lastItem.call.status === "run"
      ? `🔧 виконує ${lastItem.call.cmd.split(/[\s:]/, 1)[0] || "інструмент"}…`
      : lastItem?.kind === "think"
        ? "✳ думає…"
        : "✳ працює…";

  return (
    <div
      ref={scroller}
      className={compact ? "min-h-0 flex-1 overflow-y-auto py-3" : "flex-1 overflow-y-auto py-6"}
      onScroll={(event) => {
        if (compact) return;
        const el = event.currentTarget;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
        if (atBottom !== follow) setFollow(atBottom);
        if (el.scrollTop < 120 && canRevealOlder && !tail.loadingOlder && !tail.loading) revealOlder();
      }}
    >
      <div className={compact ? "px-3 pb-4 text-[13px]" : "mx-auto w-full max-w-[1060px] px-6 pb-16"}>
        {!file ? (
          <div className="mt-[20vh] text-center text-dim">Вибери лог зліва — стрічка оновлюється сама</div>
        ) : (
          <>
            {compact && tail.hasMore ? (
              <button
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-line bg-bg px-2 py-1 text-[11px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => onSelect(file)}
              >
                ⤴ показано хвіст — відкрити повністю
              </button>
            ) : null}
            {!compact && canRevealOlder && feed.items.length ? (
              <button
                className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                disabled={tail.loadingOlder}
                onClick={revealOlder}
              >
                {tail.loadingOlder
                  ? "завантаження…"
                  : hiddenLocal
                    ? `показати раніше (сховано ${hiddenLocal})`
                    : "завантажити раніше з файлу"}
              </button>
            ) : null}
            {!compact && !canRevealOlder && feed.items.length ? (
              <div className="mb-3 text-center text-[11px] text-dim">початок розмови</div>
            ) : null}
            {compact ? null : <TaskHeader file={file} files={files} onSelect={onSelect} />}
            {feed.items.length ? (
              <>
                {visibleItems.map((item, idx) => (
                  <FeedItem key={idx + feed.items.length - visibleItems.length} item={item} />
                ))}
                {file.activity === "live" ? <WorkingRow label={workingLabel} /> : null}
                {file.activity === "recent" && !isAuxTask(file) ? (
                  <div className="mt-2 text-[11.5px] font-semibold text-[#b8860b]">закінчив хід — чекає відповіді</div>
                ) : null}
              </>
            ) : (
              <div className="mt-[14vh] text-center text-dim">
                {tail.loading
                  ? "Завантаження…"
                  : tail.size === 0
                    ? "Ще без виводу — файл поки порожній"
                    : feed.hiddenServiceCount
                      ? `Видимих повідомлень нема — лише службові записи (${feed.hiddenServiceCount}). Натисни «Службові»`
                      : "Порожньо (немає рядків для показу)"}
                {!tail.loading && (file.cmdDesc || file.cmd) ? (
                  <div className="mx-auto mt-3 max-w-[560px]">
                    {file.cmdDesc ? <div className="text-[12.5px] font-semibold text-ink">{file.cmdDesc}</div> : null}
                    {file.cmd ? (
                      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-bg px-3 py-2 text-left font-mono text-[11.5px] text-ink">
                        {file.cmd}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
