import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listFiles } from "@/lib/scanner";
import { isHelperArgv, pidAlive, readArgv } from "@/lib/scanner/process";

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

export const MAX_INBOX_IMAGE_BYTES = 10 * 1024 * 1024;

/** File extension for a whitelisted inbox image mime, or null when unsupported. */
export function inboxImageExt(mime: string): string | null {
  return IMAGE_EXT[mime] ?? null;
}

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
 * Returns the pane target the process lives in, or null when it is outside
 * tmux. The walk stops at claude daemon/pty helpers: a session hosted under
 * the background daemon has no pane of its own, and continuing upward would
 * hit the pane of whichever agent started the daemon — send-keys would then
 * type into that unrelated agent.
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
    if (seen.has(cursor) || isHelperArgv(readArgv(cursor))) break;
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
    if (entry.pid !== null && entry.proc === "running" && pidAlive(entry.pid)) pids.add(entry.pid);
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

/**
 * The tmux session the user is actually looking at: the attached client with
 * the freshest activity wins; a detached server falls back to the most recent
 * session; no server at all yields a fresh detached «agents» session.
 */
export async function activeTmuxSession(): Promise<string> {
  const clients = await runTmux(["list-clients", "-F", "#{client_activity} #{client_session}"]).catch(() => null);
  const pick = (stdout: string) => {
    let best: { at: number; name: string } | null = null;
    for (const line of stdout.split("\n")) {
      const sep = line.indexOf(" ");
      if (sep < 0) continue;
      const at = Number(line.slice(0, sep));
      const name = line.slice(sep + 1).trim();
      if (name && Number.isFinite(at) && (!best || at > best.at)) best = { at, name };
    }
    return best?.name ?? null;
  };
  if (clients && clients.code === 0) {
    const name = pick(clients.stdout);
    if (name) return name;
  }
  const sessions = await runTmux(["list-sessions", "-F", "#{session_activity} #{session_name}"]).catch(() => null);
  if (sessions && sessions.code === 0) {
    const name = pick(sessions.stdout);
    if (name) return name;
  }
  const created = await runTmux(["new-session", "-d", "-s", "agents"]);
  if (created.code !== 0 && !/duplicate session/.test(created.stderr)) {
    throw new Error(created.stderr.trim() || "не вдалося створити tmux-сесію");
  }
  return "agents";
}

/** Absolute path of an agent CLI when we can find one; bare name otherwise. */
function resolveBinary(name: string): string {
  const home = os.homedir();
  /* ~/.bun/bin goes first: on this machine the system-wide /usr/bin/claude is
     an npm install that crashes under the current Node, while the bun shim is
     the CLI the user actually runs. */
  for (const candidate of [
    path.join(home, ".bun", "bin", name),
    path.join(home, ".npm-global", "bin", name),
    path.join(home, ".local", "bin", name),
    path.join(home, "go", "bin", name),
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return name;
}

/** Scans the head of a transcript for the session working directory. */
function transcriptCwd(pathname: string): string {
  try {
    const lines = fs.readFileSync(pathname, "utf8").split("\n").slice(0, 30);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const direct = typeof obj.cwd === "string" ? obj.cwd : null;
        const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : null;
        const nested = payload && typeof payload.cwd === "string" ? (payload.cwd as string) : null;
        const cwd = direct ?? nested;
        if (cwd && fs.existsSync(cwd)) return cwd;
      } catch {
        /* skip malformed head rows */
      }
    }
  } catch {
    /* unreadable transcript */
  }
  return os.homedir();
}

export interface ResumeSpec {
  command: string;
  cwd: string;
  windowName: string;
}

/**
 * Shell command that reopens a finished conversation interactively so a new
 * prompt can be typed into it. Claude subagent transcripts have no resumable
 * session of their own, so only root session files qualify.
 */
export function resumeSpecFor(root: string, pathname: string): ResumeSpec | null {
  const base = path.basename(pathname);
  if (root === "claude-projects" && base.endsWith(".jsonl") && !pathname.includes(path.sep + "subagents" + path.sep)) {
    const sid = base.slice(0, -".jsonl".length);
    if (!/^[0-9a-f-]{36}$/.test(sid)) return null;
    return {
      command: `${resolveBinary("claude")} --dangerously-skip-permissions --resume ${sid}`,
      cwd: transcriptCwd(pathname),
      windowName: "claude-resume",
    };
  }
  if (root === "codex-sessions" && base.endsWith(".jsonl")) {
    const id = base.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) return null;
    return {
      command: `${resolveBinary("codex")} resume ${id}`,
      cwd: transcriptCwd(pathname),
      windowName: "codex-resume",
    };
  }
  return null;
}

