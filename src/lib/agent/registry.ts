import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import type { AutoBalancePolicy, ConversationMigration, HeldDelivery, MigrationIntent, MigrationOrigin, NativeGeneration, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { AgentEngine } from "./cli";
import { sessionKeyId, type SessionKey } from "./sessionKey";
import type { ResumePaneRecord } from "@/lib/resumePanesFile";

export type AgentHostStatus = "starting" | "live" | "idle" | "handoff" | "unhosted" | "dead";

export interface ProcessIdentity {
  pid: number;
  startIdentity: string | null;
}

export interface TmuxHostEvidence {
  kind: "tmux";
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  windowName: string;
  agent: ProcessIdentity;
  argv: string[];
}

export interface AgentRegistryEntry {
  key: SessionKey;
  artifactPath: string;
  cwd: string;
  accountId: string | null;
  status: AgentHostStatus;
  host: TmuxHostEvidence | null;
  claimEpoch: number;
  claimOwner: string | null;
  pendingAction: "spawn" | "resume" | "handoff" | null;
  updatedAt: string;
}

export interface SpawnReceipt {
  launchId: string;
  engine: AgentEngine;
  cwd: string;
  createdAt: string;
  state: "starting" | "completed" | "failed";
  artifactPath: string | null;
  error: string | null;
}

export interface RegistryConversation {
  id: ViewerConversationId;
  engine: Extract<AgentEngine, "claude" | "codex">;
  generations: NativeGeneration[];
  migration: ConversationMigration | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFile {
  version: 2;
  entries: Record<string, AgentRegistryEntry>;
  receipts: Record<string, SpawnReceipt>;
  importedResumePanes: boolean;
  /** Compatibility evidence only. It never authorizes a pane until the live
      resolver proves server, process, engine, and transcript ownership. */
  legacyResumePanes: { serverPid: number | null; panes: Record<string, ResumePaneRecord> };
  conversations: Record<string, RegistryConversation>;
  migrationIntents: Record<string, MigrationIntent>;
  engineRouting: Record<Extract<AgentEngine, "claude" | "codex">, { activeAccountId: string | null; revision: number }>;
  autoBalance: Record<Extract<AgentEngine, "claude" | "codex">, AutoBalancePolicy>;
  heldDeliveries: Record<string, HeldDelivery>;
}

function emptyPolicy(): AutoBalancePolicy {
  return { enabled: false, revision: 0, cooldownUntil: null, departed: {}, lastOutcome: null, lastTrigger: null, restartedAt: now() };
}

const EMPTY: RegistryFile = { version: 2, entries: {}, receipts: {}, importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} }, conversations: {}, migrationIntents: {}, engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } }, autoBalance: { claude: emptyPolicy(), codex: emptyPolicy() }, heldDeliveries: {} };

