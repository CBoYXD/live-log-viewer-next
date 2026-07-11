import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

/** Longest custom title we store; the derived title uses the same 120 cap. */
export const MAX_CUSTOM_TITLE = 120;
/** Bounded store — the oldest overrides are evicted past this many keys, so a
    machine that renames thousands of sessions never grows the file without a
    ceiling. Chosen well above any plausible working set. */
export const MAX_TITLE_OVERRIDES = 2_000;

/** Resolve on every call, never bake at module load: a test that pins
    LLV_STATE_DIR after this module first imports must still redirect writes to
    its sandbox (see flows/store.ts for the same reasoning). */
const titlesFile = () => statePath("session-titles.json");

/** One durable rename. `key` is the stable identity the title is filed under
    (see {@link titleKeysForEntry}); `revision` bumps on every set/clear so a
    stale editor's write is rejected instead of silently clobbering. */
export interface SessionTitleOverride {
  key: string;
  title: string;
  revision: number;
  updatedAt: string;
}

type TitlesFile = { version?: unknown; titles?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isOverride(value: unknown): value is SessionTitleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SessionTitleOverride>;
  return (
    typeof record.key === "string" &&
    record.key.length > 0 &&
    typeof record.title === "string" &&
    record.title.length > 0 &&
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    record.revision > 0 &&
    typeof record.updatedAt === "string"
  );
}

export function loadSessionTitles(filePath = titlesFile()): SessionTitleOverride[] {
  const raw = readJson(filePath) as TitlesFile | null;
  return Array.isArray(raw?.titles) ? raw.titles.filter(isOverride) : [];
}

export function saveSessionTitles(overrides: SessionTitleOverride[], filePath = titlesFile()): void {
  atomicWriteJson(filePath, { version: 1, titles: overrides });
}

/** Sanitize + bound a user title. Returns null when it collapses to empty (an
    empty title is a clear, never a blank card). */
export function sanitizeCustomTitle(value: string): string | null {
  const cleaned = cleanTitle(value, MAX_CUSTOM_TITLE);
  return cleaned.length > 0 ? cleaned : null;
}

/** Candidate keys for an entry, most-stable first: the Viewer conversation
    identity owns the title when present (so account/compaction successors adopt
    it through the registry), the session UUID is the compatibility key that
    survives archive/revive/move, and the transcript path is the bounded
    fallback for a session the registry never named. */
export function titleKeysForEntry(entry: Pick<FileEntry, "engine" | "path" | "conversationId">): string[] {
  const keys: string[] = [];
  if (entry.conversationId?.startsWith("conversation_")) keys.push(`conversation:${entry.conversationId}`);
  if (entry.engine === "claude" || entry.engine === "codex") {
    const sessionKey = sessionKeyFromTranscript(entry.engine, entry.path);
    if (sessionKey) keys.push(`uuid:${sessionKeyId(sessionKey)}`);
  }
  keys.push(`path:${entry.path}`);
  return keys;
}

/** The single key a fresh rename is filed under — the most stable available. */
export function preferredTitleKey(entry: Pick<FileEntry, "engine" | "path" | "conversationId">): string {
  return titleKeysForEntry(entry)[0]!;
}

/** Index overrides by key for O(1) overlay lookups. */
export function indexSessionTitles(overrides: SessionTitleOverride[]): Map<string, SessionTitleOverride> {
  return new Map(overrides.map((override) => [override.key, override]));
}

/** The override that owns an entry's title, checked most-stable key first. */
export function overrideForEntry(
  entry: Pick<FileEntry, "engine" | "path" | "conversationId">,
  index: Map<string, SessionTitleOverride>,
): SessionTitleOverride | null {
  for (const key of titleKeysForEntry(entry)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

/** Overlay a custom title onto a scanned entry: `title` becomes the override,
    the derived title moves to `autoTitle` as provenance, and `titleRevision`
    carries the concurrency token consumers echo back on the next PATCH. */
export function applyTitleOverride(entry: FileEntry, index: Map<string, SessionTitleOverride>): void {
  const override = overrideForEntry(entry, index);
  if (!override) return;
  if (override.title === entry.title) {
    // Custom title matches the derived one: still surface the token so the
    // editor can clear it, but there is no distinct auto title to preserve.
    entry.titleRevision = override.revision;
    return;
  }
  entry.autoTitle = entry.title;
  entry.title = override.title;
  entry.titleRevision = override.revision;
}

/**
 * Serialized read-modify-write over the titles file — the only sanctioned way
 * to persist a rename. The whole load→transform→save runs synchronously so a
 * handler can never save a snapshot that predates another handler's write
 * (mirrors {@link import("@/lib/tasks/store").mutateTasks}).
 */
export function mutateSessionTitles<R>(
  mutate: (overrides: SessionTitleOverride[]) => { overrides: SessionTitleOverride[] | undefined; result: R },
  filePath = titlesFile(),
): R {
  const outcome = mutate(loadSessionTitles(filePath));
  if (outcome.overrides) saveSessionTitles(capOverrides(outcome.overrides), filePath);
  return outcome.result;
}

/** Keep the store bounded — evict the least-recently-updated overrides once the
    key count exceeds the cap. */
function capOverrides(overrides: SessionTitleOverride[]): SessionTitleOverride[] {
  if (overrides.length <= MAX_TITLE_OVERRIDES) return overrides;
  return [...overrides]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_TITLE_OVERRIDES);
}

export type SetTitleOutcome =
  | { ok: true; override: SessionTitleOverride | null }
  | { ok: false; conflict: SessionTitleOverride | null };

/**
 * Set (non-empty) or clear (null) the override at `key`. When `baseRevision` is
 * supplied it must match the current record's revision, else the write is
 * rejected as a conflict carrying the current server state. A clear removes the
 * record; a set bumps the revision. Returns the effective record (null once
 * cleared).
 */
export function writeSessionTitle(
  key: string,
  title: string | null,
  baseRevision: number | undefined,
  now: string,
  filePath = titlesFile(),
): SetTitleOutcome {
  return mutateSessionTitles<SetTitleOutcome>((overrides) => {
    const index = overrides.findIndex((override) => override.key === key);
    const current = index >= 0 ? overrides[index]! : null;
    if (baseRevision !== undefined && baseRevision !== (current?.revision ?? 0)) {
      return { overrides: undefined, result: { ok: false, conflict: current } };
    }
    const sanitized = title === null ? null : sanitizeCustomTitle(title);
    if (sanitized === null) {
      if (!current) return { overrides: undefined, result: { ok: true, override: null } };
      const next = overrides.filter((_, position) => position !== index);
      return { overrides: next, result: { ok: true, override: null } };
    }
    const record: SessionTitleOverride = {
      key,
      title: sanitized,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now,
    };
    const next = current ? overrides.map((override, position) => (position === index ? record : override)) : [...overrides, record];
    return { overrides: next, result: { ok: true, override: record } };
  }, filePath);
}
