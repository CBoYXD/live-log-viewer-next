import type { PipelineRoleId, PipelineRoleRef, PipelineStageKind, EffectivePipelineRole } from "./types";

export const PIPELINE_ROLE_IDS: readonly PipelineRoleId[] = [
  "orchestrator",
  "reviewer",
  "verifier",
  "builder",
  "architect",
  "cleaner",
  "prod-auditor",
  "deployer",
];

export type PipelineRoleDefaults = {
  engine: "claude" | "codex";
  model: string | null;
  effort: string | null;
  access?: "read-only" | "read-write";
};

/** Adapter seam for #35. The role registry can register its resolver at startup. */
export type PipelineRoleLookup = (roleId: string) => PipelineRoleDefaults | null;

let installedLookup: PipelineRoleLookup | null = null;

export function setPipelineRoleLookup(lookup: PipelineRoleLookup | null): void {
  installedLookup = lookup;
}

export function resolvePipelineRole(
  ref: PipelineRoleRef,
  kind: PipelineStageKind,
  lookup?: PipelineRoleLookup | null,
): { role?: EffectivePipelineRole; error?: string } {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return { error: "stage role must be an object" };
  const roleId = typeof ref.roleId === "string" ? ref.roleId.trim() : "";
  if (!roleId) return { error: "stage roleId is required" };
  if (!PIPELINE_ROLE_IDS.includes(roleId as PipelineRoleId)) return { error: `unknown pipeline role: ${roleId}` };
  const registered = (lookup === undefined ? installedLookup : lookup)?.(roleId) ?? null;
  const engine = ref.engine ?? registered?.engine;
  if (engine !== "claude" && engine !== "codex") {
    return { error: `role ${roleId} is unavailable; provide an explicit engine until the role registry resolves it` };
  }
  if (ref.access !== undefined && ref.access !== "read-only" && ref.access !== "read-write") {
    return { error: `role ${roleId} has an invalid access value` };
  }
  if (kind === "review-loop" && ref.access === "read-write") {
    return { error: "review-loop stages require read-only access" };
  }
  const value = (override: unknown, fallback: string | null | undefined): string | null => {
    if (override === null) return null;
    if (typeof override === "string") return override.trim() || null;
    return fallback ?? null;
  };
  return {
    role: {
      roleId: roleId as PipelineRoleId,
      engine,
      model: value(ref.model, registered?.model),
      effort: value(ref.effort, registered?.effort),
      access: kind === "review-loop" ? "read-only" : ref.access ?? registered?.access ?? "read-write",
    },
  };
}
