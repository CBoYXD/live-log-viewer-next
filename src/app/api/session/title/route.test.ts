import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { loadSessionTitles } from "@/lib/session/titleStore";
import type { TitleTarget, TitleTargetInput } from "@/lib/session/titleTarget";

const UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_PATH = `/home/u/.claude/projects/proj/${UUID}.jsonl`;

/* Session resolution and tmux propagation live behind @/lib/session/titleTarget
   so this route test can stub them without importing @/lib/scanner/roots or
   @/lib/tmux — modules that sibling suites replace through bun's shared module
   registry. `target` drives what resolveTitleTarget returns; `renamed` records
   propagation calls. */
let target: TitleTarget | null = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner" };
let renamed: { pid: number; name: string }[] = [];

mock.module("@/lib/session/titleTarget", () => ({
  resolveTitleTarget: (input: TitleTargetInput) => {
    // Model the real gate closely enough for validation tests.
    if (typeof input.conversationId === "string" && !input.conversationId.startsWith("conversation_")) return null;
    if (input.conversationId === "conversation_missing") return null;
    if (typeof input.path === "string" && input.path === "/etc/passwd") return null;
    return target;
  },
  propagateTitleToWindow: async (pid: number, name: string) => {
    renamed.push({ pid, name });
  },
}));

const { PATCH } = await import("./route");

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-title-state-"));
  process.env.LLV_STATE_DIR = stateDir;
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner" };
  renamed = [];
});

afterEach(() => {
  delete process.env.LLV_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function patch(body: unknown): Promise<Response> {
  return PATCH(new NextRequest("http://127.0.0.1/api/session/title", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("sets a custom title keyed by the stable conversation identity and persists it", async () => {
  const res = await patch({ conversationId: "conversation_owner", title: "My name" });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; override: { key: string; title: string; revision: number } };
  expect(json.ok).toBe(true);
  expect(json.override.key).toBe("conversation:conversation_owner");
  expect(json.override.title).toBe("My name");
  expect(json.override.revision).toBe(1);
  expect(loadSessionTitles()).toHaveLength(1);
});

test("falls back to the session UUID key when the registry does not own the session", async () => {
  target = { engine: "claude", path: SESSION_PATH };
  const res = await patch({ path: SESSION_PATH, title: "Named" });
  const json = (await res.json()) as { override: { key: string } };
  expect(json.override.key).toBe(`uuid:claude:${UUID}`);
});

test("empty title clears the override", async () => {
  await patch({ conversationId: "conversation_owner", title: "temp" });
  const res = await patch({ conversationId: "conversation_owner", title: "", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; override: null };
  expect(json.override).toBeNull();
  expect(loadSessionTitles()).toHaveLength(0);
});

test("revision conflict returns a structured 409 with current server state", async () => {
  await patch({ conversationId: "conversation_owner", title: "first" });
  const res = await patch({ conversationId: "conversation_owner", title: "second", baseRevision: 0 });
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: string; conflict: { title: string; revision: number } };
  expect(json.error).toBe("revision conflict");
  expect(json.conflict.title).toBe("first");
  expect(json.conflict.revision).toBe(1);
});

test("retrying against the current revision after a conflict succeeds", async () => {
  await patch({ conversationId: "conversation_owner", title: "first" });
  const res = await patch({ conversationId: "conversation_owner", title: "second", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { override: { title: string; revision: number } };
  expect(json.override.title).toBe("second");
  expect(json.override.revision).toBe(2);
});

test("propagates the title to the tmux window when a live pid is supplied", async () => {
  await patch({ conversationId: "conversation_owner", title: "Shipping fix", pid: 4242, windowName: "Shipping fix" });
  expect(renamed).toEqual([{ pid: 4242, name: "Shipping fix" }]);
});

test("does not attempt a window rename without a pid", async () => {
  await patch({ conversationId: "conversation_owner", title: "No pane" });
  expect(renamed).toHaveLength(0);
});

test("rejects an unknown conversation id", async () => {
  const res = await patch({ conversationId: "conversation_missing", title: "x" });
  expect(res.status).toBe(400);
});

test("rejects a disallowed session path", async () => {
  const res = await patch({ path: "/etc/passwd", title: "x" });
  expect(res.status).toBe(400);
});

test("rejects a non-string, non-null title before resolving the session", async () => {
  const res = await patch({ conversationId: "conversation_owner", title: 42 });
  expect(res.status).toBe(400);
});
