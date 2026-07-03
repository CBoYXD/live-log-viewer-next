import fs from "node:fs";

import type { Activity, RootKey } from "../types";
import { globalCache } from "./caches";
import { numberValue, readJson, recordValue, recordsValue, stringValue } from "./json";
import { outputHolders, pidAlive } from "./process";

const turnCache = globalCache<[number, string | null]>("turn");

export function tailRecords(pathname: string, size: number, nbytes = 131_072) {
  let data: string;
  let seek = 0;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      seek = Math.max(0, size - nbytes);
      const buf = Buffer.alloc(Math.max(0, size - seek));
      fs.readSync(fd, buf, 0, buf.length, seek);
      data = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  let lines = data.split("\n");
  if (seek > 0 && lines.length) lines = lines.slice(1);
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    } catch {
      /* skip malformed tail rows */
    }
  }
  return out;
}

function jsonlTurnState(pathname: string, size: number, codex: boolean) {
  for (const obj of tailRecords(pathname, size).reverse()) {
    if (codex) {
      const payload = recordValue(obj.payload) ?? {};
      const pt = stringValue(payload.type);
      if (obj.type === "session_meta" || pt === "token_count" || pt === "reasoning" || pt === null) {
        continue;
      }
      if (pt === "agent_message" || pt === "task_complete" || pt === "turn_complete") return "done";
      if (pt === "message") return payload.role === "assistant" ? "done" : "busy";
      return "busy";
    }
    const t = obj.type;
    if (t === "assistant") {
      const parts = recordsValue(recordValue(obj.message)?.content);
      const kinds = parts.map((part) => part.type);
      if (kinds.includes("tool_use")) return "busy";
      if (parts.some((part) => part.type === "text" && (stringValue(part.text) ?? "").trim())) {
        return "done";
      }
      return "busy";
    }
    if (t === "user") return "busy";
  }
  return null;
}

export function activity(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
  job: Record<string, unknown> | null = null,
): Activity {
  const age = Date.now() / 1000 - mtime;
  if (root === "codex-jobs") {
    const jobJson = job ?? readJson(pathname.replace(/\.log$/, ".json"));
    if (jobJson) {
      if (jobJson.status === "running") {
        const pid = numberValue(jobJson.pid);
        return pid !== null && pidAlive(pid) ? "live" : age < 900 ? "recent" : "idle";
      }
      return age < 900 ? "recent" : "idle";
    }
  }
  if (root === "claude-tasks" && pathname.endsWith(".output")) {
    if (outputHolders().has(pathname)) return "live";
    return age < 900 ? "recent" : "idle";
  }
  if (pathname.endsWith(".jsonl")) {
    const cached = turnCache.get(pathname);
    let state: string | null;
    if (cached?.[0] === size) state = cached[1];
    else {
      state = jsonlTurnState(pathname, size, root.startsWith("codex"));
      turnCache.set(pathname, [size, state]);
    }
    if (state === "busy") return age < 180 ? "live" : "stalled";
    if (state === "done") return age < 900 ? "recent" : "idle";
  }
  if (age < 20) return "live";
  if (age < 900) return "recent";
  return "idle";
}
