/** Curated model choices shown by the viewer's agent-launch surfaces. */
export type AgentModelOption = {
  id: string;
  label: string;
  use: "implement" | "review" | "general";
};

export const CODEX_SOL_MODEL = "gpt-5.6-sol";
export const CODEX_TERRA_MODEL = "gpt-5.6-terra";

export const ENGINE_MODELS: Record<"claude" | "codex", readonly AgentModelOption[]> = {
  claude: [
    { id: "fable", label: "Fable", use: "review" },
    { id: "opus", label: "Opus", use: "general" },
    { id: "sonnet", label: "Sonnet", use: "implement" },
    { id: "haiku", label: "Haiku", use: "general" },
  ],
  codex: [
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", use: "implement" },
  ],
};

/** A fresh Codex conversation starts on the architecture/review profile. */
export function defaultModelFor(engine: "claude" | "codex"): string {
  return engine === "codex" ? CODEX_SOL_MODEL : "";
}

/** Model ids travel to a shell-quoted CLI argument. Keep them bounded and printable. */
export function modelFromBody(body: { model?: unknown }): { model: string | null; error?: string } {
  if (body.model === undefined || body.model === null || body.model === "") return { model: null };
  if (typeof body.model !== "string") return { model: null, error: "model must be a string" };
  const model = body.model.trim();
  if (!model) return { model: null };
  if (model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) {
    return { model: null, error: "model must be a printable id up to 128 characters" };
  }
  return { model };
}
