import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";

import type { MigrationIntent } from "./contracts";
import { AUTO_BALANCE_COOLDOWN_MS, AUTO_BALANCE_SAMPLE_GAP_MS, chooseAutoBalance, type QuotaObservation } from "./quotaPolicy";

type Sustain = { signature: string; firstAt: number };
const sustained = new Map<string, Sustain>();

/** Evaluates only supplied structured quota observations. This controller has
    no login, credential, process, or provider mutation capability. */
export function evaluateAutoBalance(
  engine: "claude" | "codex",
  activeId: string,
  observations: QuotaObservation[],
  now = Date.now(),
  registry: AgentRegistry = agentRegistry(),
): MigrationIntent | null {
  const policy = registry.autoBalancePolicy(engine);
  const decision = chooseAutoBalance(engine, activeId, observations, policy, now);
  const key = `${engine}:${activeId}`;
  if (!decision) { sustained.delete(key); return null; }
  const signature = `${decision.targetId}:${decision.evidence.sourcePercent}:${decision.evidence.targetPercent}`;
  const previous = sustained.get(key);
  if (!previous || previous.signature !== signature) { sustained.set(key, { signature, firstAt: now }); return null; }
  if (now - previous.firstAt < AUTO_BALANCE_SAMPLE_GAP_MS) return null;
  sustained.delete(key);
  const intent = registry.upsertMigrationIntent(engine, decision.targetId, "auto", crypto.randomUUID(), decision.evidence);
  registry.setEngineRouting(engine, decision.targetId);
  registry.setAutoBalancePolicy(engine, policy.enabled, policy.revision);
  return intent;
}

export function completeAutoBalanceIntent(engine: "claude" | "codex", intentId: string, outcome: "complete" | "stopped" | "failed-partial", now = Date.now(), registry: AgentRegistry = agentRegistry()): void {
  registry.setMigrationIntentState(intentId, outcome === "stopped" ? "stopped" : "complete");
  const snapshot = registry.snapshot();
  registry.recordAutoBalanceOutcome(engine, outcome, snapshot.migrationIntents[intentId]?.evidence ?? null, new Date(now + AUTO_BALANCE_COOLDOWN_MS).toISOString());
}
