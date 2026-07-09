import { expect, test } from "bun:test";

import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL, defaultModelFor, ENGINE_MODELS, modelFromBody } from "./models";

test("the Codex catalog exposes Sol for review and Terra for implementation", () => {
  expect(ENGINE_MODELS.codex).toEqual([
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", use: "implement" },
  ]);
  expect(defaultModelFor("codex")).toBe(CODEX_SOL_MODEL);
  expect(defaultModelFor("claude")).toBe("");
});

test("spawn model validation accepts CLI ids and rejects control characters", () => {
  expect(modelFromBody({ model: " gpt-5.6-terra " })).toEqual({ model: CODEX_TERRA_MODEL });
  expect(modelFromBody({})).toEqual({ model: null });
  expect(modelFromBody({ model: "terra\n--help" }).error).toBeDefined();
});
