import fs from "node:fs";
import path from "node:path";

const PROC = "/proc";
const HOLDERS_TTL_MS = 5_000;
const MAX_PATH_HOLDER_CANDIDATES = 256;

let outputMemo: { at: number; map: Map<string, number> } | null = null;
let pathMemo: { at: number; key: string; map: Map<string, number> } | null = null;

export function pidAlive(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && fs.existsSync(path.join(PROC, String(pid)));
}

function scanFdTargets(visit: (target: string, pid: number) => void): void {
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
      let target: string;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd.name));
      } catch {
        continue;
      }
      visit(target, pid);
    }
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

export function pathHolders(paths: Iterable<string>, fresh = false): Map<string, number> {
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
    scanFdTargets((target, pid) => {
      const pathname = aliasToPath.get(target);
      if (pathname && !holders.has(pathname)) holders.set(pathname, pid);
    });
  }

  pathMemo = { at: now, key, map: holders };
  return holders;
}
