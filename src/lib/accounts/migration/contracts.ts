import type { AgentEngine } from "@/lib/agent/cli";

export type MigrationEngine = Extract<AgentEngine, "claude" | "codex">;
export type ViewerConversationId = `conversation_${string}`;
export type MigrationOrigin = "manual" | "auto";
export type MigrationPhase = "requested" | "waiting-turn" | "preparing" | "successor-starting" | "verifying" | "committed" | "failed-recoverable" | "rolled-back";
export type MigrationIntentState = "draining" | "complete" | "stopped";

export interface NativeGeneration {
  id: string;
  path: string;
  accountId: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface ConversationMigration {
  intentId: string;
  phase: MigrationPhase;
  targetId: string;
  revision: number;
  error: string | null;
  updatedAt: string;
}

export interface MigrationEvidence {
  sourceId: string;
  sourcePercent: number;
  sourceWindow: "session" | "weekly";
  targetId: string;
  targetPercent: number;
  targetWindow: "session" | "weekly";
  observedAt: string;
}

export interface MigrationIntent {
  id: string;
  engine: MigrationEngine;
  targetId: string;
  origin: MigrationOrigin;
  revision: number;
  state: MigrationIntentState;
  createdAt: string;
  updatedAt: string;
  requestIds: string[];
  evidence: MigrationEvidence | null;
  stoppedAt: string | null;
}

export interface AutoBalancePolicy {
  enabled: boolean;
  revision: number;
  cooldownUntil: string | null;
  departed: Record<string, string>;
  lastOutcome: "complete" | "stopped" | "failed-partial" | null;
  lastTrigger: MigrationEvidence | null;
  restartedAt: string;
}

export interface TurnState {
  state: "busy" | "terminal" | "unknown";
  source: "lifecycle" | "tool" | "assistant" | "empty";
  terminalAt: string | null;
}

export interface HeldDelivery {
  id: string;
  conversationId: ViewerConversationId;
  text: string;
  createdAt: string;
  clientMessageId: string | null;
}

export interface HistoryCopyPort {
  copy(input: { engine: MigrationEngine; sourcePath: string; targetHome: string; conversationId: ViewerConversationId }): Promise<{ nativeId: string; path: string }>;
}

/** Native cross-home copying is deliberately gated. Production enables a
    provider port only after an explicit authentication preflight succeeds. */
export class DisabledHistoryCopyPort implements HistoryCopyPort {
  async copy(): Promise<{ nativeId: string; path: string }> {
    throw new Error("native cross-home migration is disabled pending an explicit authenticated preflight");
  }
}
