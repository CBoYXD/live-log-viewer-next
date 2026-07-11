import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import type { TranscriptHost, TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { killHeadlessReviewerIfMatches, readReaperReport, refreshMergedFlowIds, runReaperCycle } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalEnabled === undefined) delete process.env.LLV_REAPER_ENABLED;
  else process.env.LLV_REAPER_ENABLED = originalEnabled;
});

test("runtime cycle persists an API report in dry-run mode by default", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-runtime-"));
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    const report = await runReaperCycle({ registry, hosts: [], files: [], now: Date.parse("2026-07-12T12:00:00.000Z") });

    expect(report).toMatchObject({ mode: "dry-run", configFlag: "LLV_REAPER_ENABLED", eligibleCount: 0, agents: [] });
    expect(readReaperReport()).toEqual(report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime cycle enters active mode only for the exact opt-in flag", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-active-"));
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "true";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("dry-run");
    process.env.LLV_REAPER_ENABLED = "1";
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("active");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runtimeHost(pathname: string): TranscriptHost {
  return {
    tmuxServerPid: 900,
    paneId: "%41",
    panePid: 1041,
    agentPid: 2041,
    display: "agents:41.0",
    windowName: "worker-41",
    engine: "codex",
    cwd: "/repo",
    agentArgv: ["codex", "resume", pathname],
    agentIdentity: "2041:one",
    launchId: null,
    claimedPaths: [pathname],
    primaryPath: pathname,
  };
}

function runtimeFile(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "worker",
    engine: "codex",
    kind: "conversation",
    fmt: "codex",
    parent: null,
    mtime,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

test("an external one-message session keeps the user-authored exemption", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-external-user-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1341.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Investigate this session" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: null, eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("user-authored-message");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a completed Viewer worker spawn discounts its single launch prompt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-viewer-worker-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1343";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Run the assigned worker task" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a malformed transcript protects an otherwise eligible Viewer probe", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-malformed-authorship-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1346";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, "{broken\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("authorship-unverified");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("authorship at the beginning of a transcript survives a tail larger than the session reader window", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-early-user-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1344.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const user = JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Keep this human session" },
  }) + "\n";
  const assistant = JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 60 * 60_000).toISOString(),
    payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024 + 1024) },
  }) + "\n";
  fs.writeFileSync(pathname, user + assistant);
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 60 * 60_000).toISOString() },
    observedAt: new Date(now - 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: null, eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("user-authored-message");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function headlessFlow(now: number): Flow {
  return {
    id: "flow-headless",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "base",
    baseMode: "merge-base",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 1,
    state: "closed",
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: "/reviewer.jsonl",
      reviewerPid: 4041,
      reviewerIdentity: "4041:one",
      reviewerPane: null,
      findingsPath: "/findings",
      triggeredBy: "marker",
      readyNote: null,
      verdict: "APPROVE",
      findingsCount: 0,
      startedAt: new Date(now - 20 * 60_000).toISOString(),
      spawnStartedAt: new Date(now - 20 * 60_000).toISOString(),
      reviewedAt: new Date(now - 6 * 60_000).toISOString(),
      relayedAt: new Date(now - 5 * 60_000).toISOString(),
      error: null,
    }],
    createdAt: new Date(now - 30 * 60_000).toISOString(),
    closedAt: new Date(now - 5 * 60_000).toISOString(),
  };
}

