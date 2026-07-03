export type RootKey =
  | "codex-jobs"
  | "codex-sessions"
  | "claude-projects"
  | "claude-tasks";

export type Engine = "codex" | "claude" | "shell";
export type Activity = "live" | "recent" | "idle";
export type Fmt = "codex" | "claude" | "plain";

/** One sidebar entry returned by GET /api/files. */
export interface FileEntry {
  path: string;
  root: RootKey;
  /** Path relative to its root. */
  name: string;
  project: string;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
  /** Absolute path of the parent node (tree link) or null for roots. */
  parent: string | null;
  /** Unix seconds. */
  mtime: number;
  size: number;
  activity: Activity;
  /** Short model name (fable-5, gpt-5.5, sonnet…) or null when unknown. */
  model: string | null;
  /** claude-tasks only: recovered originating Bash command ("" if not found). */
  cmd?: string;
  /** claude-tasks only: the Bash tool `description` field. */
  cmdDesc?: string;
}

/** Response of GET /api/log. */
export interface LogChunk {
  /** Next offset to poll from. */
  offset: number;
  /** Current file size in bytes. */
  size: number;
  data: string;
}

export interface ApiError {
  error: string;
}
