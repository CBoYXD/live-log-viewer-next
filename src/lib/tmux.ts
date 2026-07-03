import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listFiles } from "@/lib/scanner";
import { pidAlive } from "@/lib/scanner/process";

const TMUX = "tmux";
const PROC = "/proc";
const PANE_MAP_TTL_MS = 5_000;
const MAX_ANCESTRY_HOPS = 64;
const INBOX_DIR = path.join(os.homedir(), ".claude", "viewer-inbox");

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A resolved tmux target in `session:window.pane` form (e.g. `0:1.0`). */
export type TmuxTarget = string;

let paneMemo: { at: number; map: Map<number, TmuxTarget> } | null = null;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs tmux with an explicit argv (no shell) and optional stdin payload. */
function runTmux(args: string[], input?: Buffer | string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TMUX, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Parent pid of `pid` from /proc/<pid>/stat, tolerant of parens in comm. */
function parentPid(pid: number): number | null {
  let stat: string;
  try {
    stat = fs.readFileSync(path.join(PROC, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const ppid = Number(afterComm[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** pane_pid → target map from `tmux list-panes -a`, memoised for a few seconds. */
async function panePidMap(): Promise<Map<number, TmuxTarget>> {
  const now = Date.now();
  if (paneMemo && now - paneMemo.at < PANE_MAP_TTL_MS) return paneMemo.map;

  const map = new Map<number, TmuxTarget>();
  let result: RunResult;
  try {
    result = await runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index} #{pane_pid}",
    ]);
  } catch {
    paneMemo = { at: now, map };
    return map;
  }
  if (result.code === 0) {
    for (const line of result.stdout.split("\n")) {
      const sep = line.lastIndexOf(" ");
      if (sep < 0) continue;
      const target = line.slice(0, sep).trim();
      const panePid = Number(line.slice(sep + 1).trim());
      if (target && Number.isInteger(panePid) && panePid > 0) map.set(panePid, target);
    }
  }
  paneMemo = { at: now, map };
  return map;
}

/**
 * Walks the /proc ppid chain up from `pid` until it lands on a tmux pane pid.
 * Returns the pane target the process lives in, or null when it is outside tmux.
 */
export async function resolveTarget(pid: number): Promise<TmuxTarget | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const panes = await panePidMap();
  if (panes.size === 0) return null;

  const seen = new Set<number>();
  let cursor: number | null = pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && cursor !== null && cursor > 1; hop += 1) {
    const hit = panes.get(cursor);
    if (hit) return hit;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parentPid(cursor);
  }
  return null;
}

/**
 * Scanner-known pids that are currently running. The web caller may only target
 * one of these — an arbitrary pid from the request is never trusted directly.
 */
export async function knownLivePids(): Promise<Set<number>> {
  const pids = new Set<number>();
  for (const entry of await listFiles()) {
    const interactiveLive =
      entry.activity === "live" && (entry.root === "claude-projects" || entry.root === "codex-sessions");
    if (entry.pid !== null && pidAlive(entry.pid) && (entry.proc === "running" || interactiveLive)) pids.add(entry.pid);
  }
  return pids;
}

/**
 * Pushes `text` into the pane, then presses Enter. A dedicated tmux buffer plus
 * paste-buffer carries multi-line payloads reliably where send-keys would not.
 */
export async function sendText(target: TmuxTarget, text: string): Promise<void> {
  const bufferName = `viewer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const load = await runTmux(["load-buffer", "-b", bufferName, "-"], Buffer.from(text, "utf8"));
  if (load.code !== 0) throw new Error(load.stderr.trim() || "не вдалося завантажити буфер tmux");

  const paste = await runTmux(["paste-buffer", "-d", "-b", bufferName, "-t", target]);
  if (paste.code !== 0) throw new Error(paste.stderr.trim() || "не вдалося вставити текст у пейн");

  const enter = await runTmux(["send-keys", "-t", target, "Enter"]);
  if (enter.code !== 0) throw new Error(enter.stderr.trim() || "не вдалося натиснути Enter");
}

export interface SavedImage {
  path: string;
}

/** Stores a pasted clipboard image under the viewer inbox and returns its path. */
export function saveInboxImage(base64: string, mime: string): SavedImage {
  const ext = IMAGE_EXT[mime] ?? "png";
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filePath = path.join(INBOX_DIR, `img-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return { path: filePath };
}
