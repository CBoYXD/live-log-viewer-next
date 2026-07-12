import type {
  AgentHostStatus,
  AgentRegistry,
  AgentRegistryEntry,
  StructuredHostColumns,
} from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";

import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import type { HostState } from "./engineHost";

export function structuredHostsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_STRUCTURED_HOSTS === "1";
}

export async function startCodexStructuredHost(
  options: CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexAppServerHost> {
  if (!structuredHostsEnabled(env)) throw new Error("structured hosts are disabled");
  return CodexAppServerHost.start(options);
}

function registryStatus(state: HostState): AgentHostStatus {
  if (state.status === "active" || state.status === "attention") return "live";
  if (state.status === "idle") return "idle";
  if (state.status === "unhosted") return "unhosted";
  return "dead";
}

export function codexHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "codex-app-server",
    endpoint: state.endpoint,
    process: state.pid === null ? null : { pid: state.pid, startIdentity: state.processStartIdentity },
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
  };
}

export async function persistCodexHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  writerClaimEpoch: number,
): Promise<AgentRegistryEntry> {
  const state = await host.health();
  return registry.setStructuredHost(key, codexHostColumns(state, writerClaimEpoch), registryStatus(state));
}

export interface AdoptedCodexHost {
  key: SessionKey;
  host: CodexAppServerHost;
}

/** Boot seam: resume every durable Codex row when structured hosting is enabled. */
export async function adoptCodexRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdoptedCodexHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.snapshot().entries).filter((entry) =>
    entry.key.engine === "codex" && entry.structuredHost?.kind === "codex-app-server");
  const adopted: AdoptedCodexHost[] = [];
  for (const entry of rows) {
    try {
      const host = await CodexAppServerHost.adopt(entry.key.sessionId, {
        ...optionsFor(entry),
        initialEventCursor: entry.structuredHost?.eventCursor ?? 0,
      });
      await persistCodexHost(registry, entry.key, host, entry.structuredHost?.writerClaimEpoch ?? entry.claimEpoch);
      adopted.push({ key: entry.key, host });
    } catch {
      const prior = entry.structuredHost!;
      registry.setStructuredHost(entry.key, { ...prior, endpoint: "stdio:released", process: null, activeTurnRef: null }, "dead");
    }
  }
  return adopted;
}
