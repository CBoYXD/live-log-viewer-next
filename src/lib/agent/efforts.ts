/**
 * Reasoning tiers each engine's CLI accepts, shared by the spawn UI, the API
 * validation and the command builders. Client-safe on purpose (no node:*
 * imports) — cli.ts re-exports it for server callers.
 *
 * claude: `--effort <level>` per `claude --help`.
 * codex: `-c model_reasoning_effort=<level>`; the tier list mirrors
 * `supported_reasoning_levels` in ~/.codex/models_cache.json for current models.
 */
export type AgentEngineName = "claude" | "codex";

export const ENGINE_EFFORTS: Record<AgentEngineName, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
};

export function isEngineEffort(engine: AgentEngineName, value: string): boolean {
  return (ENGINE_EFFORTS[engine] as readonly string[]).includes(value);
}

/** Validates the optional effort/fast fields of a spawn request body. An
    invalid effort is a client error, not something to drop silently; fast is
    meaningful for codex only and stays unset elsewhere. */
export function reasoningFromBody(
  engine: AgentEngineName,
  body: { effort?: unknown; fast?: unknown },
): { effort: string | null; fast: boolean | null; error?: string } {
  const rawEffort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (rawEffort && !isEngineEffort(engine, rawEffort)) {
    return { effort: null, fast: null, error: `effort for ${engine} must be one of: ${ENGINE_EFFORTS[engine].join(", ")}` };
  }
  const fast = engine === "codex" && typeof body.fast === "boolean" ? body.fast : null;
  return { effort: rawEffort || null, fast };
}
