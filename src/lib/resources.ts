import { procBackend } from "@/lib/proc";
import type { ProcBackend } from "@/lib/proc";
import { readFileSync } from "node:fs";
import { completedFileScan, currentFileScan } from "@/lib/scanner/scanCache";
import { createFreshAwareCoalescer } from "@/lib/asyncCoalescer";
import { descendantPids } from "@/lib/proc/memory";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { captureTmuxAttachReference, type TmuxAttachReference } from "@/lib/tmux";

import type { FileEntry, ResourceSession, ResourcesPayload } from "./types";

/**
 * System memory pressure + per-agent-session memory attribution, the data
 * behind the rail resources block and its cleanup list. Each tmux pane whose
 * process tree contains a claude/codex CLI is one session; the tree sum is
 * what actually frees up on kill-pane — the MCP children (`npm exec`, node
 * servers) hanging off the CLI usually outweigh the CLI itself.
 */

const CACHE_MS = 10_000;

type ResourceBuildPhase = "systemMemory" | "readFiles" | "readHosts" | "ppidMap" | "processMemory" | "attach" | "serialization";
type ResourceBuildPhases = Record<ResourceBuildPhase, number>;

export type ResourceBuildDiagnostic = {
  fresh: boolean;
  status: "complete" | "failed";
  durationMs: number;
  phases: ResourceBuildPhases;
};

function emptyResourceBuildPhases(): ResourceBuildPhases {
  return {
    systemMemory: 0,
    readFiles: 0,
    readHosts: 0,
    ppidMap: 0,
    processMemory: 0,
    attach: 0,
    serialization: 0,
  };
}

function measureResourcePhase<T>(phases: ResourceBuildPhases, phase: ResourceBuildPhase, work: () => T): T {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    phases[phase] += performance.now() - startedAt;
  }
}

async function measureResourcePhaseAsync<T>(phases: ResourceBuildPhases, phase: ResourceBuildPhase, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    phases[phase] += performance.now() - startedAt;
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseResourcesFixture(raw: string): ResourcesPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid resources fixture: expected JSON");
  }
  const candidate = value as Partial<ResourcesPayload> | null;
  const system = candidate?.system;
  const validSystem = system === null || (
    typeof system === "object"
    && finiteNonNegative(system.ramTotal)
    && finiteNonNegative(system.ramAvailable)
    && finiteNonNegative(system.swapTotal)
    && finiteNonNegative(system.swapUsed)
    && typeof system.capturedAt === "string"
    && Number.isFinite(Date.parse(system.capturedAt))
  );
  if (!candidate || !validSystem || !Array.isArray(candidate.sessions) || candidate.sessions.length !== 0) {
    throw new Error("invalid resources fixture: expected system metrics and an empty sessions list");
  }
  return { system: system ?? null, sessions: [] };
}

function captureSystemMemory(proc: Pick<ProcBackend, "systemMemory"> = procBackend): ResourcesPayload["system"] {
  const system = proc.systemMemory();
  return system ? { ...system, capturedAt: new Date().toISOString() } : null;
}

/** What the kill path needs to take a snapshot session down safely: the
    stable `%N` pane id to address, and the pane pid to verify it against. */
export type KillTargetRef = TmuxAttachReference;

const globalStore = globalThis as unknown as {
  __llvResourcesReader?: ResourcesReader;
  __llvResourceTargets?: Map<string, KillTargetRef>;
  __llvLastResourceBuild?: ResourceBuildDiagnostic;
};

export function lastResourceBuildDiagnostic(): ResourceBuildDiagnostic | null {
  const diagnostic = globalStore.__llvLastResourceBuild;
  return diagnostic ? { ...diagnostic, phases: { ...diagnostic.phases } } : null;
}

/** Captures JSON response construction separately from the expensive resource
    build phases, keeping response serialization visible in live diagnostics. */
export function noteResourceSerialization(durationMs: number): void {
  if (globalStore.__llvLastResourceBuild) {
    globalStore.__llvLastResourceBuild.phases.serialization = durationMs;
  }
}

/**
 * Server-held allowlist for the kill-target action: only pane targets present
 * in the last resources snapshot may be killed. A client-supplied arbitrary
 * target could name the user's own work pane, so it is refused. Each target
 * keeps the stable pane id and pane pid it had in the snapshot: display
 * coordinates renumber as windows close (`renumber-windows on`), so the kill
 * must address the pane by id and verify the pid still matches.
 */
