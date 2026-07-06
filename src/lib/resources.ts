import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { listFiles } from "@/lib/scanner";
import { agentProcesses, type AgentEngine } from "@/lib/scanner/process";
import { panePidMap } from "@/lib/tmux";

import type { FileEntry, ResourceSession, ResourcesPayload } from "./types";

/**
 * System memory pressure + per-agent-session memory attribution, the data
 * behind the rail resources block and its cleanup list. Each tmux pane whose
 * process tree contains a claude/codex CLI is one session; the tree sum is
 * what actually frees up on kill-pane — the MCP children (`npm exec`, node
 * servers) hanging off the CLI usually outweigh the CLI itself.
 */

const CACHE_MS = 10_000;

const globalStore = globalThis as unknown as {
  __llvResourcesCache?: { at: number; data: ResourcesPayload } | null;
  __llvResourceTargets?: Set<string>;
};

/**
 * Server-held allowlist for the kill-target action: only pane targets present
 * in the last resources snapshot may be killed, never a client-supplied
 * arbitrary target (which could name the user's own work pane).
 */
export function noteSessionTargets(targets: Iterable<string>): void {
  globalStore.__llvResourceTargets = new Set(targets);
}

export function killTargetAllowed(target: string): boolean {
  return target !== "" && (globalStore.__llvResourceTargets?.has(target) ?? false);
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * pid → transcript entry for every conversation the scanner attributed to a
 * live process. Root conversations win over their branches (a branch shares
 * the root's pane and pid, but the root card carries the title the user knows).
 */
function entriesByPid(entries: FileEntry[]): Map<number, FileEntry> {
  const byPid = new Map<number, FileEntry>();
  for (const entry of entries) {
    if (entry.pid === null || entry.proc !== "running") continue;
    const current = byPid.get(entry.pid);
    if (!current || (current.parent && !entry.parent)) byPid.set(entry.pid, entry);
  }
  return byPid;
}

async function buildResources(): Promise<ResourcesPayload> {
  const capturedAt = new Date().toISOString();
  const system = procBackend.systemMemory();

  const panes = await panePidMap();
  const sessions: ResourceSession[] = [];
  if (panes.size > 0) {
    const ppids = procBackend.ppidMap();
    const agentEngine = new Map<number, AgentEngine>();
    for (const proc of agentProcesses()) agentEngine.set(proc.pid, proc.engine);
    const byPid = entriesByPid(await listFiles());

    /* Trees first, memory second: one processMemory() batch over the union
       keeps the portable backend at a single `ps` spawn for all panes. */
    const paneTrees: Array<{ target: string; panePid: number; tree: number[]; agentPids: number[] }> = [];
    const treePids = new Set<number>();
    for (const [panePid, target] of panes) {
      const tree = descendantPids(panePid, ppids);
      const agentPids = tree.filter((pid) => agentEngine.has(pid));
      if (agentPids.length === 0) continue; // plain shell / editor / dev-server pane
      paneTrees.push({ target, panePid, tree, agentPids });
      for (const pid of tree) treePids.add(pid);
    }
    const memory = procBackend.processMemory(treePids);

    for (const { target, panePid, tree, agentPids } of paneTrees) {
      let rssBytes = 0;
      let swapBytes = 0;
      for (const pid of tree) {
        const mem = memory.get(pid);
        if (!mem) continue;
        rssBytes += mem.rssBytes;
        swapBytes += mem.swapBytes;
      }
      const entry = agentPids.map((pid) => byPid.get(pid)).find(Boolean) ?? null;
      sessions.push({
        target,
        panePid,
        path: entry?.path ?? null,
        engine: agentEngine.get(agentPids[0]) ?? null,
        title: entry?.title ?? null,
        project: entry?.project || null,
        activity: entry?.activity ?? null,
        lastActiveAt: entry ? isoFromUnix(entry.mtime) : null,
        rssBytes,
        swapBytes,
        procCount: tree.length,
      });
    }
    sessions.sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes));
  }

  noteSessionTargets(sessions.map((session) => session.target));
  return {
    system: system ? { ...system, capturedAt } : null,
    sessions,
  };
}

/** Snapshot for GET /api/resources, cached briefly so UI polling stays cheap.
    `fresh` forces a rebuild — used right after a kill so the freed memory and
    the shorter session list show up immediately. */
export async function readResources(fresh = false): Promise<ResourcesPayload> {
  const cached = globalStore.__llvResourcesCache;
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const data = await buildResources();
  globalStore.__llvResourcesCache = { at: Date.now(), data };
  return data;
}
