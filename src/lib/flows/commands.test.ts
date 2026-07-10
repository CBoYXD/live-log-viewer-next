import { expect, test } from "bun:test";

import { normalizeFlowSpec } from "./commands";

test("flow spec request accepts trimmed text and rejects non-text input", () => {
  expect(normalizeFlowSpec("  Add reviewer context\nAC1: Include it every round  ")).toEqual({
    ok: true,
    spec: "Add reviewer context\nAC1: Include it every round",
  });
  expect(normalizeFlowSpec(undefined)).toEqual({ ok: true });
  expect(normalizeFlowSpec(["AC1"])).toEqual({ ok: false });
});
