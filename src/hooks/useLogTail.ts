"use client";

/* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState } from "react";

import { getLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { LogChunk } from "@/lib/types";

import { subscribeLog } from "./logBus";

/** Longest single jsonl line we are willing to chase across history chunks. */
const OLDER_CHUNK_HOPS = 4;

const utf8len = (text: string) => new TextEncoder().encode(text).length;

export interface LogTailState {
  lines: string[];
  /** Absolute index of `lines[0]` in the tail stream: grows as the cap trims
      the front, goes negative when history is prepended. Feed sessions use it
      to parse only lines they have not seen. */
  linesStart: number;
  size: number;
  loading: boolean;
  error: string | null;
  tickTime: Date | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clear: () => void;
  /** Bytes of history exist before the loaded window. */
  hasMore: boolean;
  loadingOlder: boolean;
  /** Prepend one older chunk of complete lines; resolves to the line count added. */
  loadOlder: () => Promise<number>;
  /** Increments on every prepend, for scroll anchoring. */
  prependGen: number;
}

/**
 * Forward tail polling plus on-demand backward history: `lines` always hold a
 * contiguous window ending at the live tail; `loadOlder` extends the window
 * toward the file start one chunk at a time. `cap` trims old lines on append
 * (dashboard columns); 0 keeps everything. The value may change between
 * renders — the caller drops the cap while the reader scrolled up, so
 * trimming never shifts what is being read.
 */
export function useLogTail(file: FileEntry | null, pausedInput = false, cap = 2500): LogTailState {
  const capRef = useRef(cap);
  /* One atomic window state: the lines plus the absolute index of lines[0],
     updated together so a trim and its start shift can never tear. */
  const [win, setWin] = useState<{ lines: string[]; start: number }>({ lines: [], start: 0 });
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickTime, setTickTime] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prependGen, setPrependGen] = useState(0);
  const offsetRef = useRef(0);
  const startRef = useRef(0);
  const tailRef = useRef("");
  const firstRef = useRef(true);
  const genRef = useRef(0);
  const olderBusyRef = useRef(false);

  useEffect(() => {
    capRef.current = cap;
  }, [cap]);

  const resetWindow = () => {
    offsetRef.current = 0;
    startRef.current = 0;
    tailRef.current = "";
    firstRef.current = true;
    setHasMore(false);
  };

  const clear = useCallback(() => {
    setWin({ lines: [], start: 0 });
    resetWindow();
  }, []);

  useEffect(() => {
    genRef.current += 1;
    resetWindow();
    setWin({ lines: [], start: 0 });
    setSize(file?.size ?? 0);
    setError(null);
    setLoading(Boolean(file));
  }, [file?.path]);

  /* Forward polling rides the shared log bus: one batched request per tick
     for every mounted pane. A paused pane unsubscribes entirely — the server
     must not keep re-reading bytes nobody consumes — and resuming triggers
     the bus's immediate tick, so catch-up beats the old fixed interval. */
  useEffect(() => {
    if (!file || paused || pausedInput) return;
    let alive = true;
    const gen = genRef.current;
    const unsubscribe = subscribeLog({
      path: file.path,
      getOffset: () => offsetRef.current,
      onChunk: (result) => {
        if (!alive || gen !== genRef.current) return;
        if ("transportError" in result) {
          setError(translate(getLocale(), "common.serverUnavailable"));
          setLoading(false);
          return;
        }
        if ("error" in result && result.error) {
          setError(result.error);
          setLoading(false);
          return;
        }
        const chunk = result as LogChunk;
        if (offsetRef.current > chunk.size) {
          resetWindow();
          setWin({ lines: [], start: 0 });
        }
        if (chunk.data) {
          let data = tailRef.current + chunk.data;
          tailRef.current = "";
          if (firstRef.current) {
            startRef.current = chunk.start;
            if (chunk.start > 0) {
              const nl = data.indexOf("\n");
              startRef.current = chunk.start + (nl >= 0 ? utf8len(data.slice(0, nl + 1)) : utf8len(data));
              data = nl >= 0 ? data.slice(nl + 1) : "";
            }
            setHasMore(startRef.current > 0);
          }
          const parts = data.split("\n");
          tailRef.current = parts.pop() ?? "";
          const complete = parts.map((line) => line.trim()).filter(Boolean);
          if (offsetRef.current === 0) setWin({ lines: complete, start: 0 });
          else if (complete.length)
            setWin((prev) => {
              const merged = prev.lines.concat(complete);
              const capNow = capRef.current;
              if (capNow > 0 && merged.length > capNow) {
                return { lines: merged.slice(-capNow), start: prev.start + (merged.length - capNow) };
              }
              return { lines: merged, start: prev.start };
            });
          firstRef.current = false;
        }
        offsetRef.current = chunk.offset;
        setSize(chunk.size);
        setError(null);
        /* Idle polls must not re-render every pane every 1.2s: the tick time
           moves only when bytes actually arrived (status reads "last data"). */
        if (chunk.data) setTickTime(new Date());
        setLoading(false);
      },
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [file?.path, paused, pausedInput]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!file || olderBusyRef.current || startRef.current <= 0) return 0;
    olderBusyRef.current = true;
    setLoadingOlder(true);
    const gen = genRef.current;
    try {
      let text = "";
      let start = startRef.current;
      // A chunk may end mid-line; hop further back until the first newline shows up.
      for (let hop = 0; hop < OLDER_CHUNK_HOPS; hop += 1) {
        const res = await fetch(`/api/log?path=${encodeURIComponent(file.path)}&before=${start}`);
        const json = (await res.json()) as LogChunk | { error?: string };
        if (gen !== genRef.current) return 0;
        if ("error" in json && json.error) return 0;
        const chunk = json as LogChunk;
        text = chunk.data + text;
        start = chunk.start;
        /* The chunk ends at a known line boundary, so the trailing newline is
           always there; progress needs one that CLOSES a line inside the chunk. */
        if (start === 0 || text.slice(0, -1).includes("\n")) break;
      }
      let newStart = start;
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0 || nl === text.length - 1) return 0;
        newStart = start + utf8len(text.slice(0, nl + 1));
        text = text.slice(nl + 1);
      }
      const parts = text.split("\n");
      if (parts.at(-1) === "") parts.pop();
      const complete = parts.map((line) => line.trim()).filter(Boolean);
      startRef.current = newStart;
      setHasMore(newStart > 0);
      if (complete.length) {
        setWin((prev) => ({ lines: complete.concat(prev.lines), start: prev.start - complete.length }));
        setPrependGen((value) => value + 1);
      }
      return complete.length;
    } catch {
      return 0;
    } finally {
      olderBusyRef.current = false;
      setLoadingOlder(false);
    }
  }, [file?.path]);

  return { lines: win.lines, linesStart: win.start, size, loading, error, tickTime, paused, setPaused, clear, hasMore, loadingOlder, loadOlder, prependGen };
}