export function noteSessionTargets(sessions: Iterable<{ target: string; ref: KillTargetRef }>): void {
  const map = new Map<string, KillTargetRef>();
  for (const { target, ref } of sessions) map.set(target, ref);
  globalStore.__llvResourceTargets = map;
}

/** Snapshot pane ref recorded for `target`, or null when it was never listed. */
export function allowedKillTarget(target: string): KillTargetRef | null {
  if (target === "") return null;
  return globalStore.__llvResourceTargets?.get(target) ?? null;
}

/** Drops `target` from the allowlist after a kill: the coordinates are free
    for tmux to reuse, so a repeated POST must not pass the gate again. */
export function consumeKillTarget(target: string): void {
  globalStore.__llvResourceTargets?.delete(target);
}

/** The resources rail may list duplicate panes for cleanup. Only the host
    elected by the shared resolver receives the transcript path and its UI
    metadata, keeping observation aligned with path-addressed delivery. */
export function canonicalResourceEntry(
  snapshot: TranscriptHostSnapshot,
  paneHosts: TranscriptHost[],
  entriesByPath: Map<string, FileEntry>,
): FileEntry | null {
  for (const candidate of paneHosts) {
    if (!candidate.primaryPath) continue;
    const canonical = snapshot.canonicalFor(candidate.primaryPath);
    if (canonical?.paneId === candidate.paneId && canonical.agentPid === candidate.agentPid) {
      return entriesByPath.get(candidate.primaryPath) ?? null;
    }
  }
  return null;
}

export function conflictingResourceHost(snapshot: TranscriptHostSnapshot, host: TranscriptHost): boolean {
  return snapshot.conflicts?.some((conflict) => conflict.paneIds.includes(host.paneId)) ?? false;
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface ResourceSnapshotDependencies {
  readFiles(fresh: boolean): Promise<FileEntry[]>;
  readHosts(fresh: boolean, entries: FileEntry[]): Promise<TranscriptHostSnapshot>;
  proc: Pick<ProcBackend, "systemMemory" | "ppidMap" | "processMemory">;
  captureAttachReference: typeof captureTmuxAttachReference;
}

const resourceSnapshotDependencies: ResourceSnapshotDependencies = {
  readFiles: readResourceFileSnapshot,
  readHosts: readTranscriptHosts,
  proc: procBackend,
  captureAttachReference: captureTmuxAttachReference,
};

export async function readResourceFileSnapshot(fresh: boolean): Promise<FileEntry[]> {
  const scan = fresh ? await currentFileScan({ fresh: true }) : await completedFileScan();
  return scan.snapshot.files;
}

/** `fresh` advances the shared file scan and skips the pane/agent-process
    memos. A rebuild triggered right after a kill must use one newer corpus for
    host ownership, metadata, and the kill allowlist. */
export async function buildResourceSnapshot(
  fresh: boolean,
  dependencies: ResourceSnapshotDependencies = resourceSnapshotDependencies,
): Promise<ResourcesPayload> {
  const startedAt = performance.now();
  const phases = emptyResourceBuildPhases();
  try {
    const system = measureResourcePhase(phases, "systemMemory", () => captureSystemMemory(dependencies.proc));
    const files = await measureResourcePhaseAsync(phases, "readFiles", () => dependencies.readFiles(fresh));
    const hosts = await measureResourcePhaseAsync(phases, "readHosts", () => dependencies.readHosts(fresh, files));
    const sessions: ResourceSession[] = [];
    if (hosts.hosts.length > 0) {
      const ppids = measureResourcePhase(phases, "ppidMap", () => dependencies.proc.ppidMap());
      overlaySessionTitles(files);
      const byPath = new Map(files.map((entry) => [entry.path, entry]));
      const byPane = new Map<string, TranscriptHost[]>();
      for (const host of hosts.hosts) {
        const paneHosts = byPane.get(host.paneId);
        if (paneHosts) paneHosts.push(host);
        else byPane.set(host.paneId, [host]);
      }

      /* Trees first, memory second: one processMemory() batch over the union
         keeps the portable backend at a single `ps` spawn for all panes. */
      const paneTrees: Array<{ host: TranscriptHost; tree: number[]; paneHosts: TranscriptHost[] }> = [];
      const treePids = new Set<number>();
      for (const paneHosts of byPane.values()) {
        const host = paneHosts[0]!;
        const tree = descendantPids(host.panePid, ppids);
        paneTrees.push({ host, tree, paneHosts });
        for (const pid of tree) treePids.add(pid);
      }
      const memory = measureResourcePhase(phases, "processMemory", () => dependencies.proc.processMemory(treePids));

      const killRefs: Array<{ target: string; ref: KillTargetRef }> = [];
      measureResourcePhase(phases, "attach", () => {
        for (const { host, tree, paneHosts } of paneTrees) {
          let rssBytes = 0;
          let swapBytes = 0;
          for (const pid of tree) {
            const mem = memory.get(pid);
            if (!mem) continue;
            rssBytes += mem.rssBytes;
            swapBytes += mem.swapBytes;
          }
          /* The resolver elects one canonical host for every transcript. A
             duplicate pane stays visible for cleanup, though it carries no path
             and cannot disagree with path-addressed delivery. */
          const entry = canonicalResourceEntry(hosts, paneHosts, byPath);
          sessions.push({
            target: host.display,
            panePid: host.panePid,
            path: entry?.path ?? null,
            engine: host.engine,
            hostConflict: conflictingResourceHost(hosts, host),
            title: entry?.title ?? null,
            project: entry?.project || null,
            activity: entry?.activity ?? null,
            lastActiveAt: entry ? isoFromUnix(entry.mtime) : null,
            cwd: host.cwd,
            rssBytes,
            swapBytes,
            procCount: tree.length,
          });
          killRefs.push({
            target: host.display,
            ref: dependencies.captureAttachReference({ tmuxServerPid: host.tmuxServerPid, panePid: host.panePid, paneId: host.paneId }),
          });
        }
      });
      sessions.sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes));
      noteSessionTargets(killRefs);
    } else {
      noteSessionTargets([]);
    }

    globalStore.__llvLastResourceBuild = { fresh, status: "complete", durationMs: performance.now() - startedAt, phases };
    return { system, sessions };
  } catch (error) {
    globalStore.__llvLastResourceBuild = { fresh, status: "failed", durationMs: performance.now() - startedAt, phases };
    throw error;
  }
}

