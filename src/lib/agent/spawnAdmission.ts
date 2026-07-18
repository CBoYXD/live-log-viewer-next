import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { RegistryFile, SpawnReceipt } from "./registry";
import { VIEWER_SPAWN_ENDPOINT } from "./spawnPolicy";

/** Roles with zero child-spawn capability (#393). A hardcoded contract
    constant: role overrides only carry config/promptScaffold, so no
    persisted preset can widen this set. */
export const SPAWN_DENIED_ROLE_IDS: readonly string[] = Object.freeze(["reviewer", "verifier"]);

export function isSpawnDeniedRole(role: string | null | undefined): boolean {
  return typeof role === "string" && SPAWN_DENIED_ROLE_IDS.includes(role);
}

export type SpawnRejectionCode = "reviewer_origin_spawn" | "nesting_depth_exceeded";

/** Who initiated a launch. Enforcement keys on this declared/authenticated
    initiator — never on the lineage parent, which may legitimately be a
    reviewer transcript (pipeline stages chain through the last passed stage). */
export type SpawnOrigin =
  | { kind: "operator" }
  | { kind: "agent"; conversationId: ViewerConversationId }
  | { kind: "container"; container: "pipeline" | "flow"; containerId: string; creatorConversationId: ViewerConversationId | null }
  | { kind: "external" }
  | { kind: "successor" };

export interface SpawnRejection {
  code: SpawnRejectionCode;
  origin: {
    kind: "agent" | "container";
    conversationId: ViewerConversationId | null;
    role: string | null;
    depth: number;
  };
  requestedRole: string | null;
  /** Depth the child would have had. */
  childDepth: number;
  /** Policy ceiling at rejection time. */
  maxDepth: number;
  guidance: string;
  rejectedAt: string;
}

/** Typed terminal admission rejection (#393): the receipt is durable and
    terminal, and no conversation, lineage edge, membership, transcript, or
    process exists for it. */
export class SpawnAdmissionError extends Error {
  constructor(readonly receipt: SpawnReceipt, readonly rejection: SpawnRejection) {
    super(rejection.guidance);
    this.name = "SpawnAdmissionError";
  }
}

export function reviewerOriginSpawnGuidance(role: string | null): string {
  const label = role === "verifier" ? "Verifier" : "Reviewer";
  return `${label} sessions run every check in-session — filesystem, shell, GitHub, and browser access stay available, but child agents do not. For more perspectives, report the need to your parent so an operator or orchestrator adds a visible reviewer stage (POST /api/pipelines or POST ${VIEWER_SPAWN_ENDPOINT}).`;
}

export function nestingDepthGuidance(childDepth: number, maxDepth: number): string {
  return `Agent nesting is capped at depth ${maxDepth} and this launch would create a depth-${childDepth} child. Finish delegated work in-session or report the need to your parent. An operator can raise maxAgentNestingDepth in Viewer spawn settings (PATCH /api/spawn/policy).`;
}

type AdmissionFileView = Pick<RegistryFile, "conversations" | "conversationAliases" | "lineageEdges" | "memberships">;

function canonicalId(file: AdmissionFileView, id: ViewerConversationId): ViewerConversationId {
  const seen = new Set<ViewerConversationId>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = file.conversationAliases[current];
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Durable role of a conversation, resolved fail-open for legacy records:
    the recorded conversation role, else its lineage-edge role, else its
    newest membership role, else null (unknown ≠ reviewer). */
export function conversationAgentRole(file: AdmissionFileView, id: ViewerConversationId): string | null {
  const canonical = canonicalId(file, id);
  const recorded = file.conversations[canonical]?.agentRole;
  if (typeof recorded === "string" && recorded.trim()) return recorded;
  const edgeRole = file.lineageEdges[canonical]?.role;
  if (typeof edgeRole === "string" && edgeRole.trim()) return edgeRole;
  const memberships = file.memberships[canonical] ?? [];
  const newest = [...memberships].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return newest?.role ?? null;
}

const LEGACY_DEPTH_WALK_CAP = 8;

/** Delegation depth of a conversation. Recorded-at-birth depth wins; legacy
    records fall back to container membership (⇒ 1 — pipeline lineage chains
    stage-to-stage, so an edge walk would overcount container children) and
    then a bounded, cycle-guarded lineage-edge walk. */
export function conversationDelegationDepth(file: AdmissionFileView, id: ViewerConversationId): number {
  const canonical = canonicalId(file, id);
  const recorded = file.conversations[canonical]?.delegationDepth;
  if (Number.isInteger(recorded) && recorded! >= 0) return recorded!;
  if ((file.memberships[canonical] ?? []).length > 0) return 1;
  let depth = 0;
  const seen = new Set<ViewerConversationId>([canonical]);
  let current = canonical;
  while (depth < LEGACY_DEPTH_WALK_CAP) {
    const edge = file.lineageEdges[current];
    if (!edge || edge.source !== "viewer-spawn") break;
    const parent = canonicalId(file, edge.parentConversationId);
    if (seen.has(parent)) break;
    seen.add(parent);
    depth += 1;
    const parentRecorded = file.conversations[parent]?.delegationDepth;
    if (Number.isInteger(parentRecorded) && parentRecorded! >= 0) return parentRecorded! + depth;
    current = parent;
  }
  return depth;
}

export interface ResolvedSpawnOrigin {
  kind: "agent" | "container";
  conversationId: ViewerConversationId | null;
  role: string | null;
  depth: number;
}

/** Role and depth of the initiating origin, for the origin kinds that are
    subject to admission. Operator/external/successor origins are roots. */
export function resolveSpawnOrigin(file: AdmissionFileView, origin: SpawnOrigin): ResolvedSpawnOrigin | null {
  if (origin.kind !== "agent" && origin.kind !== "container") return null;
  const originConversationId = origin.kind === "agent" ? origin.conversationId : origin.creatorConversationId;
  const canonical = originConversationId ? canonicalId(file, originConversationId) : null;
  return {
    kind: origin.kind,
    conversationId: canonical,
    role: canonical ? conversationAgentRole(file, canonical) : null,
    depth: canonical ? conversationDelegationDepth(file, canonical) : 0,
  };
}
