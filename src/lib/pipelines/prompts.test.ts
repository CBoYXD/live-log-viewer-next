import { expect, test } from "bun:test";

import { buildPipeline } from "./store";
import { renderStagePrompt } from "./prompts";
import type { PipelineStage } from "./types";

test("run prompt renders task, previous output, spec, access, verdict, and nesting contracts", () => {
  const stage: PipelineStage = {
    id: "build",
    kind: "run" as const,
    role: { roleId: "builder", engine: "codex" as const },
    prompt: "Build {{task}} from {{prev.output}}",
    next: "review",
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    spec: "AC1: structured verdict",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage, { ...stage, id: "review", next: null }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write" }, "the plan");
  expect(prompt).toContain("Build pipeline support from the plan");
  expect(prompt).toContain("AC1: structured verdict");
  expect(prompt).toContain("Access: read-write");
  expect(prompt).toContain('"status":"pass"');
  expect(prompt).toContain("Pipeline nesting is forbidden");
});