export interface ResourcesReader {
  read(fresh?: boolean): Promise<ResourcesPayload>;
}

export function createResourcesReader(
  build: (fresh: boolean) => Promise<ResourcesPayload>,
  captureSystem: () => ResourcesPayload["system"],
  now: () => number = Date.now,
): ResourcesReader {
  let cached: { at: number; data: ResourcesPayload } | null = null;
  const coordinator = createFreshAwareCoalescer<ResourcesPayload>();
  const rebuild = async (fresh: boolean): Promise<ResourcesPayload> => {
    const data = await build(fresh);
    cached = { at: now(), data };
    return data;
  };

  return {
    async read(fresh = false): Promise<ResourcesPayload> {
      if (!fresh && cached) {
        if (now() - cached.at >= CACHE_MS) {
          /* A stale resource poll only starts the shared rebuild. The cached
             session snapshot stays available while filesystem, process, and
             tmux observations run off the request path. */
          void coordinator.run(false, rebuild).catch(() => undefined);
        }
        return { ...cached.data, system: captureSystem() };
      }
      const data = await coordinator.run(fresh, rebuild);
      return fresh ? data : { ...data, system: captureSystem() };
    },
  };
}

function resourcesReader(): ResourcesReader {
  globalStore.__llvResourcesReader ??= createResourcesReader(
    buildResourceSnapshot,
    () => captureSystemMemory(),
  );
  return globalStore.__llvResourcesReader;
}

/** Snapshot for GET /api/resources, cached briefly so UI polling stays cheap.
    `fresh` forces a rebuild — used right after a kill so the freed memory and
    the shorter session list show up immediately. */
export async function readResources(fresh = false): Promise<ResourcesPayload> {
  const fixturePath = process.env.LLV_RESOURCES_FIXTURE;
  if (fixturePath) {
    noteSessionTargets([]);
    return parseResourcesFixture(readFileSync(fixturePath, "utf8"));
  }
  return resourcesReader().read(fresh);
}