const SPAWN_READY_TIMEOUT_MS = 60_000;
const SPAWN_POLL_MS = 1_000;
const SPAWN_STABLE_ROUNDS = 3;
const SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "dash"]);
/* Bottom-bar hints both CLIs draw once their composer accepts input. */
const READY_MARKERS = /\? for shortcuts|bypass permissions on|Press up to edit|⏎ send/;
const CLAUDE_RESUME_PICKER = /Resume from summary/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paneCommand(target: TmuxTarget): Promise<string | null> {
  const res = await runTmux(["display-message", "-p", "-t", target, "#{pane_current_command}"]).catch(() => null);
  return res && res.code === 0 ? res.stdout.trim() : null;
}

async function paneScreen(target: TmuxTarget): Promise<string> {
  const res = await runTmux(["capture-pane", "-p", "-t", target]).catch(() => null);
  return res && res.code === 0 ? res.stdout : "";
}

function screenTail(screen: string): string {
  return screen.split("\n").filter((line) => line.trim()).slice(-3).join(" | ").slice(0, 300);
}

/**
 * Opens a new window in the user's current tmux session, boots the resumed
 * agent there, waits until the CLI is actually accepting input, then pastes
 * the text. The window runs the login shell and the agent command is typed
 * into it, so the pane survives even when the agent CLI exits early — a window
 * created with the agent as its direct command would close on exit and the
 * later paste would fail with "can't find window".
 *
 * Readiness is polled instead of a fixed delay: `claude --resume` on a large
 * session first shows a «Resume from summary» picker, which this answers with
 * Enter (summary resume). Pasting only happens once the foreground process is
 * the agent CLI — a pane that fell back to the shell would otherwise execute
 * the prompt text as a shell command.
 */
export async function spawnAgentWithPrompt(spec: ResumeSpec, text: string): Promise<TmuxTarget> {
  const session = await activeTmuxSession();
  const spawned = await runTmux([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}",
    "-t",
    session + ":",
    "-n",
    spec.windowName,
    "-c",
    spec.cwd,
  ]);
  if (spawned.code !== 0) throw new Error(spawned.stderr.trim() || "не вдалося відкрити tmux-вікно");
  const target = spawned.stdout.trim();
  if (!target) throw new Error("tmux не повернув адресу вікна");

  /* Type the boot command literally into the fresh shell, then run it. */
  const typed = await runTmux(["send-keys", "-t", target, "-l", spec.command]);
  if (typed.code !== 0) throw new Error(typed.stderr.trim() || "не вдалося ввести команду в пейн");
  const enter = await runTmux(["send-keys", "-t", target, "Enter"]);
  if (enter.code !== 0) throw new Error(enter.stderr.trim() || "не вдалося запустити агента");

  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  let agentSeen = false;
  let pickerAnswered = false;
  let previousScreen = "";
  let stableRounds = 0;
  while (Date.now() < deadline) {
    await sleep(SPAWN_POLL_MS);
    const command = await paneCommand(target);
    if (command === null) throw new Error("вікно агента закрилося одразу після запуску");
    if (SHELL_COMMANDS.has(command)) {
      if (agentSeen) {
        throw new Error(`агент завершився одразу після запуску: ${screenTail(await paneScreen(target))}`);
      }
      continue;
    }
    agentSeen = true;

    const screen = await paneScreen(target);
    if (!pickerAnswered && CLAUDE_RESUME_PICKER.test(screen)) {
      await runTmux(["send-keys", "-t", target, "Enter"]);
      pickerAnswered = true;
      previousScreen = "";
      stableRounds = 0;
      continue;
    }
    if (READY_MARKERS.test(screen)) break;
    if (screen === previousScreen) {
      stableRounds += 1;
      if (stableRounds >= SPAWN_STABLE_ROUNDS) break;
    } else {
      stableRounds = 0;
      previousScreen = screen;
    }
  }

  const finalCommand = await paneCommand(target);
  if (finalCommand === null || SHELL_COMMANDS.has(finalCommand)) {
    throw new Error(`агент не запустився у вікні: ${screenTail(await paneScreen(target))}`);
  }
  await sendText(target, text);
  return target;
}

export interface SavedImage {
  path: string;
}

/** Stores a pasted clipboard image under the viewer inbox and returns its path. */
export function saveInboxImage(base64: string, mime: string): SavedImage {
  const ext = inboxImageExt(mime);
  if (ext === null) throw new Error("непідтримуваний тип зображення");
  const data = Buffer.from(base64, "base64");
  if (data.length > MAX_INBOX_IMAGE_BYTES) throw new Error("зображення завелике");
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filePath = path.join(INBOX_DIR, `img-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, data);
  return { path: filePath };
}
