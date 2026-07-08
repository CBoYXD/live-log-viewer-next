import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { claimedReviewerDescendantPaths, foldClaimedReviewers } from "./flowModel";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const roleConfig = { engine: "codex" as const, model: null, effort: null };

function flow(overrides: Partial<Flow> & { implementerPath: string; reviewerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    id: "flow-1",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: overrides.reviewerPath,
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt: "2026-07-05T00:00:00Z",
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

describe("reviewer folding", () => {
  test("keeps descendants available for expanded scheme placement", () => {
    const implementer = entry({ path: "/implementer" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer" });
    const subtask = entry({ path: "/subtask", parent: "/reviewer" });
    const sidecar = entry({ path: "/sidecar", parent: "/subtask" });
    const flows = [flow({ implementerPath: "/implementer", reviewerPath: "/reviewer" })];

    expect([...claimedReviewerDescendantPaths([implementer, reviewer, subtask, sidecar], flows)].sort()).toEqual([
      "/sidecar",
      "/subtask",
    ]);
    expect(foldClaimedReviewers([implementer, reviewer, subtask, sidecar], flows).map((file) => [file.path, file.parent])).toEqual([
      ["/implementer", null],
      ["/subtask", "/implementer"],
      ["/sidecar", "/subtask"],
    ]);
  });
});
