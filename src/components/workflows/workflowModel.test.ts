import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

import { workflowsForProject } from "./workflowModel";

function wfWith(overrides: Partial<Workflow>): Workflow {
  return {
    id: "wf1",
    name: "demo",
    task: "t",
    project: "",
    repoDir: "/home/latand/.agents/tools/live-log-viewer-workflows",
    worktreeDir: "/home/latand/.agents/tools/live-log-viewer-workflows-wf-wf1",
    branch: "wf/t-wf1",
    baseBranch: "main",
    baseRef: "sha",
    template: { name: "demo", stages: [], finish: "pr" },
    stageRuns: [],
    stageIndex: 0,
    flowId: null,
    fixerPath: null,
    state: "provisioning",
    pausedState: null,
    stateDetail: null,
    mode: "auto",
    setupPid: null,
    srcPath: null,
    prUrl: null,
    createdAt: "t",
    closedAt: null,
    ...overrides,
  };
}

function fileIn(project: string, path: string): FileEntry {
  return { path, project, root: "codex-sessions", name: path, title: "", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 0, size: 0, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null } as FileEntry;
}

test("a provisioning workflow matches through its stamped scanner project key", () => {
  /* The regression shape: a repo outside ~/Projects, whose scanner project
     key keeps the dashed parent dirs, while the repo basename is shorter. */
  const wf = wfWith({ project: "-agents-tools-live-log-viewer-workflows" });
  expect(workflowsForProject([wf], "-agents-tools-live-log-viewer-workflows", []).length).toBe(1);
  expect(workflowsForProject([wf], "live-log-viewer-workflows", []).length).toBe(0);
});

test("a workflow without the stamp still matches through its agents' transcripts", () => {
  const wf = wfWith({
    project: "",
    stageRuns: [{ index: 0, agentPath: "/codex/rollout.jsonl", paneId: "%1", startedAt: "t", doneAt: null, doneNote: null }],
  });
  const files = [fileIn("some-project", "/codex/rollout.jsonl")];
  expect(workflowsForProject([wf], "some-project", files).length).toBe(1);
  expect(workflowsForProject([wf], "other", files).length).toBe(0);
});

test("closed workflows never render a strip", () => {
  const wf = wfWith({ project: "p", state: "closed" });
  expect(workflowsForProject([wf], "p", []).length).toBe(0);
});
