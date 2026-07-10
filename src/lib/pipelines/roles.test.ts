import { expect, test } from "bun:test";

import { resolvePipelineRole } from "./roles";

test("role references resolve registry defaults and stage overrides", () => {
  const lookup = () => ({ engine: "codex" as const, model: "terra", effort: "high", access: "read-write" as const });
  expect(resolvePipelineRole({ roleId: "builder", effort: "low" }, "run", lookup).role).toEqual({
    roleId: "builder",
    engine: "codex",
    model: "terra",
    effort: "low",
    access: "read-write",
  });
});

test("explicit engine is the current-main fallback for an unresolved role", () => {
  expect(resolvePipelineRole({ roleId: "builder", engine: "claude", model: "opus" }, "run", null).role).toMatchObject({
    roleId: "builder",
    engine: "claude",
    model: "opus",
    access: "read-write",
  });
  expect(resolvePipelineRole({ roleId: "builder" }, "run", null).error).toContain("provide an explicit engine");
});

test("review-loop roles default to read-only access", () => {
  expect(resolvePipelineRole({ roleId: "reviewer", engine: "codex" }, "review-loop", null).role?.access).toBe("read-only");
  expect(resolvePipelineRole({ roleId: "reviewer", engine: "codex", access: "read-write" }, "review-loop", null).error).toBe("review-loop stages require read-only access");
});

test("role references stay inside the eight-role registry", () => {
  expect(resolvePipelineRole({ roleId: "implementer", engine: "codex" } as never, "run", null).error).toBe("unknown pipeline role: implementer");
});
