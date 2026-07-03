# Spec: real process status, kill control, sane sorting, dashboard panes

Target repo: `~/.agents/tools/live-log-viewer-next` (this repo). Next.js 16 App Router,
Tailwind v4, bun, TypeScript strict. Server runs on Linux only — `/proc` is available.

Read `AGENTS.md` first (Next.js version differs from training data; check
`node_modules/next/dist/docs/` when unsure about an API).

Do NOT commit. Do NOT touch files outside this repo. Keep named exports and the
existing file layout conventions (`src/lib/scanner/*` for server-side scan logic,
`src/components/*` for UI, `src/app/api/*` for routes).

## Problem summary (user complaints)

1. Killed/dead runs are shown as "працює". The activity heuristic in
   `src/lib/scanner/activity.ts` trusts a "busy" tail for up to 1800 s, and trusts
   `job.status === "running"` even when the process died.
2. No way to kill a running process from the UI, and no visibility of the real
   process state (PID, alive/exited).
3. Sidebar sorting is a mess: projects sorted alphabetically, stale items mixed
   with active ones.
4. The conversation manager is inconvenient. Wanted: sidebar lists ONLY main
   conversations; the main area gets a dashboard of vertical live panes, max 3
   side-by-side, navigable by group, new items replace old panes.

## Feature 1 — real process liveness (server)

New file `src/lib/scanner/process.ts`:

- `pidAlive(pid: number): boolean` — `fs.existsSync("/proc/" + pid)`.
- `outputHolders(): Map<string, number>` — ONE scan per call over `/proc/*/fd`:
  for each numeric `/proc/<pid>/fd` dir, `readlinkSync` each fd entry; when the
  link target ends with `.output` record `target → pid`. Wrap every readdir/readlink
  in try/catch (permission errors are normal — skip silently). Cache the result in
  the existing `globalCache` mechanism with a ~5 s TTL keyed by scan time (the
  current caches are size-keyed; add a small time-based memo local to the module:
  `let memo: {at: number, map: Map<string, number>} | null`). This runs once per
  `/api/files` request, not per file.

Extend `FileEntry` in `src/lib/types.ts`:

```ts
/** Real OS process state when the entry maps to a process, else null. */
proc: "running" | "done" | "killed" | null;
pid: number | null;
```

(Default both to `null` in `discover.ts`; fill them in the scanner pipeline where
activity is computed — see `src/lib/scanner/index.ts` for where `activity` is set.)

Rules per root:

- `codex-jobs`: read the job JSON (already done in `activity()`). Let
  `pid = job.pid`. If `job.status === "running"`:
  - `pidAlive(pid)` → `proc="running"`, `activity="live"`.
  - pid dead → `proc="killed"`, activity falls back to age (`recent`/`idle`),
    NEVER `live`.
  If status is completed/failed/cancelled → `proc="done"`, keep current
  age-based recent/idle logic.
- `claude-tasks` (`.output` files): look up the path in `outputHolders()`.
  Holder found → `proc="running"`, `pid=<holder>`, `activity="live"`.
  No holder → `proc="done"`, `pid=null`, activity by age (recent < 900 s, else idle).
- jsonl conversations (`claude-projects`, `codex-sessions`): keep the tail
  heuristic in `jsonlTurnState`, but shrink the trust window: `busy && age < 180`
  → `live`; `busy && age >= 180` → the turn is almost certainly dead (killed
  session) → introduce activity value `"stalled"` (see below); `done` keeps the
  current `recent`/`idle` mapping. `proc` stays `null` for conversations (we
  cannot map them to a PID reliably).

Add `"stalled"` to the `Activity` union in `src/lib/types.ts` and handle it
everywhere `Activity` is switched on (sidebar dot, TaskHeader text, sorting).
Display label: «перервано». Visual: muted red/gray dot, never the green pulse.

## Feature 2 — kill endpoint + UI control

New route `src/app/api/proc/route.ts`:

- `POST` with JSON body `{ path: string, force?: boolean }`.
- Validate `path` with the existing `pathAllowed()` from `src/lib/scanner/roots.ts`;
  reject otherwise (400).
- Derive the PID SERVER-SIDE from the path (never accept a pid from the client):
  - path under the codex-jobs root and endsWith `.log` → read sibling `.json`,
    take `job.pid`; additionally read `/proc/<pid>/cmdline` and require it to
    contain `codex` (defense against PID reuse).
  - path endsWith `.output` under the claude-tasks root → `outputHolders()` lookup.
  - anything else → 400 `{error:"не процесний запис"}`.
- If no live pid → 409 `{error:"процес вже не працює"}`.
- `process.kill(pid, force ? "SIGKILL" : "SIGTERM")`, respond `{ok:true, pid}`.
  Wrap in try/catch → 500 with the error message.

