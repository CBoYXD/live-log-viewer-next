import fs from "node:fs";

import { globalCache } from "./caches";

interface NeedleEntry {
  hits: Record<string, boolean>;
  scanned: Record<string, number>;
}

const needleCache = globalCache<NeedleEntry>("needle");

/**
 * Incremental per-file needle scan: remembers how many bytes of each file were
 * already searched and only scans the appended suffix on later calls. A hit is
 * cached per (needle, file) pair, so different candidate files of the same
 * needle can be checked independently.
 */
export function fileHasNeedle(needle: string, pathname: string): boolean {
  let ent = needleCache.get(needle);
  if (!ent || !ent.hits) {
    ent = { hits: {}, scanned: ent?.scanned ?? {} };
    needleCache.set(needle, ent);
  }
  if (ent.hits[pathname]) return true;
  const nb = Buffer.from(needle);
  const pad = Math.max(0, nb.length - 1);
  let size: number;
  try {
    size = fs.statSync(pathname).size;
  } catch {
    return false;
  }
  const done = ent.scanned[pathname] ?? 0;
  if (size <= done) return false;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const start = Math.max(0, done - pad);
      let pos = start;
      let carry = Buffer.alloc(0);
      let hit = false;
      while (pos < size) {
        const len = Math.min(1 << 20, size - pos);
        const chunk = Buffer.alloc(len);
        const read = fs.readSync(fd, chunk, 0, len, pos);
        if (!read) break;
        const hay = Buffer.concat([carry, chunk.subarray(0, read)]);
        if (hay.includes(nb)) {
          hit = true;
          break;
        }
        carry = pad ? chunk.subarray(Math.max(0, read - pad), read) : Buffer.alloc(0);
        pos += read;
      }
      ent.scanned[pathname] = size;
      if (hit) ent.hits[pathname] = true;
      return hit;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function findNeedle(needle: string, paths: (string | null | undefined)[]): string | null {
  for (const pathname of paths) {
    if (pathname && fileHasNeedle(needle, pathname)) return pathname;
  }
  return null;
}
