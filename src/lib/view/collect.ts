import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { observeFiles } from "@/lib/scanner/observe";
import { overlaySessionTitles } from "@/lib/session/titleProjection";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies: { observeFiles: typeof observeFiles; resolveSiblings: typeof resolveSiblings; registrySnapshot?: () => RegistryFile } = { observeFiles, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  const files = await dependencies.observeFiles();
  // Custom session titles (issue #33) are the last word on `title` for the agent
  // snapshot surface too — applied before siblings resolve and the snapshot
  // composes, so renamed conversations and their siblings show the human title.
  overlaySessionTitles(files);
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  /* `observeFiles` never appends spawn placeholder cards (#342), so visible
     `spawn:` paths must resolve against the durable registry here. */
  const registry = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  return composeSnapshot({ request: body, files, siblings, registry, scannerDurationMs: Date.now() - started });
}