UI (`src/components/TaskHeader.tsx` + reuse in dashboard pane headers):

- Status chip next to the engine badge:
  - `proc==="running"` → green chip `▶ PID <pid>`;
  - `proc==="killed"` or activity `"stalled"` → red-ish chip «перервано»;
  - `proc==="done"` → gray chip «завершено»;
  - conversations with activity live → keep current live dot behavior.
- Kill button shown ONLY when `proc==="running"`. Two-step inline confirm, no
  browser `confirm()`: first click turns the button into «Точно вбити PID <pid>?»
  with «Так, вбити» / «Скасувати»; auto-reset after 5 s. On confirm, POST
  `/api/proc`, show the result in the header status area, rely on the normal
  files poll to refresh the chip. If a second kill is requested for the same
  path after a failed SIGTERM, send `force:true` (label the button «SIGKILL»).

## Feature 3 — sorting that reflects reality

In `src/components/sidebarModel.ts`:

- Project groups: sort by `(hasLive desc, maxSmt desc)`. Drop the alphabetical
  `localeCompare` sort. `hasLive` = any node in the group (incl. technical) is live.
- Within a group: order root nodes by activity band first —
  `live (0) → recent (1) → stalled (2) → idle (3)` — then `smt` desc inside a band.
  A parent whose subtree contains a live node counts as band 0.
- Stale cutoff: root nodes whose whole subtree is idle AND `smt` older than 24 h
  go into a collapsed «Давніше (N)» section at the bottom of each project group
  (same collapsible pattern the technical group already uses). Collapsed by default,
  state persisted in localStorage like the existing open-maps.

## Feature 4 — sidebar = main conversations; main area = dashboard panes

Sidebar (`Sidebar.tsx` + `sidebarModel.ts`):

- The sidebar lists ONLY main conversations: root-level nodes that pass
  `isConversation()` (claude sessions, top-level codex sessions). Technical
  children (subagents, codex jobs, background tasks) are NOT listed as rows;
  each conversation row keeps a small count badge (existing `count`) and the
  live dot when any descendant is live.
- Remove the all/conversations/active filter tabs if they become redundant;
  keep the search input (searches conversations by title/project/model).
- Keep the project grouping + Feature 3 ordering + «Давніше» collapse.

Main area (`Viewer.tsx`, new `src/components/Dashboard.tsx`, small changes to
`LogFeed.tsx`):

Two modes, state in `Viewer`:

- **Dashboard mode** — default when nothing selected, and reachable any time via a
  «Дашборд» button in the top bar.
  - Candidates: every entry (any root) with activity `live`, plus `recent` ones to
    fill space, sorted live-first then smt desc.
  - Render vertical panes in a CSS grid, MAX 3 per row on ≥1280 px (2 on medium,
    1 on small). Exactly one row visible — panes beyond 3 are grouped into pages
    of 3, with pager controls (‹ › arrows + «сторінка 1/3» chips) to walk groups.
    Prefer grouping pages by project when a project has ≥2 candidates; otherwise
    fill pages by recency.
  - When a NEW live item appears it replaces the stalest pane on the current page
    (do not push a 4th column). When an item stops being live keep its pane until
    the user switches pages (so final output stays readable), then it drops out.
  - Pane = header (engine badge, model chip, truncated title, activity/PID chip,
    kill button when `proc==="running"`, «відкрити» button → focus mode) + body =
    `LogFeed` in a new `compact` prop mode (smaller paddings/fonts, follow always
    on, no per-pane toolbar). Each pane polls its own tail — 3 concurrent polls
    with the existing `useLogTail` interval are acceptable.
- **Focus mode** — clicking a conversation in the sidebar (or «відкрити» on a
  pane) shows the existing single full view. Under the header add a horizontal
  strip of that conversation's descendants (subagents/jobs/tasks, live-first,
  smt desc): chips with engine glyph + short title + activity dot; clicking a chip
  opens that descendant in the same full view. «Дашборд» button returns.

Keep `LogFeed`'s existing behavior in full mode untouched; the `compact` prop only
adjusts chrome/density and forces follow.

## Gates (run inside this repo; NO network — node_modules is provisioned)

```
bunx tsc --noEmit
bun run lint
bun run build
```

All three must pass. Fix real type issues; do not weaken tsconfig/eslint.

## Writing rules

- UI strings in Ukrainian, matching existing tone («перервано», «завершено»,
  «Давніше», «Дашборд»).
- Avoid antithesis-style contrast phrasing in comments or docs.
- Comments only for non-obvious invariants (e.g. why the fd-scan is cached, why
  PID-reuse is checked).
