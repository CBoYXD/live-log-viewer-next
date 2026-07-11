import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import {
  applyTitleOverride,
  indexSessionTitles,
  loadSessionTitles,
  MAX_TITLE_OVERRIDES,
  overrideForEntry,
  preferredTitleKey,
  sanitizeCustomTitle,
  saveSessionTitles,
  titleKeysForEntry,
  writeSessionTitle,
  type SessionTitleOverride,
} from "./titleStore";

let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-titles-"));
  file = path.join(dir, "session-titles.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const UUID = "11111111-2222-4333-8444-555555555555";
const claudePath = `/home/u/.claude/projects/proj/${UUID}.jsonl`;
const codexPath = `/home/u/.codex/sessions/2026/07/12/rollout-2026-07-12T00-00-00-${UUID}.jsonl`;

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: claudePath,
    root: "claude-projects",
    name: "x",
    project: "proj",
    title: "Auto derived title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 0,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

test("key precedence: conversation id wins, then session uuid, then path", () => {
  expect(titleKeysForEntry(entry({ conversationId: "conversation_abc" }))).toEqual([
    "conversation:conversation_abc",
    `uuid:claude:${UUID}`,
    `path:${claudePath}`,
  ]);
  expect(preferredTitleKey(entry({ conversationId: "conversation_abc" }))).toBe("conversation:conversation_abc");
  // No conversation id: the UUID becomes the preferred key.
  expect(preferredTitleKey(entry())).toBe(`uuid:claude:${UUID}`);
  // Codex sessions are keyed identically by their rollout UUID.
  expect(preferredTitleKey(entry({ engine: "codex", root: "codex-sessions", path: codexPath }))).toBe(`uuid:codex:${UUID}`);
});

test("path fallback when the filename carries no uuid", () => {
  const noUuid = entry({ path: "/home/u/.claude/projects/proj/not-a-uuid.jsonl" });
  expect(preferredTitleKey(noUuid)).toBe("path:/home/u/.claude/projects/proj/not-a-uuid.jsonl");
});

test("sanitize caps length, strips markdown, and treats blank as a clear", () => {
  expect(sanitizeCustomTitle("  **Bold** `code`  ")).toBe("Bold code");
  expect(sanitizeCustomTitle("   ")).toBeNull();
  expect(sanitizeCustomTitle("x".repeat(400))!.length).toBeLessThanOrEqual(120);
});

test("set then clear round-trips and survives reload (persistence)", () => {
  const key = preferredTitleKey(entry());
  const set = writeSessionTitle(key, "My name", undefined, "2026-07-12T00:00:00.000Z", file);
  expect(set).toEqual({ ok: true, override: { key, title: "My name", revision: 1, updatedAt: "2026-07-12T00:00:00.000Z" } });

  // A fresh load from disk sees the override — the label survives a restart.
  const reloaded = loadSessionTitles(file);
  expect(reloaded).toHaveLength(1);
  expect(reloaded[0]!.title).toBe("My name");

  const cleared = writeSessionTitle(key, null, undefined, "2026-07-12T00:01:00.000Z", file);
  expect(cleared).toEqual({ ok: true, override: null });
  expect(loadSessionTitles(file)).toHaveLength(0);
});

test("revision increments on each set and empty save clears", () => {
  const key = preferredTitleKey(entry());
  expect(writeSessionTitle(key, "one", undefined, "t1", file)).toMatchObject({ ok: true, override: { revision: 1 } });
  expect(writeSessionTitle(key, "two", undefined, "t2", file)).toMatchObject({ ok: true, override: { revision: 2, title: "two" } });
  // Empty string is a clear, not a blank card.
  expect(writeSessionTitle(key, "   ", undefined, "t3", file)).toEqual({ ok: true, override: null });
});

test("base revision mismatch is a conflict carrying current server state", () => {
  const key = preferredTitleKey(entry());
  writeSessionTitle(key, "one", undefined, "t1", file);
  const conflict = writeSessionTitle(key, "two", 0, "t2", file);
  expect(conflict).toEqual({ ok: false, conflict: { key, title: "one", revision: 1, updatedAt: "t1" } });
  // The store was not mutated by the rejected write.
  expect(loadSessionTitles(file)[0]!.title).toBe("one");
  // Retrying against the current revision succeeds.
  expect(writeSessionTitle(key, "two", 1, "t3", file)).toMatchObject({ ok: true, override: { title: "two", revision: 2 } });
});

test("overlay applies the override and preserves the derived title as autoTitle", () => {
  const key = preferredTitleKey(entry());
  writeSessionTitle(key, "Human name", undefined, "t1", file);
  const index = indexSessionTitles(loadSessionTitles(file));
  const file0 = entry();
  applyTitleOverride(file0, index);
  expect(file0.title).toBe("Human name");
  expect(file0.autoTitle).toBe("Auto derived title");
  expect(file0.titleRevision).toBe(1);
});

test("override filed under the UUID adopts onto a later entry that gained a conversation id", () => {
  // Filed while only the UUID was known.
  const uuidKey = `uuid:claude:${UUID}`;
  writeSessionTitle(uuidKey, "Sticky", undefined, "t1", file);
  const index = indexSessionTitles(loadSessionTitles(file));
  // A conversation id later appears; the same session still resolves the title
  // via its UUID candidate key.
  const withId = entry({ conversationId: "conversation_new" });
  const hit = overrideForEntry(withId, index);
  expect(hit?.title).toBe("Sticky");
});

test("no override leaves the entry untouched", () => {
  const index = indexSessionTitles([]);
  const file0 = entry();
  applyTitleOverride(file0, index);
  expect(file0.title).toBe("Auto derived title");
  expect(file0.autoTitle).toBeUndefined();
  expect(file0.titleRevision).toBeUndefined();
});

test("store is capped to the newest overrides", () => {
  const overrides: SessionTitleOverride[] = Array.from({ length: MAX_TITLE_OVERRIDES + 5 }, (_unused, index) => ({
    key: `path:/s/${index}`,
    title: `t${index}`,
    revision: 1,
    updatedAt: `2026-07-12T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(4, "0")}Z`,
  }));
  saveSessionTitles(overrides, file);
  // Trigger the cap via a mutating write.
  writeSessionTitle("path:/s/new", "fresh", undefined, "2027-01-01T00:00:00.000Z", file);
  const stored = loadSessionTitles(file);
  expect(stored.length).toBeLessThanOrEqual(MAX_TITLE_OVERRIDES);
  expect(stored.some((override) => override.title === "fresh")).toBe(true);
});
