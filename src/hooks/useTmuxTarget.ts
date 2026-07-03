"use client";

import { useEffect, useState } from "react";

const POLL_MS = 5_000;

/**
 * Polls /api/tmux for the tmux pane that `pid` runs in. Returns the
 * `session:window.pane` target string, or null when the process is outside
 * tmux, unknown to the scanner, or no pid was supplied.
 */
export function useTmuxTarget(pid: number | null): string | null {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (pid === null) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/tmux?pid=${pid}`);
        if (!res.ok) return;
        const body = (await res.json()) as { target?: string | null };
        if (alive) setTarget(body.target ?? null);
      } catch {
        /* keep previous target */
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid]);

  return pid === null ? null : target;
}
