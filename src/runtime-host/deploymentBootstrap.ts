import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export interface ViewerBootstrapAdapter {
  targetExists(): boolean;
  resolveRevision(requested: string): Promise<string>;
  buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity>;
  startCandidate(candidate: ViewerReleaseIdentity): Promise<void>;
  verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence>;
  publishTarget(candidate: ViewerReleaseIdentity): Promise<void>;
  targetMatches(candidate: ViewerReleaseIdentity): boolean;
  retireCandidate(candidate: ViewerReleaseIdentity): Promise<void>;
}

export interface ViewerBootstrapResult {
  candidate: ViewerReleaseIdentity;
  health: ViewerHealthEvidence;
}

export async function bootstrapViewerRelease(
  requestedRevision: string,
  deploymentId: string,
  adapter: ViewerBootstrapAdapter,
): Promise<ViewerBootstrapResult> {
  if (adapter.targetExists()) throw new Error("Viewer release target already exists");
  const revision = await adapter.resolveRevision(requestedRevision);
  const candidate = await adapter.buildCandidate(deploymentId, revision);
  let health: ViewerHealthEvidence;
  try {
    await adapter.startCandidate(candidate);
    health = await adapter.verifyCandidate(candidate);
    if (!health.ok) throw new Error(health.detail || "candidate health verification failed");
  } catch (error) {
    await adapter.retireCandidate(candidate);
    throw error;
  }
  try {
    await adapter.publishTarget(candidate);
  } catch (error) {
    let targetMatches: boolean;
    try {
      targetMatches = adapter.targetMatches(candidate);
    } catch {
      throw error;
    }
    if (!targetMatches) {
      await adapter.retireCandidate(candidate);
      throw error;
    }
  }
  return { candidate, health };
}
