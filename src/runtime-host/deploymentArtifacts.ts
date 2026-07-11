import { createHash } from "node:crypto";

function artifactKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function viewerCandidateContainerName(deploymentId: string): string {
  return `llv-deploy-${artifactKey(deploymentId)}`;
}

export function viewerCandidateImageName(revision: string, container: string): string {
  return `agent-log-viewer:deploy-${revision}-${artifactKey(container)}`;
}

export function viewerComposeSnapshotName(container: string): string {
  return `${artifactKey(container)}.json`;
}
