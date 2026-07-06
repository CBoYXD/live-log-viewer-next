"use client";

import type { LogChunk } from "@/lib/types";

const POLL_MS = 1200;
/** Server-side cap per batch request; larger subscriber sets split into
    sequential slices within one tick. */
const MAX_REQS = 64;

export type LogBusResult = LogChunk | { error: string } | { transportError: true };

export interface LogSubscriber {
  path: string;
  /** Read at send time, so the poll always continues from the live offset. */
  getOffset(): number;
  onChunk(result: LogBusResult): void;
}

/**
 * One multiplexed tail poll for every mounted feed pane: subscribers join and
 * leave (mount/unmount, pause/resume, scroll out of view), and a single
 * POST /api/logs per 1.2 s tick carries all of their forward reads. A new
 * subscriber triggers an immediate coalesced tick, so a pane that just
 * appeared or resumed paints without waiting out the interval.
 */
const subs = new Set<LogSubscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let kickPending = false;
let kickScheduled = false;

async function tick(): Promise<void> {
  if (subs.size === 0) return;
  if (inFlight) {
    kickPending = true;
    return;
  }
  inFlight = true;
  try {
    const batch = [...subs];
    for (let base = 0; base < batch.length; base += MAX_REQS) {
      const slice = batch.slice(base, base + MAX_REQS);
      const reqs = slice.map((sub, i) => ({ id: String(i), path: sub.path, offset: sub.getOffset() }));
      let chunks: Record<string, LogBusResult> = {};
      let transportError = false;
      try {
        const res = await fetch("/api/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reqs }),
        });
        const json = (await res.json()) as { chunks?: Record<string, LogBusResult> };
        chunks = json.chunks ?? {};
      } catch {
        transportError = true;
      }
      for (let i = 0; i < slice.length; i += 1) {
        const sub = slice[i];
        /* Unsubscribed mid-flight (unmount, pause): the chunk is simply
           dropped — offsets only advance inside the subscriber, so nothing
           is lost and the next poll re-reads the same bytes. */
        if (!subs.has(sub)) continue;
        if (transportError) sub.onChunk({ transportError: true });
        else {
          const chunk = chunks[String(i)];
          if (chunk) sub.onChunk(chunk);
        }
      }
    }
  } finally {
    inFlight = false;
    if (kickPending) {
      kickPending = false;
      void tick();
    }
  }
}

/** Coalesces the immediate first read of simultaneously-mounting panes. */
function kick(): void {
  if (kickScheduled) return;
  kickScheduled = true;
  setTimeout(() => {
    kickScheduled = false;
    void tick();
  }, 0);
}

export function subscribeLog(sub: LogSubscriber): () => void {
  subs.add(sub);
  if (timer === null) timer = setInterval(() => void tick(), POLL_MS);
  kick();
  return () => {
    subs.delete(sub);
    if (subs.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
