# UI redesign brief: project-centric trace dashboard (from scratch)

Repo: `~/.agents/tools/live-log-viewer-next`. Next.js 16 App Router, Tailwind v4,
bun, TS strict. The server-side scanner and API routes (`/api/files`, `/api/log`,
`/api/proc`) are DONE and stay untouched. This brief is a full rewrite of the
frontend components (`src/components/**`, `src/app/page.tsx` layout) with every
detail thought through for a WIDE desktop screen (1920px+).

## Information architecture (the core change)

Today the dashboard mixes all projects into one pane pool. Redesign:

1. **Project rail** (far left, ~220-260px): one row per project, sorted
   live-first then by recency. Each row: project name, live-branch count (green),
   total count (dim). The selected project is visually anchored. A top item
   «Огляд» shows the cross-project overview (small multiples or aggregate list).
   Selected project persists in localStorage + URL hash (`#p=<project>`), and
   `#f=<path>` deep links still open focus mode.
2. **Project dashboard** (main area): everything scoped to the selected project:
   - Columns = branches running in parallel RIGHT NOW (root conversation first,
     then its live descendants: background tasks, codex jobs, subagents). One
     column per branch, time slices vertically (chronological feed, follow on).
   - Blocking foreground tool calls stay as trace rows inside the parent column.
   - Wide screen: up to 4 columns at ≥1920px, 3 at ≥1440, 2 at ≥1024. Pager for
     overflow groups.
   - Conversations of the project that are NOT live: a compact list/strip
     («Розмови») for quick opening — recency ordered, activity dots.
   - Finished/interrupted items sink to a bottom «Виконані» strip (amber done,
     red stalled/killed), click → focus.
3. **Focus mode**: full-width single feed with slim top bar (badge, model, title,
   proc chip + kill, Follow/Пауза/Службові/filter) and descendant chip strip.
   «Назад до проєкту» returns to the project dashboard (not a global one).

## Design language

- Light, calm, chat-like. Keep the existing token palette (bg/panel/line/dim/
  accent/ok/err, engine colors codex/claude) but tighten usage consistency.
- Typography scale: 11/12.5/14 px working sizes; single font stack already set.
- Chrome must be thin: headers ≤40px, chips 24px, no stacked toolbars.
- Engine identity: Claude = warm orange, Codex = teal/green, Bash/shell = gray.
  Use them for badges and column top borders so a wide screen scans instantly.
- Live = green pulsing dot; recent = amber; stalled/killed = red; idle = gray.
  Same encoding EVERYWHERE (rail, columns, chips, strips).
- Kill control: two-step inline confirm, red only at the confirm step.
- Accessibility: focus-visible rings, aria-labels on icon buttons, buttons ≥24px
  hit area.

## Interaction details to get right

- Switching projects must be instant (all data is already client-side from
  /api/files polling) and must not lose per-project pane state within a session.
- Pane columns keep their scroll (follow) independent; panes don't reshuffle on
  every poll — new live branches enter by replacing the stalest pane, finished
  panes stay until the user switches page/project.
- Empty states: project with nothing live shows recent conversations + finished
  strip, with a clear «нічого не працює» note, never a blank void.
- Sidebar search (if kept) filters conversations within the selected project;
  global search is optional.

## Working method (mandatory)

- Iterate visually with the `agent-browser` CLI against a DEV server you run
  yourself: `bun run dev -- --port 8899 --hostname 127.0.0.1` (Next dev with
  webpack; hot reload). Set a wide viewport first:
  `agent-browser set viewport 2560 1300` (also verify at 1920 and 1440).
  Screenshot → self-critique against this brief → fix → repeat. Do at least 3
  full critique rounds; judge like a senior product designer (alignment, rhythm,
  contrast, wasted chrome, scanability).
- Do NOT touch ports 8011, 5177, or any non-viewer process. You own 8899 (dev)
  and at the very end 8898 (prod restart).
- Finish: `bunx tsc --noEmit && bun run lint && bun run build`, then restart the
  prod server on 8898 (`bun start --port 8898 --hostname 127.0.0.1`, kill only
  the old next-server for THIS app first) and verify with a final screenshot.
- No commits. Ukrainian UI strings. No antithesis phrasing in comments/strings.
- Keep named exports; split components sensibly (rail, project dashboard, pane,
  focus view, strips); no dead code left from the old layout.
