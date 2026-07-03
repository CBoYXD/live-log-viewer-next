import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RootKey } from "../types";

const HOME = os.homedir();

export const ROOTS: Record<RootKey, string> = {
  "codex-jobs": path.join(HOME, ".claude/plugins/data/codex-openai-codex/state"),
  "codex-sessions": path.join(HOME, ".codex/sessions"),
  "claude-projects": path.join(HOME, ".claude/projects"),
  "claude-tasks": "/tmp/claude-1000",
};

export const EXTS = [".log", ".jsonl", ".output", ".txt"] as const;

export const MAX_CHUNK = 768 * 1024;

/** Max entries returned by /api/files (most recent first). */
export const FILE_CAP = 400;

function realpathSafe(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Security gate for /api/log: the resolved real path must live under one of
 * the whitelisted roots. Mirrors `path_allowed` in the Python prototype.
 */
export function pathAllowed(candidate: string): boolean {
  const real = realpathSafe(candidate);
  if (!real) return false;
  return Object.values(ROOTS).some((root) => {
    const rootReal = realpathSafe(root);
    return rootReal !== null && real.startsWith(rootReal + path.sep);
  });
}
