import fs from "node:fs";
import path from "node:path";

const PROC = "/proc";
const HOLDERS_TTL_MS = 5_000;
const MAX_PATH_HOLDER_CANDIDATES = 256;

export type AgentEngine = "claude" | "codex";

/** A live claude/codex process observed in /proc. `tty` is 0 without a terminal. */
export interface AgentProcess {
  pid: number;
  engine: AgentEngine;
  argv: string[];
  cwd: string;
  tty: number;
}

let outputMemo: { at: number; map: Map<string, number> } | null = null;
let pathMemo: { at: number; key: string; map: Map<string, number> } | null = null;
let agentMemo: { at: number; list: AgentProcess[] } | null = null;

export function pidAlive(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && fs.existsSync(path.join(PROC, String(pid)));
}

function scanFdTargets(visit: (target: string, pid: number, fdPath: string) => void): void {
  let procEntries: fs.Dirent[];
  try {
    procEntries = fs.readdirSync(PROC, { withFileTypes: true });
  } catch {
    return;
  }

  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    const fdDir = path.join(PROC, procEntry.name, "fd");
    let fds: fs.Dirent[];
    try {
      fds = fs.readdirSync(fdDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const fd of fds) {
      const fdPath = path.join(fdDir, fd.name);
      let target: string;
      try {
        target = fs.readlinkSync(fdPath);
      } catch {
        continue;
      }
      visit(target, pid, fdPath);
    }
  }
}

/**
 * The permission bits of a /proc fd symlink encode the open mode (`l-wx…` for
 * a writer, `lr-x…` for a reader). Transcript attribution must follow the
 * writer: a monitoring agent that tails another agent's transcript holds a
 * read fd, and pinning its pid would aim send-keys and kill at the wrong
 * process.
 */
function fdWritable(fdPath: string): boolean {
  try {
    return (fs.lstatSync(fdPath).mode & 0o200) !== 0;
  } catch {
    return false;
  }
}

function realpathSafe(pathname: string): string | null {
  try {
    return fs.realpathSync(pathname);
  } catch {
    return null;
  }
}

export function outputHolders(fresh = false): Map<string, number> {
  const now = Date.now();
  if (!fresh && outputMemo && now - outputMemo.at < HOLDERS_TTL_MS) return outputMemo.map;

  const holders = new Map<string, number>();
  scanFdTargets((target, pid) => {
    if (target.endsWith(".output") && !holders.has(target)) holders.set(target, pid);
  });

  outputMemo = { at: now, map: holders };
  return holders;
}

/** Maps each of `paths` to a pid holding it open for writing, when one exists. */
export function writingHolders(paths: Iterable<string>, fresh = false): Map<string, number> {
  const aliasToPath = new Map<string, string>();
  for (const pathname of paths) {
    if (aliasToPath.size >= MAX_PATH_HOLDER_CANDIDATES * 2) break;
    if (!pathname) continue;
    aliasToPath.set(pathname, pathname);
    const real = realpathSafe(pathname);
    if (real) aliasToPath.set(real, pathname);
  }

  const key = [...aliasToPath.keys()].sort().join("\0");
  const now = Date.now();
  if (!fresh && pathMemo && pathMemo.key === key && now - pathMemo.at < HOLDERS_TTL_MS) return pathMemo.map;

  const holders = new Map<string, number>();
  if (aliasToPath.size > 0) {
    scanFdTargets((target, pid, fdPath) => {
      const pathname = aliasToPath.get(target);
      if (pathname && !holders.has(pathname) && fdWritable(fdPath)) holders.set(pathname, pid);
    });
  }

  pathMemo = { at: now, key, map: holders };
  return holders;
}

/** True when `pid` currently keeps `pathname` open for writing. */
export function pidWritesPath(pid: number, pathname: string): boolean {
  const real = realpathSafe(pathname);
  const fdDir = path.join(PROC, String(pid), "fd");
  let fds: fs.Dirent[];
  try {
    fds = fs.readdirSync(fdDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const fd of fds) {
    const fdPath = path.join(fdDir, fd.name);
    let target: string;
    try {
      target = fs.readlinkSync(fdPath);
    } catch {
      continue;
    }
    if ((target === pathname || target === real) && fdWritable(fdPath)) return true;
  }
  return false;
}

export function readArgv(pid: number): string[] {
  try {
    return fs
      .readFileSync(path.join(PROC, String(pid), "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Engine of a process judged by its first two argv tokens (the binary may run
 * through node/bun, pushing the real entrypoint to argv[1]). Matching the
 * basename exactly ("claude", "claude.exe", "codex") keeps sibling binaries
 * like `codex-telegram-mcp` out.
 */
export function argvEngine(argv: string[]): AgentEngine | null {
  for (const token of argv.slice(0, 2)) {
    const base = path.basename(token);
    if (base === "claude" || base === "claude.exe") return "claude";
    if (base === "codex" || base === "codex.exe") return "codex";
  }
  return null;
}

// Claude Code internal workers: the session daemon plus its pty host/spare
// wrappers. They share the engine binary and often the project cwd, so they
// must not compete with the real interactive CLI for pid attribution.
const HELPER_ARGS = new Set(["daemon", "--bg-pty-host", "--bg-spare"]);

export function isHelperArgv(argv: string[]): boolean {
  return argv.some((token) => HELPER_ARGS.has(token));
}

function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(path.join(PROC, String(pid), "cwd"));
  } catch {
    return null;
  }
}

/** tty_nr from /proc/<pid>/stat; 0 means no controlling terminal. */
function readTty(pid: number): number {
  let stat: string;
  try {
    stat = fs.readFileSync(path.join(PROC, String(pid), "stat"), "utf8");
  } catch {
    return 0;
  }
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const tty = Number(afterComm[4]);
  return Number.isInteger(tty) && tty > 0 ? tty : 0;
}

/** All non-helper claude/codex processes currently alive, memoised briefly. */
export function agentProcesses(fresh = false): AgentProcess[] {
  const now = Date.now();
  if (!fresh && agentMemo && now - agentMemo.at < HOLDERS_TTL_MS) return agentMemo.list;

  const list: AgentProcess[] = [];
  let procEntries: fs.Dirent[];
  try {
    procEntries = fs.readdirSync(PROC, { withFileTypes: true });
  } catch {
    agentMemo = { at: now, list };
    return list;
  }
  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    const argv = readArgv(pid);
    const engine = argvEngine(argv);
    if (engine === null || isHelperArgv(argv)) continue;
    const cwd = readCwd(pid);
    if (cwd === null) continue;
    list.push({ pid, engine, argv, cwd, tty: readTty(pid) });
  }
  agentMemo = { at: now, list };
  return list;
}
