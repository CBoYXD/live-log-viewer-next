import { expect, test } from "bun:test";

import {
  viewerCandidateContainerName,
  viewerCandidateImageName,
  viewerComposeSnapshotName,
} from "./deploymentArtifacts";

test("same-revision releases receive distinct containers, image tags, and Compose snapshots", () => {
  const revision = "a".repeat(40);
  const firstContainer = viewerCandidateContainerName("deployment-a");
  const secondContainer = viewerCandidateContainerName("deployment-b");

  expect(firstContainer).not.toBe(secondContainer);
  expect(viewerCandidateImageName(revision, firstContainer)).not.toBe(viewerCandidateImageName(revision, secondContainer));
  expect(viewerComposeSnapshotName(firstContainer)).not.toBe(viewerComposeSnapshotName(secondContainer));
  expect(viewerComposeSnapshotName(firstContainer)).toBe(viewerComposeSnapshotName(firstContainer));
});
