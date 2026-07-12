import type { CtxUsage, FileEntry } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { numberValue, recordValue, stringValue } from "./json";

const ctxCache = globalCache<[number, CtxUsage | null]>("ctx");

/** Claude API defaults documented at
    https://platform.claude.com/docs/en/build-with-claude/context-windows.
    Keep this allowlist versioned: an unknown future id must remain unknown. */
const CLAUDE_WINDOW = 200_000;
const CLAUDE_WINDOW_1M = 1_000_000;

const CLAUDE_1M_MODE = "context-1m-2025-08-07";
const CLAUDE_1M_MODELS = [
  /(?:^|-)fable(?:-|$)/,
  /(?:^|-)mythos(?:-|$)/,
  /(?:^|-)opus-4-(?:6|7|8)(?:-|$)/,
  /(?:^|-)sonnet-(?:5|4-6)(?:-|$)/,
] as const;
const CLAUDE_200K_MODELS = [
  /(?:^|-)haiku-(?:3|3-5|4-5)(?:-|$)/,
  /(?:^|-)opus-(?:3|3-5|4|4-0|4-1|4-5)(?:-|$)/,
  /(?:^|-)sonnet-(?:3|3-5|3-7|4|4-0|4-5)(?:-|$)/,
  /(?:^|-)3(?:-5|-7)?-haiku(?:-|$)/,
  /(?:^|-)3(?:-5)?-opus(?:-|$)/,
  /(?:^|-)3(?:-5|-7)?-sonnet(?:-|$)/,
] as const;

export interface ContextWindowQuery {
  engine: "claude" | "codex";
  model: string | null;
  /** Engine-reported value. Codex token_count rollouts populate this. */
  reportedWindow?: number | null;
  /** Explicit request/transcript modes, including Anthropic beta names. */
  modes?: readonly string[];
}

export function resolveContextWindow(query: ContextWindowQuery): number | null {
  if (query.reportedWindow && query.reportedWindow > 0) return query.reportedWindow;
  if (query.engine === "codex") return null;
  const model = query.model?.toLowerCase().trim();
  if (!model) return null;
  if (model.includes("[1m]") || query.modes?.some((mode) => mode.toLowerCase().includes(CLAUDE_1M_MODE))) {
    return CLAUDE_WINDOW_1M;
  }
  const normalized = model.replaceAll("[1m]", "");
  if (CLAUDE_1M_MODELS.some((pattern) => pattern.test(normalized))) return CLAUDE_WINDOW_1M;
  if (CLAUDE_200K_MODELS.some((pattern) => pattern.test(normalized))) return CLAUDE_WINDOW;
  return null;
}

export function contextUsage(usedTokens: number | null, windowTokens: number | null): CtxUsage | null {
  if (usedTokens === null || usedTokens <= 0) return null;
  const window = windowTokens !== null && windowTokens > 0 ? windowTokens : null;
  return {
    usedTokens,
    windowTokens: window,
    pct: window === null ? null : Math.min(100, Math.round((usedTokens / window) * 100)),
  };
}

/** Codex: token_count events carry per-request usage plus the model context
    window — the numbers behind the TUI footer «Context N% used». The last
    request's total (prompt incl. cache reads + output) is the current context
    size; the cumulative total_token_usage overshoots across turns. */
function codexCtx(obj: Record<string, unknown>): CtxUsage | null {
  const payload = recordValue(obj.payload);
  if (!payload || stringValue(payload.type) !== "token_count") return null;
  const info = recordValue(payload.info);
  if (!info) return null;
  const usage = recordValue(info.last_token_usage) ?? recordValue(info.total_token_usage);
  if (!usage) return null;
  const window = resolveContextWindow({
    engine: "codex",
    model: null,
    reportedWindow: numberValue(info.model_context_window),
  });
  return contextUsage(numberValue(usage.total_tokens), window);
}

/** Claude: the newest assistant record's message.usage. Context size is the
    full prompt of that call: fresh input + cache reads + cache writes. */
function claudeCtx(obj: Record<string, unknown>): CtxUsage | null {
  if (obj.type !== "assistant") return null;
  const message = recordValue(obj.message);
  const model = stringValue(message?.model);
  if (!message || model === "<synthetic>") return null;
  const usage = recordValue(message.usage);
  if (!usage) return null;
  const used =
    (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0);
  const modes = [obj.beta, obj.betas, message.beta, message.betas]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string");
  const window = resolveContextWindow({ engine: "claude", model: model ?? null, modes });
  return contextUsage(used, window);
}

/**
 * Context-window fullness from the newest usage record in the transcript
 * tail. Size-keyed cache like turn state — no reads beyond the tail, and an
 * unchanged file costs nothing. Tails with no usage record return null (the
 * chip disappears rather than showing a stale number).
 */
export function ctxFor(entry: FileEntry): CtxUsage | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const cached = ctxCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1];

  let ctx: CtxUsage | null = null;
  for (const obj of tailRecords(entry.path, entry.size).reverse()) {
    ctx = entry.root === "codex-sessions" ? codexCtx(obj) : claudeCtx(obj);
    if (ctx) break;
  }
  ctxCache.set(entry.path, [entry.size, ctx]);
  return ctx;
}
