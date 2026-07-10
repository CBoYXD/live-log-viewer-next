import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { listFiles } from "@/lib/scanner";

import type { HistoryCopyPort, MigrationEngine, MigrationIntent, MigrationOrigin, ViewerConversationId } from "./contracts";
import { DisabledHistoryCopyPort } from "./contracts";

export interface MigrationPreview { total: number; idle: number; busy: number; revision: number; }

function engineOf(entry: Awaited<ReturnType<typeof listFiles>>[number]): MigrationEngine | null {
  return entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null;
}

export async function previewMigration(engine: MigrationEngine, registry: AgentRegistry = agentRegistry()): Promise<MigrationPreview> {
  const files = await listFiles();
  const matching = files.filter((entry) => engineOf(entry) === engine);
  for (const entry of matching) registry.ensureConversation(engine, entry.path, registry.conversationForPath(entry.path)?.generations.at(-1)?.accountId ?? null);
  const busy = matching.filter((entry) => entry.activity === "live" || entry.activity === "stalled").length;
  return { total: matching.length, busy, idle: matching.length - busy, revision: registry.engineRouting(engine).revision };
}

export async function createMigrationIntent(
  engine: MigrationEngine,
  targetId: string,
  origin: MigrationOrigin,
  requestId: string = crypto.randomUUID(),
  registry: AgentRegistry = agentRegistry(),
): Promise<{ intent: MigrationIntent; preview: MigrationPreview }> {
  const preview = await previewMigration(engine, registry);
  registry.setEngineRouting(engine, targetId);
  const intent = registry.upsertMigrationIntent(engine, targetId, origin, requestId);
  const files = await listFiles();
  for (const entry of files) {
    if (engineOf(entry) !== engine) continue;
    const conversation = registry.ensureConversation(engine, entry.path, registry.conversationForPath(entry.path)?.generations.at(-1)?.accountId ?? null);
    registry.setConversationMigration(conversation.id, {
      intentId: intent.id,
      phase: entry.activity === "live" || entry.activity === "stalled" ? "waiting-turn" : "requested",
      targetId,
      revision: intent.revision,
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return { intent, preview };
}

/** Executes only against an injected provider port. The default port is a
    deliberate disabled preflight and cannot start a native cross-home move. */
export async function advanceConversationMigration(
  conversationId: ViewerConversationId,
  registry: AgentRegistry = agentRegistry(),
  history: HistoryCopyPort = new DisabledHistoryCopyPort(),
): Promise<RegistryConversation> {
  const conversation = registry.conversation(conversationId);
  if (!conversation?.migration) throw new Error("conversation has no migration");
  const migration = conversation.migration;
  if (migration.phase === "waiting-turn") return conversation;
  const source = conversation.generations.at(-1);
  if (!source) throw new Error("conversation has no source generation");
  registry.setConversationMigration(conversation.id, { ...migration, phase: "preparing", updatedAt: new Date().toISOString() });
  try {
    registry.setConversationMigration(conversation.id, { ...migration, phase: "successor-starting", updatedAt: new Date().toISOString() });
    const successor = await history.copy({ engine: conversation.engine, sourcePath: source.path, targetHome: migration.targetId, conversationId: conversation.id });
    registry.setConversationMigration(conversation.id, { ...migration, phase: "verifying", updatedAt: new Date().toISOString() });
    return registry.commitSuccessor(conversation.id, { id: successor.nativeId, path: successor.path, accountId: migration.targetId }, migration.revision);
  } catch (error) {
    return registry.setConversationMigration(conversation.id, { ...migration, phase: "failed-recoverable", error: error instanceof Error ? error.message.slice(0, 500) : "migration failed", updatedAt: new Date().toISOString() });
  }
}

export function deliveryFence(conversation: RegistryConversation): "deliver" | "held" | "recoverable" {
  if (!conversation.migration) return "deliver";
  if (["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase)) return "held";
  if (conversation.migration.phase === "failed-recoverable") return "recoverable";
  return "deliver";
}
