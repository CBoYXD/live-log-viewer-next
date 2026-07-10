import { recordValue, stringValue } from "@/lib/scanner/json";

import type { TurnState } from "./contracts";

type RecordLike = Record<string, unknown>;

function timestamp(record: RecordLike): string | null {
  const value = record.timestamp;
  return typeof value === "string" ? value : null;
}

/** The newest authoritative lifecycle or tool event wins. Assistant prose
    cannot close an active turn because it commonly precedes tool work. */
export function turnStateFromRecords(records: RecordLike[], codex: boolean): TurnState {
  for (const record of [...records].reverse()) {
    if (codex) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type);
      if (type === "task_complete" || type === "turn_complete" || type === "turn_aborted") {
        return { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      }
      if (type === "task_started" || type === "turn_started" || type === "user_message") {
        return { state: "busy", source: "lifecycle", terminalAt: null };
      }
      if (type === "agent_message") continue;
      if (type?.includes("tool") || type?.includes("function") || type?.includes("command") || type === "message") {
        return { state: "busy", source: "tool", terminalAt: null };
      }
      continue;
    }
    if (record.type === "assistant") {
      const stop = stringValue((recordValue(record.message) ?? {}).stop_reason);
      if (stop === "end_turn" || stop === "stop_sequence") return { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      return { state: "busy", source: "assistant", terminalAt: null };
    }
    if (record.type === "user") return { state: "busy", source: "lifecycle", terminalAt: null };
  }
  return { state: "unknown", source: "empty", terminalAt: null };
}
