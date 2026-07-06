# System resources panel + stale agent session cleanup

Date: 2026-07-06. Status: designed, ready to implement.

## Problem

Dozens of finished or abandoned agent sessions accumulate on the machine:
each `claude`/`codex` CLI in a tmux pane drags 3–4 MCP child processes
(`npm exec` + `node` per server). Real incident (2026-07-06): 13 stale claude
sessions + their MCP tails + overnight dev servers held ~2.5 GB of swap; swap
sat at 8G/8G and RAM at 90% daily, and cleanup meant hand-written `ps`/`kill`
in a chat. The viewer already knows which conversations are idle — it should
show system memory pressure and offer one-click cleanup of the sessions that
cause it.

## Scope (three deliverables)

### 1. Resources block in the rail footer

A compact block in `ProjectRail.tsx` directly above `<LimitsFooter />`
(`src/components/ProjectRail.tsx:136`), visually matching the limits rows:

- **RAM** — percent used bar + `available` absolute (e.g. `14.2 GiB вільно`).
  Bar color mirrors `LimitRow` thresholds (`src/components/LimitsFooter.tsx:43`):
  amber when available < 30%, red when < 10%.
- **Swap** — percent used bar + absolute. Amber > 60%, red > 85%. Hidden when
  the host reports no swap (or the platform probe fails).
- Click on the block opens the cleanup list (deliverable 3).
- Poll `GET /api/resources` every 30 s; reuse the sticky-payload pattern of
  `LimitsFooter` so a failed poll keeps the last numbers with a stale dot.

Important: on Linux use `MemAvailable` from `/proc/meminfo`, not
`os.freemem()` (which reports `MemFree` and badly understates headroom).

### 2. Per-session memory attribution (server)

New module `src/lib/resources.ts` (mirror the cache shape of
`src/lib/limits.ts`: ~10 s in-memory cache, `capturedAt`).

- Enumerate agent panes: `panePidMap()` (`src/lib/tmux.ts:101`) joined with
  `agentProcesses()` (`src/lib/scanner/process.ts:152`).
- For each pane pid, collect the full descendant tree in one pass: read
  `ppid` for all pids (Linux: `/proc/*/stat`; portable: `ps -axo pid,ppid`),
  index children, DFS from the pane pid. This captures MCP children
  (`npm exec`, `node-MainThread`) that hold most of the memory.
- Per tree, sum `VmRSS` + `VmSwap` from `/proc/<pid>/status` (Linux). Do not
  read `smaps` — too slow; `status` granularity is enough for a cleanup UI.
- Join each pane with its conversation via the scanner's pid→transcript
  attribution (`src/lib/scanner/index.ts` `assignTranscriptPids`): transcript
  path, title, project, `activity` (`live|recent|stalled|idle`,
  `src/lib/scanner/activity.ts:96`), last-turn age.
- Panes whose process tree has an agent CLI but no matched transcript are
  reported as **orphans** (still killable by target).

Response shape:

```ts
interface ResourcesPayload {
  system: { ramTotal: number; ramAvailable: number; swapTotal: number; swapUsed: number; capturedAt: string };
  sessions: Array<{
    target: string;            // "session:window.pane"
    panePid: number;
    path: string | null;       // transcript, null for orphans
    engine: "claude" | "codex" | null;
    title: string | null;
    project: string | null;
    activity: "live" | "recent" | "stalled" | "idle" | null;
    lastActiveAt: string | null;
    rssBytes: number;          // tree total
    swapBytes: number;         // tree total
    procCount: number;
  }>;
}
```

Route `GET /api/resources`: `runtime = "nodejs"`, `dynamic = "force-dynamic"`,
same-origin gate (`rejectCrossOrigin`) like the other routes.

### 3. Cleanup UI

Expanding the rail block (or a small dialog anchored to it) shows sessions
sorted by `rssBytes + swapBytes` desc:

- Row: engine badge, truncated title, project, idle age (`activity` +
  `lastActiveAt`), memory (`1.2 GiB + 340 MiB swap`), kill button.
- Rows with `activity: "live"` render the kill button disabled by default
  (guard against killing a working agent); a confirm step enables it.
- **Bulk action**: "kill all idle longer than N hours" (N select: 2/6/12),
  which skips `live` rows.
- Kill path: rows with a transcript reuse the existing
  `POST /api/tmux {action: "kill", path}` →
  `killConversation()` → `killPane()` (`src/lib/tmux.ts:302`) — killing the
  pane takes the CLI and its MCP children down with it. Orphan rows use a new
  `{action: "kill-target", target}` handled server-side **only if** `target`
  was present in the last `/api/resources` snapshot (server-held allowlist,
  never a client-supplied arbitrary target).
- After a kill, re-fetch `/api/resources` so freed memory shows immediately.

Note on "closed from screens": closing a card from a screen is browser-local
state (`localStorage`, `useArchivedPaths.ts` / dashboard prefs) — the server
cannot see it. Staleness is therefore defined server-side by `activity` +
last-turn age, which is the honest signal anyway (a pane closed from every
screen but still computing counts as live; a pane visible on a screen but
idle for 12 h is a cleanup candidate).

## Platform strategy

| Concern | Linux | macOS | Fallback |
|---|---|---|---|
| RAM totals | `/proc/meminfo` (`MemTotal`, `MemAvailable`) | `os.totalmem()` + `vm_stat` page counts (free+inactive+purgeable ≈ available) | hide block |
| Swap totals | `/proc/meminfo` (`SwapTotal`, `SwapFree`) | `sysctl -n vm.swapusage` (parse `used = …M`) | hide swap row |
| Per-proc memory | `/proc/<pid>/status` `VmRSS`/`VmSwap` | `ps -axo pid,ppid,rss` (KiB; swap not attributable — show RSS only) | hide per-session numbers, keep list + kill |
| Process tree | `/proc/*/stat` ppid scan | same `ps -axo pid,ppid` output | — |

Put the platform split where it already lives: extend
`src/lib/proc/linux.ts` and `src/lib/proc/portable.ts` with
`systemMemory()` and `processMemory(pids)` so `resources.ts` stays
platform-blind. macOS cannot be tested locally — implement behind the
portable backend, keep every macOS-specific parse defensive (absent value →
field omitted → UI hides it), and unit-test the parsers on captured fixture
strings (`vm_stat`, `sysctl vm.swapusage`, `ps` output samples included in
the test file).

## Non-goals

- Killing non-agent processes (browsers, Telegram, gnome-shell) — out of scope.
- `swapoff`/zram management (needs sudo; stays a console job).
- CPU/network metrics, history graphs.
- Auto-kill without user action.

## i18n

New `resources.*` section in both `src/lib/i18n/en.ts` and `uk.ts` (RAM,
swap, "вільно", idle-age labels, kill/confirm/bulk strings). Follow the
`limits.*` naming style (`src/lib/i18n/en.ts:488`).

## Acceptance

1. Rail shows RAM/swap matching `free -h` within a few percent; updates ≤60 s.
2. The list attributes memory per session including MCP children (spot-check
   one claude session with playwright/chrome-devtools MCPs: tree total ≫ CLI
   process alone).
3. Killing an idle session removes its whole subtree (verify no orphaned
   `npm exec`/`node` MCP processes remain) and the freed memory is visible on
   the next poll.
4. Bulk "idle > 2h" never touches `live` sessions.
5. `bun test` covers: meminfo/vm_stat/swapusage/ps parsers, tree building
   from a synthetic ppid table, allowlist guard of `kill-target`.
6. On a host without `/proc` (simulated), the API returns system totals via
   the portable path and the UI degrades per the table above.
