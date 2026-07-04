# Live Log Viewer

A local web UI that turns raw Codex / Claude Code agent logs into a readable,
live-updating chat feed. It discovers every session, subagent, Codex companion
job and background shell task on your machine, links them into a parent→child
tree, and tails the selected one in real time.

## What it shows

- **Claude Code sessions** (`~/.claude/projects/**/*.jsonl`) and their
  subagents, rendered as a chat: user bubbles, assistant prose, tool-call
  cards with ✓/✗ statuses and expandable output.
- **Codex CLI sessions** (`~/.codex/sessions/**/rollout-*.jsonl`) with command
  cards, patches and service events.
- **Codex companion jobs** (`~/.claude/plugins/data/codex-openai-codex/state`)
  with a one-click jump to the full rollout session behind each job.
- **Background shell tasks** (`claude-<uid>/**/tasks/*.output` under the OS
  temp dir — `/tmp` on Linux, `$TMPDIR` on macOS) — the originating Bash
  command is recovered from the session transcript and shown above the
  terminal output.

## Highlights

- **Parentage tree**: session → subagents → codex jobs → rollouts → background
  tasks, built server-side by scanning transcripts (append-only incremental,
  cached — the warm `/api/files` poll stays around 100 ms).
- **Conversations first**: filter chips «Все · Розмови · Активні», stable
  alphabetical project groups, most-recently-updated first inside a project,
  technical noise collected under a collapsed «⚙ Технічне» group.
- **Live activity**: content-based badges — a transcript is "працює" while
  mid-turn and "закінчив" once the final assistant message lands.
- **Deep links**: every selection is reflected in the URL (`#f=<path>`), so a
  link opens that exact log.
- Model chips (`fable-5`, `gpt-5.5`, `sonnet`…), collapsible tree with
  persisted state, follow-mode autoscroll, service-event toggle, line filter.

## Run

Requires [bun](https://bun.sh) (or npm/pnpm), Node 20.9+, and
[tmux](https://github.com/tmux/tmux) for the composer/spawn features (`brew
install tmux` on macOS, or your distro's package on Linux).

Once the package is published to npm, the quickstart is:

```bash
bunx agent-log-viewer
```

Local clone workflow:

```bash
bun install
bun run build
bun start --port 8898 --hostname 127.0.0.1
# open http://127.0.0.1:8898/
```

`bun dev` works too (needs a high OS file-watch limit for large homedirs).

## Platform support

Linux is the native target: process discovery reads `/proc` directly. macOS
is supported through a portable backend that shells out to `ps` and `lsof`
instead — same live-process detection, tmux composer targeting, agent
spawn/kill and background-task discovery, just a bit more subprocess
overhead per scan. The backend is chosen automatically by `process.platform`
(see `src/lib/proc/`); `VIEWER_PROC_BACKEND=portable` forces the portable
path on Linux too, for testing.

Without tmux installed, log viewing still works; the composer, agent spawn
and resume-into-pane features are unavailable.

## Доступ через Tailscale

```bash
bunx agent-log-viewer --tailscale
```

`--tailscale` запускає локальний сервер на `127.0.0.1` і відкриває його в
tailnet через foreground-процес `tailscale serve <port>`. Публічний інтернет
через Funnel не використовується.

CLI створює 32-символьний ключ доступу, додає його в tailnet URL як `?k=...`,
а після першого відкриття сервер зберігає `llv_auth` cookie на 30 днів.
`--new-token` генерує новий ключ. URL з ключем треба вважати секретом.

Кожен, хто має tailnet-доступ до цього URL, може читати всі agent transcripts,
включно з чутливими даними, які потрапили в сесію, і може виконувати команди
через `/api/tmux` та `/api/spawn`. Ставтеся до tailnet URL як до секрета — не
пересилайте його стороннім.
>>>>>>> 151233d (Package as agent-log-viewer with a bunx CLI and Tailscale access)

## Security model

The log APIs refuse any path that does not resolve into one of the whitelisted
log roots (see `src/lib/scanner/roots.ts`). Mutating endpoints exist:
`/api/tmux` sends keys to tmux sessions and `/api/spawn` starts commands.

By default the CLI binds to `127.0.0.1`. With `--tailscale`, access is exposed
inside the tailnet via `tailscale serve` and guarded by the token gate in
`src/proxy.ts`. Non-loopback binds also force token mode. Treat any URL
containing `?k=` as a credential.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md): route handlers under
`src/app/api/*`, a pure scanner pipeline under `src/lib/scanner/*`
(discover → describe → activity → model → links), React components under
`src/components/*`. Caches live on `globalThis` and survive dev hot-reload.

## License

MIT
