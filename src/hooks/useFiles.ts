"use client";

import { useEffect, useState } from "react";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, FilesResponse } from "@/lib/types";

const POLL_MS = 10_000;

export interface FilesData {
  files: FileEntry[];
  flows: Flow[];
  tasks: BoardTask[];
}

const EMPTY: FilesData = { files: [], flows: [], tasks: [] };

/** Polls /api/files. Keeps the last good list on transient fetch errors. */
export function useFiles(): FilesData {
  const [data, setData] = useState<FilesData>(EMPTY);
  useEffect(() => {
    let alive = true;
    let lastBody = "";
    const load = async () => {
      try {
        const res = await fetch("/api/files");
        const body = await res.text();
        if (!alive || body === lastBody) return;
        lastBody = body;
        const parsed = JSON.parse(body) as FilesResponse | FileEntry[];
        /* The flows rollout changes the payload from a bare array to
           {files, flows}; accept both so client and server can deploy in
           either order. */
        if (Array.isArray(parsed)) setData({ files: parsed, flows: [], tasks: [] });
        else setData({ files: parsed.files ?? [], flows: parsed.flows ?? [], tasks: parsed.tasks ?? [] });
      } catch {
        /* keep previous list */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    /* Flow and task mutations refresh out of band: the strip and the cards
       must not sit on stale state for up to a full poll interval. */
    const onChanged = () => void load();
    window.addEventListener(FLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
    };
  }, []);
  return data;
}