export class RegistryReadError extends Error {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function upgradeV1(parsed: Omit<Partial<RegistryFile>, "version">): RegistryFile {
  const legacy = parsed.legacyResumePanes;
  return {
    ...clone(EMPTY),
    entries: (parsed.entries as RegistryFile["entries"]) ?? {},
    receipts: (parsed.receipts as RegistryFile["receipts"]) ?? {},
    importedResumePanes: parsed.importedResumePanes === true,
    legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
      ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
      : { serverPid: null, panes: {} },
  };
}

function readFile(filename: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Omit<Partial<RegistryFile>, "version"> & { version?: unknown };
    if (parsed.version === 1 && parsed.entries && parsed.receipts && typeof parsed.entries === "object" && typeof parsed.receipts === "object") {
      return upgradeV1(parsed);
    }
    if (parsed.version !== 2 || !parsed.entries || !parsed.receipts || typeof parsed.entries !== "object" || typeof parsed.receipts !== "object") {
      throw new RegistryReadError("agent registry schema is unsupported");
    }
    const legacy = parsed.legacyResumePanes;
    return {
      version: 2,
      entries: parsed.entries,
      receipts: parsed.receipts,
      importedResumePanes: parsed.importedResumePanes === true,
      legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
        ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
        : { serverPid: null, panes: {} },
      conversations: parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {},
      migrationIntents: parsed.migrationIntents && typeof parsed.migrationIntents === "object" ? parsed.migrationIntents : {},
      engineRouting: parsed.engineRouting && typeof parsed.engineRouting === "object" ? { ...EMPTY.engineRouting, ...parsed.engineRouting } : clone(EMPTY.engineRouting),
      autoBalance: parsed.autoBalance && typeof parsed.autoBalance === "object" ? { ...EMPTY.autoBalance, ...parsed.autoBalance } : { claude: emptyPolicy(), codex: emptyPolicy() },
      heldDeliveries: parsed.heldDeliveries && typeof parsed.heldDeliveries === "object" ? parsed.heldDeliveries : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY);
    if (error instanceof RegistryReadError) throw error;
    throw new RegistryReadError(`agent registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeAtomic(filename: string, value: RegistryFile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filename);
    const dir = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename completed */ }
  }
}

/** Durable source for identity and handoff evidence. The lock directory is
    intentionally separate from in-memory promises, so a Viewer replacement
    cannot leave an imaginary owner behind. */
export class AgentRegistry {
  constructor(
    readonly filename = statePath("agent-registry.json"),
    private readonly ownerAlive: (owner: ProcessIdentity) => boolean = (owner) =>
      procBackend.pidAlive(owner.pid) && (owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity),
  ) {}

  private acquireLock(lock: string, owner: ProcessIdentity): void {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        fs.mkdirSync(lock, 0o700);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const previous = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as ProcessIdentity;
          stale = Number.isInteger(previous.pid) && previous.pid > 0 && !this.ownerAlive(previous);
        } catch {
          /* A creator may still be writing owner.json. Preserve unknown locks. */
        }
        if (stale) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    throw new Error("agent registry is busy");
  }

  private mutate<T>(fn: (file: RegistryFile) => T): T {
    const lock = `${this.filename}.write-lock`;
    this.acquireLock(lock, { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) });
    try {
      const file = readFile(this.filename);
      const result = fn(file);
      writeAtomic(this.filename, file);
      return result;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  snapshot(): RegistryFile { return readFile(this.filename); }

  beginSpawn(engine: AgentEngine, cwd: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt: SpawnReceipt = { launchId: crypto.randomUUID(), engine, cwd, createdAt: now(), state: "starting", artifactPath: null, error: null };
      file.receipts[receipt.launchId] = receipt;
      return clone(receipt);
    });
  }

  completeSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state !== "starting") throw new Error("unknown or completed spawn receipt");
      const full = { ...entry, updatedAt: now() };
      file.entries[sessionKeyId(entry.key)] = full;
      receipt.state = "completed";
      receipt.artifactPath = entry.artifactPath;
      return clone(full);
    });
  }

  failSpawn(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (receipt && receipt.state === "starting") {
        receipt.state = "failed";
        receipt.error = error;
      }
    });
  }

  upsert(entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const full = { ...entry, updatedAt: now() };
      file.entries[sessionKeyId(entry.key)] = full;
      return clone(full);
    });
  }

  markUnhosted(key: SessionKey): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) return;
      entry.host = null;
      entry.status = "unhosted";
      entry.updatedAt = now();
    });
  }

  claim(key: SessionKey, owner: string): AgentRegistryEntry {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) throw new Error("agent registry entry is missing");
      if (entry.claimOwner && entry.claimOwner !== owner) throw new Error("agent session is claimed by another operation");
      entry.claimOwner = owner;
      entry.claimEpoch += 1;
      entry.updatedAt = now();
      return clone(entry);
    });
  }

  releaseClaim(key: SessionKey, owner: string): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (entry?.claimOwner === owner) {
        entry.claimOwner = null;
        entry.updatedAt = now();
      }
    });
  }

  /** Cross-process operation lock. Stale owners include their process start
      identity and may be recovered by an explicit caller after verification. */
  async withOperationLock<T>(key: SessionKey, owner: ProcessIdentity, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.filename}.locks/${encodeURIComponent(sessionKeyId(key))}`;
    this.acquireLock(lock, owner);
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  importResumePanes(serverPid: number, records: Map<string, ResumePaneRecord>): void {
    this.mutate((file) => {
      if (file.importedResumePanes && file.legacyResumePanes.serverPid === serverPid) return;
      file.legacyResumePanes = { serverPid, panes: Object.fromEntries(records) };
      file.importedResumePanes = true;
    });
  }

  resumePanes(serverPid: number): Map<string, ResumePaneRecord> {
    const saved = this.snapshot().legacyResumePanes;
    return saved.serverPid === serverPid ? new Map(Object.entries(saved.panes)) : new Map();
  }

  rememberResumePane(serverPid: number, pathname: string, record: ResumePaneRecord): void {
    this.mutate((file) => {
      if (file.legacyResumePanes.serverPid !== serverPid) file.legacyResumePanes = { serverPid, panes: {} };
      file.legacyResumePanes.panes[pathname] = record;
      file.importedResumePanes = true;
    });
  }

  reconcileSpawnReceipts(live: Iterable<SessionKey>): void {
    const liveIds = new Set([...live].map(sessionKeyId));
    this.mutate((file) => {
      for (const entry of Object.values(file.entries)) {
        if (liveIds.has(sessionKeyId(entry.key))) entry.pendingAction = null;
      }
      for (const receipt of Object.values(file.receipts)) {
        if (receipt.state !== "starting" || !receipt.artifactPath) continue;
        const key = Object.values(file.entries).find((entry) => entry.artifactPath === receipt.artifactPath)?.key;
        if (key && liveIds.has(sessionKeyId(key))) receipt.state = "completed";
      }
    });
  }

  completeObservedSpawn(key: SessionKey, artifactPath: string, cwd: string): void {
    this.mutate((file) => {
      for (const receipt of Object.values(file.receipts)) {
        if (receipt.state === "starting" && receipt.engine === key.engine && receipt.cwd === cwd) {
          receipt.state = "completed";
          receipt.artifactPath = artifactPath;
        }
      }
    });
  }

  /** Allocates one Viewer-owned identity for every native generation. Paths
      remain an interoperability detail and can change on every account move. */
  ensureConversation(engine: Extract<AgentEngine, "claude" | "codex">, artifactPath: string, accountId: string | null): RegistryConversation {
    return this.mutate((file) => {
      const existing = Object.values(file.conversations).find((conversation) => conversation.engine === engine && conversation.generations.some((generation) => generation.path === artifactPath));
      if (existing) return clone(existing);
      const createdAt = now();
      const conversation: RegistryConversation = {
        id: `conversation_${crypto.randomUUID()}`,
        engine,
        generations: [{ id: crypto.randomUUID(), path: artifactPath, accountId, createdAt, archivedAt: null }],
        migration: null,
        createdAt,
        updatedAt: createdAt,
      };
      file.conversations[conversation.id] = conversation;
      return clone(conversation);
    });
  }

  conversationForPath(artifactPath: string): RegistryConversation | null {
    return Object.values(this.snapshot().conversations).find((conversation) => conversation.generations.some((generation) => generation.path === artifactPath)) ?? null;
  }

  conversation(id: ViewerConversationId): RegistryConversation | null {
    return this.snapshot().conversations[id] ?? null;
  }

  canonicalPath(artifactPath: string): string {
    const conversation = this.conversationForPath(artifactPath);
    return conversation?.generations.at(-1)?.path ?? artifactPath;
  }

  setEngineRouting(engine: Extract<AgentEngine, "claude" | "codex">, accountId: string): number {
    return this.mutate((file) => {
      const route = file.engineRouting[engine];
      route.activeAccountId = accountId;
      route.revision += 1;
      return route.revision;
    });
  }

  engineRouting(engine: Extract<AgentEngine, "claude" | "codex">): { activeAccountId: string | null; revision: number } {
    return clone(this.snapshot().engineRouting[engine]);
  }

  upsertMigrationIntent(engine: Extract<AgentEngine, "claude" | "codex">, targetId: string, origin: MigrationOrigin, requestId: string, evidence: MigrationIntent["evidence"] = null): MigrationIntent {
    return this.mutate((file) => {
      const active = Object.values(file.migrationIntents).find((intent) => intent.engine === engine && intent.state === "draining");
      if (active) {
        if (active.origin === "manual" && origin === "auto") return clone(active);
        if (!active.requestIds.includes(requestId)) active.requestIds.push(requestId);
        if (active.targetId !== targetId || active.origin !== origin) { active.targetId = targetId; active.origin = origin; active.revision += 1; active.evidence = evidence; }
        active.updatedAt = now();
        return clone(active);
      }
      const createdAt = now();
      const intent: MigrationIntent = { id: crypto.randomUUID(), engine, targetId, origin, revision: 1, state: "draining", createdAt, updatedAt: createdAt, requestIds: [requestId], evidence, stoppedAt: null };
      file.migrationIntents[intent.id] = intent;
      return clone(intent);
    });
  }

  setConversationMigration(id: ViewerConversationId, migration: ConversationMigration | null): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      if (!conversation) throw new Error("viewer conversation is unknown");
      conversation.migration = migration;
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  commitSuccessor(id: ViewerConversationId, successor: Omit<NativeGeneration, "createdAt" | "archivedAt">, expectedRevision: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      if (!conversation?.migration || conversation.migration.revision !== expectedRevision) throw new Error("migration revision is stale");
      const predecessor = conversation.generations.at(-1);
      if (!predecessor) throw new Error("viewer conversation has no native generation");
      predecessor.archivedAt = now();
      conversation.generations.push({ ...successor, createdAt: now(), archivedAt: null });
      conversation.migration = { ...conversation.migration, phase: "committed", updatedAt: now() };
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  setMigrationIntentState(id: string, state: MigrationIntent["state"]): MigrationIntent {
    return this.mutate((file) => {
      const intent = file.migrationIntents[id];
      if (!intent) throw new Error("migration intent is unknown");
      intent.state = state;
      intent.stoppedAt = state === "stopped" ? now() : intent.stoppedAt;
      intent.updatedAt = now();
      return clone(intent);
    });
  }

  autoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">): AutoBalancePolicy {
    return clone(this.snapshot().autoBalance[engine]);
  }

  setAutoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">, enabled: boolean, expectedRevision?: number): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      if (expectedRevision !== undefined && policy.revision !== expectedRevision) throw new Error("automatic balance policy revision is stale");
      policy.enabled = enabled;
      policy.revision += 1;
      return clone(policy);
    });
  }

  recordAutoBalanceOutcome(engine: Extract<AgentEngine, "claude" | "codex">, outcome: AutoBalancePolicy["lastOutcome"], evidence: AutoBalancePolicy["lastTrigger"], cooldownUntil: string): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      policy.cooldownUntil = cooldownUntil;
      policy.lastOutcome = outcome;
      policy.lastTrigger = evidence;
      if (evidence) policy.departed[evidence.sourceId] = now();
      policy.revision += 1;
      return clone(policy);
    });
  }

  holdDelivery(conversationId: ViewerConversationId, text: string, clientMessageId: string | null = null): HeldDelivery {
    if (!text || text.length > 32_000) throw new Error("held delivery must contain at most 32000 characters");
    return this.mutate((file) => {
      const existing = clientMessageId ? Object.values(file.heldDeliveries).find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId) : undefined;
      if (existing) return clone(existing);
      const held = { id: crypto.randomUUID(), conversationId, text, createdAt: now(), clientMessageId };
      const count = Object.values(file.heldDeliveries).filter((item) => item.conversationId === conversationId).length;
      if (count >= 100) throw new Error("held delivery limit reached for conversation");
      file.heldDeliveries[held.id] = held;
      return clone(held);
    });
  }
}

let registry: AgentRegistry | null = null;
export function agentRegistry(): AgentRegistry {
  registry ??= new AgentRegistry();
  return registry;
}
