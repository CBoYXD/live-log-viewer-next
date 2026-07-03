"use client";

import type { FileEntry } from "@/lib/types";

/**
 * TODO(codex): poll /api/log every 1.2 s for the selected file.
 * Must port from the prototype:
 *  - generation token so a chunk from a previously selected file is dropped;
 *  - partial-line buffer (tail without trailing \n is carried over);
 *  - first-chunk truncation (drop the first partial line when the read
 *    started mid-file);
 *  - reset on offset===0 (server shrunk/rotated file).
 * Exposes parsed lines to the feed renderers plus size/loading state.
 */
export function useLogTail(_file: FileEntry | null): void {
  // TODO(codex)
}
