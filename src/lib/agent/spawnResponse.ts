import type { SpawnReceipt } from "@/lib/agent/registry";
import type { SpawnAdmissionError, SpawnRejection, SpawnRejectionCode } from "@/lib/agent/spawnAdmission";

/** HTTP shape of a typed terminal admission rejection (#393). The receipt is
    durable; `error` carries the actionable guidance for the caller. */
export interface SpawnRejectionResponse {
  error: string;
  code: SpawnRejectionCode;
  launchId: string;
  conversationId: string;
  rejection: SpawnRejection;
}

export function spawnRejectionResponse(error: SpawnAdmissionError): SpawnRejectionResponse {
  return {
    error: error.rejection.guidance,
    code: error.rejection.code,
    launchId: error.receipt.launchId,
    conversationId: error.receipt.conversationId,
    rejection: error.rejection,
  };
}

export interface SpawnResponse {
  ok: true;
  target: string | null;
  /** Transcript path the fresh session will write, when knowable. */
  path: string | null;
  /** Effective Claude permission mode for pane-less launches. */
  effectivePermissionMode?: string;
  launchId: string;
  conversationId: string;
  launched: boolean;
  retrySafe: boolean;
  initialMessage: "pending" | "queued" | "delivered" | "failed";
  state: "settled" | "path-pending" | "starting" | "failed" | "conflict";
  error?: string;
}

export function spawnReplayStatus(response: SpawnResponse, structured: boolean): 200 | 202 {
  return response.state === "starting" || (structured && response.state === "path-pending") ? 202 : 200;
}

function initialMessageForReceipt(receipt: SpawnReceipt, structured: boolean): SpawnResponse["initialMessage"] {
  if (receipt.state === "failed" || receipt.state === "conflicted") return "failed";
  if (receipt.state === "completed" || receipt.state === "prompt-delivered") return "delivered";
  if (structured && receipt.state === "path-pending") return "queued";
  return "pending";
}

function responseStateForReceipt(receipt: SpawnReceipt): SpawnResponse["state"] {
  if (receipt.state === "conflicted") return "conflict";
  if (receipt.state === "failed") return "failed";
  if (receipt.state === "starting" || receipt.state === "pane-bound") return "starting";
  if (receipt.state === "host-verified" || receipt.state === "prompt-delivered" || receipt.state === "path-pending") {
    return "path-pending";
  }
  return "settled";
}

export function spawnResponseForReceipt(
  receipt: SpawnReceipt,
  path = receipt.artifactPath,
  options: { structured?: boolean; initialMessage?: SpawnResponse["initialMessage"] } = {},
): SpawnResponse {
  const structured = receipt.transport === "structured"
    || (receipt.transport === null && options.structured === true);
  const launched = (receipt.verifiedHost !== null || (options.structured === true && receipt.state === "completed"))
    && receipt.state !== "failed"
    && receipt.state !== "conflicted";
  return {
    ok: true,
    target: receipt.pane?.paneId ?? receipt.target ?? null,
    path,
    ...(structured && receipt.engine === "claude"
      ? { effectivePermissionMode: receipt.launchProfile.permissionMode ?? "default" }
      : {}),
    launchId: receipt.launchId,
    conversationId: receipt.conversationId,
    launched,
    retrySafe: receipt.state === "failed",
    initialMessage: options.initialMessage ?? initialMessageForReceipt(receipt, structured),
    ...(receipt.error ? { error: receipt.error } : {}),
    state: responseStateForReceipt(receipt),
  };
}