test("a detached headless reviewer is observed and reaped by verified process identity", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-headless-"));
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  let kills = 0;

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [],
      files: [],
      now,
      actuation: {
        loadFlows: () => [headlessFlow(now)],
        pidAlive: (pid) => pid === 4041,
        processIdentity: (pid) => pid === 4041 ? "4041:one" : null,
        killProcess: async (process) => {
          expect(process).toEqual({ pid: 4041, identity: "4041:one" });
          kills += 1;
          return true;
        },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({
      targetKind: "process",
      paneId: null,
      agentPid: 4041,
      processIdentity: "4041:one",
      class: "headless-reviewer",
      eligible: true,
      action: "reaped",
    });
    expect(kills).toBe(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("headless reviewer termination rejects pid reuse and verifies process exit", async () => {
  let alive = true;
  let identity = "5051:reused";
  let signals = 0;
  const deps = {
    pidAlive: () => alive,
    processIdentity: () => identity,
    signal: () => { signals += 1; alive = false; },
    sleep: async () => {},
    maxVerifyAttempts: 2,
  };

  expect(await killHeadlessReviewerIfMatches({ pid: 5051, identity: "5051:original" }, deps)).toBe(false);
  expect(signals).toBe(0);
  identity = "5051:original";
  expect(await killHeadlessReviewerIfMatches({ pid: 5051, identity: "5051:original" }, deps)).toBe(true);
  expect(signals).toBe(1);
});

test("persisted GitHub merge evidence survives a deleted checkout and allows flow cleanup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-merged-flow-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1345.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, "");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/deleted/worktree", role: "worker" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const flow = {
    ...headlessFlow(now),
    id: "flow-merged",
    cwd: "/deleted/worktree",
    implementerPath: pathname,
    reviewerMode: "pane",
    rounds: [],
    closedAt: new Date(now - 31 * 60_000).toISOString(),
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "agent/issue-31-reaper",
      headSha: "a".repeat(40),
      prNumber: 125,
      mergedAt: new Date(now - 10 * 60_000).toISOString(),
      checkedAt: new Date(now - 10 * 60_000).toISOString(),
      source: "github-pr",
    },
  } as Flow;

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: { loadFlows: () => [flow], now: () => now },
    });

    expect(report.agents[0]).toMatchObject({ class: "flow-worker", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a squash-merged GitHub PR becomes durable evidence before checkout deletion", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const flow = {
    ...headlessFlow(now),
    id: "flow-squash",
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/squashed",
      headSha: "b".repeat(40),
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  let probes = 0;
  let saves = 0;
  const mergedAt = new Date(now - 60_000).toISOString();

  expect(refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: () => { probes += 1; return { number: 321, mergedAt, headRefOid: "b".repeat(40) }; },
    localBranchMerged: () => false,
    saveFlows: () => { saves += 1; },
  })).toEqual(new Set([flow.id]));
  expect(flow.mergeEvidence).toMatchObject({ prNumber: 321, mergedAt, source: "github-pr" });
  expect(probes).toBe(1);
  expect(saves).toBe(1);

  flow.cwd = "/deleted/worktree";
  expect(refreshMergedFlowIds([flow], {
    now: () => now + 60 * 60_000,
    resolveMergeIdentity: () => null,
    probePullRequest: () => { throw new Error("durable evidence should avoid a refresh"); },
    localBranchMerged: () => false,
    saveFlows: () => { saves += 1; },
  })).toEqual(new Set([flow.id]));
  expect(saves).toBe(1);
});

test("a changed checkout SHA clears prior positive merge evidence", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-new-head",
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/reused",
      headSha: oldSha,
      prNumber: 100,
      mergedAt: new Date(now - 60_000).toISOString(),
      checkedAt: new Date(now - 60_000).toISOString(),
      source: "github-pr",
    },
  } satisfies Flow;

  expect(refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => ({ repository: "Latand/live-log-viewer-next", headRef: "feature/reused", headSha: newSha }),
    probePullRequest: () => null,
    localBranchMerged: () => false,
    saveFlows: () => {},
  })).toEqual(new Set());
  expect(flow.mergeEvidence).toMatchObject({
    headSha: newSha,
    prNumber: null,
    mergedAt: null,
    source: null,
  });
});

test("a numbered PR merge with a different head SHA cannot authorize cleanup", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const flow = {
    ...headlessFlow(now),
    id: "flow-pr-head-mismatch",
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/mismatch",
      headSha: "c".repeat(40),
      prNumber: 400,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;

  expect(refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: () => ({ number: 400, mergedAt: new Date(now - 60_000).toISOString(), headRefOid: "d".repeat(40) }),
    localBranchMerged: () => false,
    saveFlows: () => {},
  })).toEqual(new Set());
  expect(flow.mergeEvidence?.mergedAt).toBeNull();
});

test("a delivery completed before reaper actuation fences the stale idle turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-delivery-fence-"));
  const pathname = path.join(directory, "missing-019f4906-3f67-7b72-9fbc-9ec3b5ad1342.jsonl");
  const now = Date.now();
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  fs.writeFileSync(pathname, "");
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  const key = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1342" };
  registry.completeSpawn(receipt.launchId, {
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const conversation = registry.conversationForPath(pathname)!;
  const host = runtimeHost(pathname);
  fs.writeFileSync(path.join(directory, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: { "%41:2041:2041:one": new Date(now - 2 * 60 * 60_000).toISOString() },
  }));
  let observations = 0;
  let kills = 0;
  const snapshot: TranscriptHostSnapshot = {
    hosts: [host],
    observation: "available",
    canonicalFor: (candidate) => candidate === pathname ? host : null,
  };

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [host],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: {
        readHosts: async () => {
          observations += 1;
          if (observations === 1) {
            const held = registry.holdDelivery(conversation.id, "new user turn");
            const started = registry.beginDeliveryAttempt(held.id, held.generationId!)!;
            registry.recordDeliveryOutcome(started.id, "delivered");
          }
          return snapshot;
        },
        kill: async () => { kills += 1; return true; },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: true, action: "kill-failed" });
    expect(observations).toBe(2);
    expect(kills).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
