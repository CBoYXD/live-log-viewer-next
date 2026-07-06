import { describe, expect, test } from "bun:test";

import { descendantPids, parseMeminfo, parseProcStatus, parsePsMemory, parseSwapUsage, parseVmStat } from "./memory";

const KIB = 1024;

describe("parseMeminfo", () => {
  const MEMINFO = [
    "MemTotal:       32762024 kB",
    "MemFree:         1268156 kB",
    "MemAvailable:   15401224 kB",
    "Buffers:            4096 kB",
    "SwapCached:       118344 kB",
    "SwapTotal:      24769528 kB",
    "SwapFree:       10433048 kB",
    "",
  ].join("\n");

  test("headroom comes from MemAvailable even when MemFree is present", () => {
    const mem = parseMeminfo(MEMINFO);
    expect(mem).not.toBeNull();
    expect(mem!.ramTotal).toBe(32762024 * KIB);
    expect(mem!.ramAvailable).toBe(15401224 * KIB);
    expect(mem!.swapTotal).toBe(24769528 * KIB);
    expect(mem!.swapUsed).toBe((24769528 - 10433048) * KIB);
  });

  test("host without swap reports swapTotal 0", () => {
    const mem = parseMeminfo("MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
    expect(mem!.swapTotal).toBe(0);
    expect(mem!.swapUsed).toBe(0);
  });

  test("missing MemAvailable (ancient kernel) degrades to null", () => {
    expect(parseMeminfo("MemTotal: 100 kB\nMemFree: 10 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });

  test("SwapCached must not shadow SwapTotal", () => {
    const mem = parseMeminfo("MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapCached: 7 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n");
    expect(mem!.swapTotal).toBe(50 * KIB);
  });
});

describe("parseProcStatus", () => {
  test("reads VmRSS and VmSwap", () => {
    const status = "Name:\tclaude\nVmPeak:\t 2097152 kB\nVmRSS:\t  654321 kB\nVmSwap:\t   12345 kB\n";
    expect(parseProcStatus(status)).toEqual({ rssBytes: 654321 * KIB, swapBytes: 12345 * KIB });
  });

  test("kernel thread without Vm* fields reads as zero", () => {
    expect(parseProcStatus("Name:\tkthreadd\nState:\tS (sleeping)\n")).toEqual({ rssBytes: 0, swapBytes: 0 });
  });
});

describe("parseVmStat", () => {
  const VM_STAT = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               31035.",
    "Pages active:                            283147.",
    "Pages inactive:                          274786.",
    "Pages speculative:                         2493.",
    "Pages throttled:                              0.",
    "Pages wired down:                        141328.",
    "Pages purgeable:                          11375.",
    '"Translation faults":                 733526464.',
    "Pages occupied by compressor:            208782.",
    "",
  ].join("\n");

  test("free + inactive + purgeable at the header's page size", () => {
    expect(parseVmStat(VM_STAT)).toBe((31035 + 274786 + 11375) * 16384);
  });

  test("output without the page-size header degrades to null", () => {
    expect(parseVmStat("Pages free: 100.\nPages inactive: 50.")).toBeNull();
    expect(parseVmStat("")).toBeNull();
  });

  test("missing purgeable line still yields a value", () => {
    const text = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 5.\n";
    expect(parseVmStat(text)).toBe(15 * 4096);
  });
});

describe("parseSwapUsage", () => {
  test("parses the sysctl vm.swapusage line", () => {
    const swap = parseSwapUsage("total = 3072.00M  used = 1994.25M  free = 1077.75M  (encrypted)");
    expect(swap).toEqual({
      swapTotal: 3072 * KIB * KIB,
      swapUsed: Math.round(1994.25 * KIB * KIB),
    });
  });

  test("gigabyte units scale correctly", () => {
    const swap = parseSwapUsage("total = 8.00G  used = 0.50G  free = 7.50G");
    expect(swap).toEqual({ swapTotal: 8 * KIB ** 3, swapUsed: KIB ** 3 / 2 });
  });

  test("garbage degrades to null", () => {
    expect(parseSwapUsage("")).toBeNull();
    expect(parseSwapUsage("sysctl: unknown oid 'vm.swapusage'")).toBeNull();
  });
});

describe("parsePsMemory", () => {
  test("parses pid/rss pairs, KiB to bytes", () => {
    const map = parsePsMemory("    1 11256\n  402 123456\n99999 0\n");
    expect(map.get(1)).toBe(11256 * KIB);
    expect(map.get(402)).toBe(123456 * KIB);
    expect(map.get(99999)).toBe(0);
  });

  test("skips malformed lines", () => {
    expect(parsePsMemory("PID RSS\nabc def\n").size).toBe(0);
  });
});

describe("descendantPids", () => {
  /* A realistic pane tree: shell(100) → claude(200) → {npm exec(300) → node(400), npm exec(310)};
     an unrelated process 900 and its child 901 stay out. */
  const ppids = new Map<number, number>([
    [200, 100],
    [300, 200],
    [400, 300],
    [310, 200],
    [900, 1],
    [901, 900],
  ]);

  test("collects the whole subtree including the root", () => {
    expect([...descendantPids(100, ppids)].sort((a, b) => a - b)).toEqual([100, 200, 300, 310, 400]);
  });

  test("a leaf yields only itself", () => {
    expect(descendantPids(400, ppids)).toEqual([400]);
  });

  test("a self-parented or cyclic table cannot loop", () => {
    const cyclic = new Map<number, number>([
      [5, 5],
      [6, 7],
      [7, 6],
    ]);
    expect(descendantPids(6, cyclic).sort((a, b) => a - b)).toEqual([6, 7]);
  });
});
