import { describe, expect, test } from "bun:test";

import { contextUsage, resolveContextWindow } from "./context";

describe("resolveContextWindow", () => {
  test("uses the window reported by a Codex rollout", () => {
    expect(resolveContextWindow({ engine: "codex", model: "gpt-5.6-sol", reportedWindow: 353_000 })).toBe(353_000);
  });

  test("does not guess a Codex window when the rollout omits it", () => {
    expect(resolveContextWindow({ engine: "codex", model: "gpt-5.6-sol" })).toBeNull();
  });

  test("resolves current Claude models from their documented defaults", () => {
    expect(resolveContextWindow({ engine: "claude", model: "claude-opus-4-8" })).toBe(1_000_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-sonnet-4-6" })).toBe(1_000_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-fable-5" })).toBe(1_000_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-haiku-4-5-20251001" })).toBe(200_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-sonnet-4-5-20250929" })).toBe(200_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-3-5-sonnet-20241022" })).toBe(200_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-3-opus-20240229" })).toBe(200_000);
  });

  test("recognizes explicit 1M modes on historical Claude models", () => {
    expect(resolveContextWindow({ engine: "claude", model: "claude-sonnet-4-5[1m]" })).toBe(1_000_000);
    expect(resolveContextWindow({ engine: "claude", model: "claude-sonnet-4-5", modes: ["context-1m-2025-08-07"] })).toBe(1_000_000);
  });

  test("leaves an unrecognized Claude model unresolved", () => {
    expect(resolveContextWindow({ engine: "claude", model: "claude-future-9" })).toBeNull();
    expect(resolveContextWindow({ engine: "claude", model: null })).toBeNull();
  });
});

describe("contextUsage", () => {
  test("rounds usage against the resolved window", () => {
    expect(contextUsage(176_000, 353_000)).toEqual({ usedTokens: 176_000, windowTokens: 353_000, pct: 50 });
  });

  test("keeps usage visible while the window and percent are unknown", () => {
    expect(contextUsage(176_000, null)).toEqual({ usedTokens: 176_000, windowTokens: null, pct: null });
  });

  test("rejects empty usage and invalid windows", () => {
    expect(contextUsage(0, 200_000)).toBeNull();
    expect(contextUsage(100, 0)).toEqual({ usedTokens: 100, windowTokens: null, pct: null });
  });
});
