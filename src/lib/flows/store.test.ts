import { expect, test } from "bun:test";

import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";

import { mergeSeededPresets } from "./store";
import type { FlowPreset } from "./types";

const LEGACY_DEFAULT: FlowPreset = {
  name: "Codex high → Fable",
  implementer: { engine: "codex", model: null, effort: "high" },
  reviewer: { engine: "claude", model: "fable", effort: null },
};

test("seed migration replaces an untouched legacy preset with Terra and Sol roles", () => {
  const presets = mergeSeededPresets([LEGACY_DEFAULT]);
  expect(presets.some((preset) => preset.name === LEGACY_DEFAULT.name)).toBe(false);
  expect(presets[0]).toEqual({
    name: "Terra high → Sol xhigh",
    implementer: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "high" },
    reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
  });
});

test("seed migration preserves a customized preset", () => {
  const custom = { ...LEGACY_DEFAULT, reviewer: { engine: "claude" as const, model: "fable", effort: "max" } };
  expect(mergeSeededPresets([custom])).toContainEqual(custom);
});
