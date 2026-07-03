"use client";

import { useEffect, useState } from "react";

import type { FileEntry } from "@/lib/types";

const POLL_MS = 10_000;

/** Polls /api/files. Keeps the last good list on transient fetch errors. */
export function useFiles(): FileEntry[] {
  const [files, setFiles] = useState<FileEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/files");
        const data = (await res.json()) as FileEntry[];
        if (alive) setFiles(data);
      } catch {
        /* keep previous list */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return files;
}
