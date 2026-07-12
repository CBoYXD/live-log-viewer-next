import type { Flow, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { activityBand, isChildConversation, projectKey } from "@/components/projectModel";

/*
 * Worker-class auto-collapse (issue #112).
 *
 * Orchestration sessions breed dozens of short-lived worker conversations —
 * flow implementers, headless reviewer rounds, pipeline stages, agent-spawned
 * subtasks. Each is only interesting while its round is active; once it goes
 * quiet it should fold into a compact per-flow / per-worktree stack instead of
 * holding a full board node.
 *
 * This module is the pure decision layer: given the scanned files, the flow /
 * pipeline lineage, and the durable pin set, it classifies each conversation
 * and derives the stacks the board renders. It writes nothing — the collapsed
 * placement is a deterministic function of the scan, so it survives reloads and
 * redeploys with no stored "collapsed" flag; the only durable state is the
 * user's manual-expand pin, carried by the board store's existing membership
 * lists (`expanded` / `manual`).
 */

export type WorkerClass = "flow-reviewer" | "flow-implementer" | "pipeline-stage" | "spawned-worker";

/** Default inactivity window before a non-reviewer worker collapses (issue
    #112 asks for ~15 minutes, configurable). Reviewer rounds ignore this and
    collapse the instant their round reaches a verdict. */
export const DEFAULT_WORKER_COLLAPSE_IDLE_MS = 15 * 60 * 1000;

/**
 * Operator-tunable idle window. `NEXT_PUBLIC_*` is inlined into the client
 * bundle by Next, so the threshold can be retuned without touching this code; a
 * missing or malformed value falls back to the 15-minute default.
 */
export function workerCollapseIdleMs(): number {
  const raw = typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_WORKER_COLLAPSE_MINUTES : undefined;
  const minutes = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_WORKER_COLLAPSE_IDLE_MS;
}

/** Transcript paths owned by a pipeline stage attempt — pipeline-stage workers. */
export function pipelineStageAgentPaths(pipelines: readonly Pipeline[]): Set<string> {
  const set = new Set<string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath) set.add(attempt.agentPath);
      }
    }
  }
  return set;
}

export interface WorkerLineage {
  flows: readonly Flow[];
  /** Output of {@link pipelineStageAgentPaths} — computed once per render. */
  pipelineStagePaths: ReadonlySet<string>;
}

/**
 * Worker lineage of a conversation, or null for an owner-started root. Order
 * matters: a flow annotation is the strongest signal (a flow implementer is a
 * root conversation, but a managed one), then pipeline stage ownership, then
 * generic agent-spawned lineage.
 */
export function classifyWorker(file: FileEntry, lineage: WorkerLineage): WorkerClass | null {
  if (file.flow?.flowRole === "reviewer") return "flow-reviewer";
  if (file.flow?.flowRole === "implementer") return "flow-implementer";
  if (lineage.pipelineStagePaths.has(file.path)) return "pipeline-stage";
  if (isChildConversation(file)) return "spawned-worker";
  return null;
}

function roundForReviewer(file: FileEntry, flows: readonly Flow[]): Round | null {
  const annotation = file.flow;
  if (!annotation) return null;
  const flow = flows.find((candidate) => candidate.id === annotation.flowId);
  if (!flow) return null;
  return (
    flow.rounds.find((round) => round.reviewerPath === file.path)
    ?? (annotation.round !== null ? flow.rounds.find((round) => round.n === annotation.round) ?? null : null)
  );
}

/** A reviewer round is finished the moment it reaches a verdict or a terminal
    error — the point the issue's owner comment marks for immediate collapse. */
export function reviewerRoundFinished(round: Round): boolean {
  return round.verdict !== null || round.reviewedAt !== null || round.error !== null || Boolean(round.terminalAt);
}

export interface CollapseContext extends WorkerLineage {
  nowMs: number;
  idleMs: number;
  /** Paths the user manually placed/expanded — a durable pin against collapse. */
  pinnedPaths: ReadonlySet<string>;
}

