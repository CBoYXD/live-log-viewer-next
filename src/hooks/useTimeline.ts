"use client";

import { useEffect, useState } from "react";

import type { ActionEvent } from "@/lib/types";

const POLL_MS = 7000;

/** Polls recent project actions while the timeline view is open. */
export function useTimeline(project: string, enabled: boolean): { events: ActionEvent[]; loading: boolean } {
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !project) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const poll = async () => {
      try {
        const res = await fetch(`/api/timeline?project=${encodeURIComponent(project)}`);
        const json = (await res.json()) as { events?: ActionEvent[] };
        if (alive && Array.isArray(json.events)) setEvents(json.events);
      } catch {
        /* keep the previous events on transient errors */
      } finally {
        if (alive) setLoading(false);
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [project, enabled]);

  return { events, loading };
}
