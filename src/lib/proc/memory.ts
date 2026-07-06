import type { ProcessMemory, SystemMemory } from "./types";

/**
 * Pure text parsers behind the memory primitives of both proc backends.
 * Kept free of fs/child_process so every format — /proc/meminfo,
 * /proc/<pid>/status, macOS `vm_stat`, `sysctl vm.swapusage`, `ps` columns —
 * is unit-testable on captured fixture strings (memory.test.ts); macOS cannot
 * be exercised locally, so those parsers are only ever proven by fixtures.
 */

const KIB = 1024;

/** `Name:   12345 kB` value in bytes, or null when the field is absent. */
function meminfoField(text: string, name: string): number | null {
  const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) ? kb * KIB : null;
}

/**
 * System totals from /proc/meminfo. MemAvailable is the kernel's own headroom
 * estimate — os.freemem() reports MemFree, which badly understates it. A host
 * without swap reports SwapTotal 0, which the UI reads as "hide the swap row".
 */
export function parseMeminfo(text: string): SystemMemory | null {
  const ramTotal = meminfoField(text, "MemTotal");
  const ramAvailable = meminfoField(text, "MemAvailable");
  if (ramTotal === null || ramAvailable === null || ramTotal <= 0) return null;
  const swapTotal = meminfoField(text, "SwapTotal") ?? 0;
  const swapFree = meminfoField(text, "SwapFree") ?? swapTotal;
  return { ramTotal, ramAvailable, swapTotal, swapUsed: Math.max(0, swapTotal - swapFree) };
}

/** VmRSS/VmSwap from /proc/<pid>/status, in bytes. Kernel threads have no Vm*
    fields at all — they read as zero, which is also their true footprint. */
export function parseProcStatus(text: string): ProcessMemory {
  return {
    rssBytes: meminfoField(text, "VmRSS") ?? 0,
    swapBytes: meminfoField(text, "VmSwap") ?? 0,
  };
}

/**
 * Available bytes out of macOS `vm_stat`: free + inactive + purgeable pages,
 * the closest cheap analogue of MemAvailable. The page size comes from the
 * header line ("page size of 16384 bytes") — hardcoding 4096 would be 4×
 * wrong on Apple Silicon.
 */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const page = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\.?`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const free = page("Pages free");
  const inactive = page("Pages inactive");
  if (free === null || inactive === null) return null;
  const purgeable = page("Pages purgeable") ?? 0;
  return (free + inactive + purgeable) * pageSize;
}

const SWAPUSAGE_SIZE_RE = /([\d.]+)\s*([KMGT])/;

function swapusageBytes(segment: string): number | null {
  const match = SWAPUSAGE_SIZE_RE.exec(segment);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale = { K: KIB, M: KIB * KIB, G: KIB ** 3, T: KIB ** 4 }[match[2] as "K" | "M" | "G" | "T"];
  return Math.round(value * scale);
}

/** `sysctl -n vm.swapusage` → "total = 3072.00M  used = 1994.25M  free = …". */
export function parseSwapUsage(text: string): { swapTotal: number; swapUsed: number } | null {
  const total = /total\s*=\s*(\S+)/.exec(text)?.[1];
  const used = /used\s*=\s*(\S+)/.exec(text)?.[1];
  if (!total || !used) return null;
  const swapTotal = swapusageBytes(total);
  const swapUsed = swapusageBytes(used);
  if (swapTotal === null || swapUsed === null) return null;
  return { swapTotal, swapUsed };
}

/** `ps -axo pid=,rss=` (rss in KiB) → pid → rss bytes. Swap has no portable
    per-process source, so the portable backend reports it as 0 and the UI
    simply omits the swap share. */
export function parsePsMemory(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    map.set(Number(match[1]), Number(match[2]) * KIB);
  }
  return map;
}

/**
 * All descendants of `root` (root included) over a pid → ppid table, iterative
 * DFS. A recycled-pid cycle in a torn snapshot cannot loop it — each pid is
 * visited once.
 */
export function descendantPids(root: number, ppids: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of ppids) {
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const seen = new Set<number>([root]);
  const order: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    order.push(pid);
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return order;
}
