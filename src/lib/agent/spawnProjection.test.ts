import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { AgentRegistry } from "./registry";
import { preallocatedStructuredSpawnCards } from "./spawnProjection";

function scannedFile(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "Settled spawn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function observeArtifact(registry: AgentRegistry, artifactPath: string, cwd: string): void {
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T10:00:00.000Z",
  }]);
}

test("a settled artifact stays projected across restart until inventory observes it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-scan-lag-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe0.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "scan lag" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "scan_lag_20260717_a1",
      requestDigest: "c".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe0" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a deleted settled structured transcript stays absent after JSON restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-delete-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe1.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "settled" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "settled_delete_20260717_a1",
      requestDigest: "d".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe1" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    expect(settled.kind).toBe("settled");
    expect(preallocatedStructuredSpawnCards([scannedFile(artifactPath)], registry.snapshot())).toEqual([]);
    observeArtifact(registry, artifactPath, directory);

    fs.unlinkSync(artifactPath);
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });

    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending launch remains visible until inventory materializes its transcript", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-pending-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe2.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "pending_materialize_20260717_a1",
      requestDigest: "e".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe2" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(preallocatedStructuredSpawnCards([], registry.snapshot())).toHaveLength(1);

    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "materialized" })}\n`);
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart preserves materialized transcript deletion and pending launch visibility", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-sqlite-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe3.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "sqlite" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const settled = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_delete_20260717_a1",
      requestDigest: "f".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    const pending = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_pending_20260717_a1",
      requestDigest: "a".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (settled.kind !== "created" || pending.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(settled.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe3" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const cards = preallocatedStructuredSpawnCards([], restarted.snapshot());

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      path: `spawn:${pending.receipt.launchId}`,
      spawn: { state: "starting", initialMessage: "pending" },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inventory materialization stays scoped to the observed engine", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-engine-scope-"));
  const artifactPath = path.join(directory, "shared.jsonl");
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const codex = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_codex_20260717_a1",
      requestDigest: "1".repeat(64),
    });
    const claude = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_claude_20260717_a1",
      requestDigest: "2".repeat(64),
    });
    if (codex.kind !== "created" || claude.kind !== "created") throw new Error("expected structured launch creation");

    observeArtifact(registry, artifactPath, directory);
    const snapshot = registry.snapshot();

    expect(snapshot.receipts[codex.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    expect(snapshot.receipts[claude.receipt.launchId]?.artifactLifecycle).toBe("pending");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
