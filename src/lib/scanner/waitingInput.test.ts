import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { waitingInputProbe } from "./waitingInput";

const NOW = new Date(2026, 6, 10, 18, 0, 0).getTime();

function entry(): FileEntry {
  return {
    path: "/sessions/fresh-limit.jsonl",
    root: "codex-sessions",
    name: "fresh-limit.jsonl",
    project: "demo",
    title: "Fresh limit",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: NOW / 1000 - 16,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 42,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("a live usage wall bypasses the stable-screen delay", async () => {
  const result = await waitingInputProbe(entry(), {
    now: () => NOW,
    resolveTarget: async () => "agents:3.0",
    paneScreen: async () => "You've hit your usage limit\nTry again at 7:55 PM.",
  });

  expect(result).toEqual({
    waiting: null,
    rateLimit: {
      source: "pane",
      accountId: null,
      window: null,
      resetAt: new Date(2026, 6, 10, 19, 55, 0).getTime() / 1000,
    },
    atComposer: false,
  });
});
