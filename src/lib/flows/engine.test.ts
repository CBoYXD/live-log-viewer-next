import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-engine-test-"));
const { newRound, tickFlows } = await import("./engine");
const { loadFlows, saveFlows } = await import("./store");

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

function entryFor(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "agent",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime,
    size: fs.statSync(pathname).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function writeCodexEntry(name: string, payload: Record<string, unknown>, mtime: number): FileEntry {
  const pathname = path.join(process.env.LLV_STATE_DIR!, "flow-codex-fixtures", name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return entryFor(pathname, mtime);
}

test("a review round captures only a clean commit SHA", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-reviewed-head-"));
  try {
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "flow@example.test"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Flow Test"], { cwd: directory }).status).toBe(0);
    fs.writeFileSync(path.join(directory, "work.txt"), "committed\n");
    expect(spawnSync("git", ["add", "work.txt"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "reviewed"], { cwd: directory }).status).toBe(0);
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    const flow = { cwd: directory, rounds: [] } as unknown as Flow;

    expect(newRound(flow, "marker", null).reviewHeadSha).toBe(headSha);
    fs.writeFileSync(path.join(directory, "work.txt"), "uncommitted\n");
    expect(newRound(flow, "marker", null).reviewHeadSha).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review-flow heuristic claim skips a newer native Codex subagent", async () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const started = Date.parse(startedAt) / 1000;
  const cwd = "/repo";
  const implementerId = "019f421e-02e1-73e0-9b77-bebde063f10c";
  const rootId = "019f421e-02e1-73e0-9b77-bebde063f10a";
  const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
  const implementer = writeCodexEntry(`rollout-implementer-${implementerId}.jsonl`, { id: implementerId, cwd }, started - 100);
  const root = writeCodexEntry(`rollout-root-${rootId}.jsonl`, { id: rootId, cwd }, started + 5);
  const nativeChild = writeCodexEntry(
    `rollout-child-${childId}.jsonl`,
    {
      id: childId,
      parent_thread_id: rootId,
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
    },
    started + 10,
  );
  const flow: Flow = {
    id: "flow-test",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: null,
        sessionId: null,
        reviewerPid: null,
        reviewerPane: { paneId: "%2", windowName: "codex-new" },
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt,
        spawnStartedAt: startedAt,
        relayStartedAt: null,
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer, nativeChild, root]);
  const after = loadFlows()[0]!;

  expect(after.rounds[0]!.reviewerPath).toBe(root.path);
});
