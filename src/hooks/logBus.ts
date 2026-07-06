"use client";

import type { LogTailStreamResult } from "@/lib/logTailStream";
import type { LogChunk } from "@/lib/types";

const POLL_MS = 1200;
const MAX_REQS = 64;
const RECONNECT_DEBOUNCE_MS = 300;
const SSE_RETRY_MS = 60_000;

export type LogBusResult = LogChunk | { error: string } | { transportError: true };

export interface LogSubscriber {
  path: string;
  /** Read at send time, so transport changes continue from the live offset. */
  getOffset(): number;
  onChunk(result: LogBusResult): void;
}

const subs = new Set<LogSubscriber>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let source: EventSource | null = null;
let inFlight = false;
let kickPending = false;
let kickScheduled = false;
let usingFallback = false;
let sseGeneration = 0;
let connectedSubs = new Map<string, LogSubscriber>();

function clearTimer<T extends ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>(timer: T | null, clear: (timer: T) => void): null {
  if (timer) clear(timer);
  return null;
}

function closeSource(): void {
  sseGeneration += 1;
  source?.close();
  source = null;
  connectedSubs = new Map();
}

function stopPolling(): void {
  pollTimer = clearTimer(pollTimer, clearInterval);
}

function stopAllTransports(): void {
  closeSource();
  stopPolling();
  sseRetryTimer = clearTimer(sseRetryTimer, clearTimeout);
  reconnectTimer = clearTimer(reconnectTimer, clearTimeout);
  usingFallback = false;
  inFlight = false;
  kickPending = false;
  kickScheduled = false;
}

async function pollTick(): Promise<void> {
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
      void pollTick();
    }
  }
}

function kickPoll(): void {
  if (kickScheduled) return;
  kickScheduled = true;
  setTimeout(() => {
    kickScheduled = false;
    if (usingFallback) void pollTick();
  }, 0);
}

function startFallback(): void {
  if (subs.size === 0) return;
  closeSource();
  usingFallback = true;
  if (pollTimer === null) pollTimer = setInterval(() => void pollTick(), POLL_MS);
  kickPoll();
  sseRetryTimer = clearTimer(sseRetryTimer, clearTimeout);
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    if (subs.size === 0) return;
    usingFallback = false;
    stopPolling();
    scheduleSseReconnect(0);
  }, SSE_RETRY_MS);
}

function notifyTransportError(): void {
  for (const sub of subs) sub.onChunk({ transportError: true });
}

function deliverStreamChunk(id: string, chunk: LogTailStreamResult): void {
  const sub = connectedSubs.get(id);
  if (!sub || !subs.has(sub)) return;
  sub.onChunk(chunk);
}

function startSse(): void {
  reconnectTimer = clearTimer(reconnectTimer, clearTimeout);
  if (subs.size === 0) return;
  if (typeof EventSource === "undefined" || subs.size > MAX_REQS) {
    startFallback();
    return;
  }

  usingFallback = false;
  stopPolling();
  sseRetryTimer = clearTimer(sseRetryTimer, clearTimeout);
  closeSource();

  const generation = sseGeneration;
  const active = [...subs];
  const reqs = active.map((sub, i) => ({ id: String(i), path: sub.path, offset: sub.getOffset() }));
  connectedSubs = new Map(reqs.map((req, i) => [req.id, active[i]]));
  const url = `/api/logs/stream?subs=${encodeURIComponent(JSON.stringify(reqs))}`;
  const nextSource = new EventSource(url);
  source = nextSource;

  nextSource.addEventListener("chunk", (event) => {
    if (generation !== sseGeneration || nextSource !== source) return;
    let payload: { id?: unknown; chunk?: unknown };
    try {
      payload = JSON.parse((event as MessageEvent<string>).data) as { id?: unknown; chunk?: unknown };
    } catch {
      return;
    }
    if (typeof payload.id !== "string" || !payload.chunk || typeof payload.chunk !== "object") return;
    deliverStreamChunk(payload.id, payload.chunk as LogTailStreamResult);
  });

  nextSource.onerror = () => {
    if (generation !== sseGeneration || nextSource !== source) return;
    notifyTransportError();
    startFallback();
  };
}

function scheduleSseReconnect(delay = RECONNECT_DEBOUNCE_MS): void {
  if (usingFallback) {
    kickPoll();
    return;
  }
  reconnectTimer = clearTimer(reconnectTimer, clearTimeout);
  reconnectTimer = setTimeout(startSse, delay);
}

export function subscribeLog(sub: LogSubscriber): () => void {
  subs.add(sub);
  if (usingFallback) {
    if (pollTimer === null) pollTimer = setInterval(() => void pollTick(), POLL_MS);
    kickPoll();
  } else {
    scheduleSseReconnect();
  }
  return () => {
    subs.delete(sub);
    if (subs.size === 0) {
      stopAllTransports();
      return;
    }
    if (usingFallback) kickPoll();
    else scheduleSseReconnect();
  };
}