/**
 * Hard exemptions (issue #112): a conversation that must never auto-collapse
 * regardless of idle time. Owner attention (a human-authored message), any live
 * or mid-turn work, an in-flight account migration, and an explicit manual
 * placement each pin the card. These mirror the reaper's protection reasons so
 * the board and the process side never disagree about what is "just a worker".
 */
export function isCollapseExempt(file: FileEntry, context: CollapseContext): boolean {
  if (file.userAuthored) return true;
  if (file.activity === "live" || file.activity === "stalled") return true;
  if (file.proc === "running") return true;
  if (file.pendingQuestion || file.waitingInput) return true;
  if (file.migration && file.migration.phase !== "committed" && file.migration.phase !== "rolled-back") return true;
  if (context.pinnedPaths.has(file.path)) return true;
  return false;
}

/**
 * Whether a single worker-class conversation should fold into a stack now.
 * Reviewer rounds collapse immediately on verdict; every other worker waits out
 * the idle window. Owner-touched / live / pinned conversations never collapse.
 */
export function shouldCollapseWorker(file: FileEntry, context: CollapseContext): boolean {
  const klass = classifyWorker(file, context);
  if (!klass) return false;
  if (isCollapseExempt(file, context)) return false;
  if (klass === "flow-reviewer") {
    const round = roundForReviewer(file, context.flows);
    if (round && reviewerRoundFinished(round)) return true;
  }
  return context.nowMs - file.mtime * 1000 >= context.idleMs;
}

export interface WorkerStack {
  /** Stable board key, usable as a camera/flash target and a React key. */
  key: string;
  kind: "flow" | "worktree";
  /** Flow id or worktree name behind this stack. */
  id: string;
  /** Collapse-eligible worker conversations, freshest first. */
  items: FileEntry[];
}

function stackKeyFor(file: FileEntry): { key: string; kind: "flow" | "worktree"; id: string } {
  if (file.flow) return { key: "wstack::flow::" + file.flow.flowId, kind: "flow", id: file.flow.flowId };
  const worktree = file.worktree ?? "";
  return { key: "wstack::worktree::" + worktree, kind: "worktree", id: worktree };
}

export interface WorkerStacksInput {
  files: readonly FileEntry[];
  project: string;
  flows: readonly Flow[];
  pipelines?: readonly Pipeline[];
  /** Conversations already drawn on the scheme (nodes, mini-stack rows, reviewer
      decks): excluded so a card is never rendered in two places at once. */
  renderedPaths: ReadonlySet<string>;
  /** Durable manual placements/expansions — pinned against collapse. */
  pinnedPaths: ReadonlySet<string>;
  nowMs: number;
  idleMs?: number;
}

/**
 * Derive the per-flow / per-worktree worker stacks for a project: every
 * collapse-eligible worker conversation that the scheme is not already drawing,
 * grouped by its flow (preferred) or its worktree. Flow stacks lead, then
 * worktree stacks; within each, and between stacks, freshest first.
 */
export function computeWorkerStacks(input: WorkerStacksInput): WorkerStack[] {
  const context: CollapseContext = {
    flows: input.flows,
    pipelineStagePaths: pipelineStageAgentPaths(input.pipelines ?? []),
    nowMs: input.nowMs,
    idleMs: input.idleMs ?? workerCollapseIdleMs(),
    pinnedPaths: input.pinnedPaths,
  };
  const byKey = new Map<string, WorkerStack>();
  for (const file of input.files) {
    if (projectKey(file) !== input.project) continue;
    if (input.renderedPaths.has(file.path)) continue;
    if (!shouldCollapseWorker(file, context)) continue;
    const { key, kind, id } = stackKeyFor(file);
    const stack = byKey.get(key) ?? { key, kind, id, items: [] };
    stack.items.push(file);
    byKey.set(key, stack);
  }
  const freshness = (file: FileEntry) => activityBand(file) * 1e13 - file.mtime;
  const stacks = [...byKey.values()];
  for (const stack of stacks) stack.items.sort((a, b) => freshness(a) - freshness(b));
  return stacks.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "flow" ? -1 : 1;
    return freshness(a.items[0]!) - freshness(b.items[0]!);
  });
}
