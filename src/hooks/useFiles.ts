"use client";

import { useEffect, useState } from "react";

import type { FileEntry } from "@/lib/types";

const POLL_MS = 10_000;

/** Polls /api/files. Keeps the last good list on transient fetch errors. */
export function useFiles(): FileEntry[] {
  const [files, setFiles] = useState<FileEntry[]>([]);
  useEffect(() => {
    let alive = true;
    let lastBody = "";
    const load = async () => {
      try {
        const res = await fetch("/api/files");
        const body = await res.text();
        if (!alive || body === lastBody) return;
        lastBody = body;
        setFiles(JSON.parse(body) as FileEntry[]);
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
