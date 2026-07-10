import fs from "node:fs";

import type { FileEntry } from "@/lib/types";

import type { Pipeline } from "./types";

export function pipelineVisibleInProject(pipeline: Pipeline, project: string, files: readonly FileEntry[]): boolean {
  if (pipeline.state === "closed") return false;
  if (pipeline.project === project) return true;
  const paths = new Set(files.filter((file) => file.project === project).map((file) => file.path));
  return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && paths.has(attempt.agentPath))));
}

export function filterPipelinesForFileScan(pipelines: readonly Pipeline[], files: readonly FileEntry[]): Pipeline[] {
  const scanned = new Set(files.map((file) => file.path));
  return pipelines.filter((pipeline) => {
    if (pipeline.state === "closed") return false;
    if ((pipeline.repoDir && fs.existsSync(pipeline.repoDir)) || (pipeline.worktreeDir && fs.existsSync(pipeline.worktreeDir))) return true;
    return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && scanned.has(attempt.agentPath))));
  });
}
