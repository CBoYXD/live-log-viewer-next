import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/**
 * Append-only NDJSON log of viewer operations (spawn, send, interrupt, kill,
 * gate hits, answer deliveries, flow transitions). The upstream tmux
 * orchestrators that survive in practice all keep such a sidecar trail — pane
 * scraping and TUI drift make failures otherwise unreproducible. Reading it
 * is a human/debugging affair; nothing in the viewer parses it back.
 */
const EVENTS_FILE = statePath("events.ndjson");
const ROTATE_BYTES = 4 * 1024 * 1024;

export type ViewerEventAction =
  | "spawn"
  | "resume"
  | "send"
  | "interrupt"
  | "kill"
  | "gate"
  | "answer"
  | "flow";

export interface ViewerEventFields {
  /** tmux target the action addressed, when known. */
  target?: string;
  /** Transcript path the action belongs to, when known. */
  path?: string;
  cwd?: string;
  result: "ok" | "error";
  /** Status/gate reason or a sanitized error message. */
  reason?: string;
  meta?: Record<string, string | number | boolean | null>;
}

/** Best-effort append; a failed write must never break the user-facing action. */
export function logEvent(action: ViewerEventAction, fields: ViewerEventFields): void {
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    try {
      if (fs.statSync(EVENTS_FILE).size > ROTATE_BYTES) {
        fs.renameSync(EVENTS_FILE, EVENTS_FILE + ".1");
      }
    } catch {
      /* first write */
    }
    const record = { ts: new Date().toISOString(), action, ...fields };
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* logging is advisory */
  }
}
