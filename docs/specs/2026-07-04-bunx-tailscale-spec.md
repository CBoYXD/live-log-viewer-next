# Package as `agent-log-viewer` with a bunx CLI and Tailscale access

Branch: `bunx-tailscale`. Base: main. Implement work items WI-1 → WI-5 below, in
order, exactly as specified. This file is the full spec — follow it literally;
do not redesign.

## Constraints (do not violate)

- Use **bun** for install/build/lint everywhere (`bun install`, `bun run build`,
  `bunx tsc --noEmit`, `bun run lint`). Never npm/npx/yarn/pnpm.
- UI strings (anything a human sees: banner text, HTTP error bodies) are in
  **Ukrainian**. Code comments are English, and only where they explain a
  non-obvious constraint/decision — no narration comments.
- TypeScript strict; no `any`.
- DO NOT modify these files (other in-flight work touches them):
  `src/lib/tmux.ts`, `src/app/api/spawn/route.ts`, `src/app/api/tmux/route.ts`,
  `src/components/*`, `src/lib/scanner/process.ts`, `src/lib/proc/*`.
- You MAY modify these pre-existing files: `next.config.ts`, `package.json`,
  `src/lib/sameOrigin.ts`, `README.md`, `ARCHITECTURE.md`.
- Everything else needed (bin/cli.mjs, bin/tailscale.mjs, scripts/prepack.mjs,
  src/proxy.ts, src/lib/authToken.ts, docs/RELEASING.md) is new — create it.
- This repo's Next.js (16.2.10) has breaking changes vs older training data.
  `output: 'standalone'` and the `proxy.ts` file convention (replaces
  `middleware.ts`, defaults to the Node.js runtime) are both confirmed current
  in `node_modules/next/dist/docs/`. Re-check that directory before writing
  proxy.ts if unsure of an API.
- Decisions already made: package name `agent-log-viewer`, cookie `Max-Age`
  2592000 seconds (30 days).

---

## WI-1 — Standalone packaging

Files: `next.config.ts`, `scripts/prepack.mjs` (new), `package.json`.

### package.json changes
- `"name": "agent-log-viewer"` (was `live-log-viewer`).
- Remove `"private": true`.
- Add `"bin": { "agent-log-viewer": "bin/cli.mjs" }`.
- Add `"files": ["bin", "dist"]`.
- Add `"engines": { "node": ">=20.9.0" }`.
- Add `"os": ["linux", "darwin"]`.
- Add script `"prepack": "node scripts/prepack.mjs"`. Keep existing
  `dev`/`build`/`start`/`lint` scripts untouched.
- Add dependency `"qrcode-terminal": "^0.12.0"` (used later, in WI-4).
- Keep version `0.1.0`, keep `ignoreScripts`/`trustedDependencies`/description/
  license as-is.

### next.config.ts
Replace contents with:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.LLV_STANDALONE === "1" ? "standalone" : undefined,
  images: { unoptimized: true },
  outputFileTracingExcludes: { "*": ["node_modules/@img/**", "node_modules/sharp/**"] },
};

export default nextConfig;
```
Rationale (put as a short comment): conditional `output` keeps
`bun run build && bun start` warning-free while still allowing a standalone
build for packaging via `LLV_STANDALONE=1`.

### scripts/prepack.mjs (new, plain ESM Node script)
Runs at `npm pack`/`npm publish` time (not on `bun install`).
Steps:
1. Run `LLV_STANDALONE=1 next build --webpack` (spawn via `process.execPath`
   or shell out to the local `next` bin — use bun-agnostic `node_modules/.bin/next`
   so it works regardless of package manager during publish).
2. `rm -rf dist`.
3. Copy `.next/standalone` → `dist/standalone`.
4. Copy `.next/static` → `dist/standalone/.next/static`.
5. There is no `public/` directory in this repo — do not copy one, do not
   error if it's absent.
6. Fail loudly (non-zero exit, clear stderr message) if the build fails or if
   `.next/standalone/server.js` doesn't exist afterward.

### Acceptance criteria (verify yourself before moving to WI-2)
1. `npm pack` (dry run is fine — `npm pack --dry-run` first to sanity check
   the file list, then a real `npm pack` in a scratch dir to check size)
   produces a tarball ≤ 10 MB containing `dist/standalone/server.js` and
   `dist/standalone/.next/static/**`.
2. In an **empty directory**, extract that tarball, then run:
   `PORT=9001 HOSTNAME=127.0.0.1 node package/dist/standalone/server.js`
   and confirm with curl:
   - `GET /` → 200
   - `GET /api/files` → 200, JSON array
   - `GET /api/log?path=/etc/passwd` → 403
   - `POST /api/tmux` with header `Origin: http://evil.com` → 403
   Kill the server after.
3. Repeat the same four curl checks using **bun** to run the server instead
   of node (`bun package/dist/standalone/server.js`) — must behave identically.
4. In the repo (not the packed tarball), `bun run build && bun start` (no
   `LLV_STANDALONE` set) completes with **no standalone-related warning** and
   serves normally. Kill it after checking `GET /` → 200.

Report exact curl status codes/output for all of the above.

---

## WI-2 — CLI local mode

Files: `bin/cli.mjs` (new).

Plain ESM JS, no build step, no external deps beyond Node builtins (defer
`qrcode-terminal` and tailscale wiring to WI-4).

Flags (hand-rolled parsing, no library):
- `-p, --port <n>` default `8898`
- `-H, --hostname <h>` default `127.0.0.1`
- `--tailscale` (WI-4 — parse now, wire later; for now if passed without WI-4
  code present, just ignore/no-op is NOT acceptable — instead stub it to print
  "not yet available" only if you truly cannot land WI-4 in the same file
  later; in practice you will be extending this same file in WI-4, so it's
  fine to leave the flag parsed-but-unused here and implement behavior in WI-4)
- `--no-open`
- `--new-token` (WI-4, same note as `--tailscale`)
- `-v, --version` — print version from package.json, exit 0
- `-h, --help` — print usage, exit 0

Server resolution order (first that exists wins):
1. `<pkg>/dist/standalone/server.js` (published layout)
2. `<pkg>/.next/standalone/server.js` (repo standalone build, e.g. after
   `LLV_STANDALONE=1 bun run build`)
3. Fallback: spawn `next start` via `<pkg>/node_modules/.bin/next` (repo
   convenience, no standalone build needed)

Resolve `<pkg>` as the directory containing this `bin/cli.mjs` file's
package.json (walk up from `import.meta.url`), NOT `process.cwd()` — the CLI
must work from any cwd.

Spawn the resolved server with `process.execPath` (cases 1–2) or the resolved
`next` binary (case 3), with env:
`{ ...process.env, PORT: String(port), HOSTNAME: hostname, LLV_TOKEN, LLV_TS_HOST }`
(LLV_TOKEN/LLV_TS_HOST come from WI-4; leave them `undefined`/unset for now —
just make sure the env-building code has named slots for them so WI-4 only
needs to fill values in, not restructure spawning).

Important: explicitly set `HOSTNAME` in the child env even when the user
didn't pass `--hostname` (default `127.0.0.1`) — on this user's machine zsh
exports a `HOSTNAME` env var (the machine's hostname) into every shell, which
would otherwise silently override the standalone server's bind address.
Comment this exact reasoning inline since it's non-obvious.

Readiness: after spawning, poll `http://127.0.0.1:<port>/api/files` (use the
loopback address for the readiness probe regardless of `--hostname`, since
`--hostname` may bind non-loopback) up to ~15s (e.g. every 200ms), then:
- print the banner (see below)
- open the browser via `xdg-open` (linux) / `open` (darwin) unless `--no-open`
  was passed or stdout is not a TTY (`process.stdout.isTTY` falsy)

Child stderr handling: watch for `EADDRINUSE` in stderr chunks; on match print
(Ukrainian): `Порт <n> зайнятий. Спробуйте: bunx agent-log-viewer --port <n+1>`
then exit 1 (kill the child first if still alive).

Hostname safety: if `--hostname` is set to something other than `127.0.0.1`,
`localhost`, or `::1`, this is a non-loopback bind — allowed, but note in the
spec doc that this is meant to be combined with token mode in WI-4 (WI-4 will
force-enable token mode + print a loud warning when this happens; for WI-2
alone, since token mode doesn't exist yet, just implement the bind — do not
invent a stand-in warning here, WI-4 owns that behavior. Actually: check with
yourself — if WI-4 will own it, don't duplicate logic in WI-2; just make sure
the hostname value is threaded through cleanly so WI-4 can add the check).

Signal handling: on `SIGINT`/`SIGTERM`, kill the server child (and, once WI-4
lands, the tailscale child) and exit 0. No orphan processes.

Banner (Ukrainian, local mode, no tailscale):
```
  ✳ Live Log Viewer v0.1.0
  Відкрито:  http://127.0.0.1:8898/
  Читає логи з ~/.claude/projects, ~/.codex/sessions.
  Ctrl+C — зупинити.  --tailscale — доступ з телефона.
```
(substitute actual port/hostname; version pulled from package.json, not
hardcoded).

### Acceptance criteria
After `LLV_STANDALONE=1 bun run build` in the repo:
1. `node bin/cli.mjs --port 9002 --no-open` prints a banner with the correct
   URL (`http://127.0.0.1:9002/`) and the server responds on that port.
2. Running a **second** instance on the same port exits 1 with the Ukrainian
   `Порт зайнятий` hint (exact wording above, port substituted).
3. Ctrl+C (send SIGINT to the CLI process) leaves **no orphan**: after it
   exits, `pgrep -f server.js` (or `pgrep -f "next start"` for the fallback
   path) shows nothing related to this run.
4. `node bin/cli.mjs --help` and `node bin/cli.mjs --version` both work and
   exit 0.
5. Works when invoked with an absolute path from a **different cwd** (e.g.
   `cd /tmp && node <repo>/bin/cli.mjs --port 9003 --no-open`).

Report exact commands run and their observed output/exit codes.

---

## WI-3 — Token gate

Files: `src/proxy.ts` (new), `src/lib/authToken.ts` (new),
`src/lib/sameOrigin.ts` (modify).

### src/lib/authToken.ts (new)
Helpers for token/cookie comparison. Token comparisons must be constant-time
(`crypto.timingSafeEqual` on SHA-256 digests, since the raw strings may differ
in length which `timingSafeEqual` can't handle directly — hash first to fixed
length, then compare). Export whatever small set of pure functions `proxy.ts`
needs (e.g. `hashToken(token: string): Buffer` and
`tokensMatch(a: string, b: string): boolean`).

### src/proxy.ts (new)
Next.js 16 "Proxy" convention (replaces `middleware.ts`; file lives at repo
root, same level as `src/app` since this repo uses a `src/` dir — so put it at
`src/proxy.ts`; defaults to Node.js runtime automatically, so `node:crypto` is
available without extra config).

Behavior:
1. Read `process.env.LLV_TOKEN`. If unset or empty string, treat as **unset**
   → call `NextResponse.next()` immediately (pure local mode, zero behavior
   change from before this feature existed). This must be byte-identical to
   pre-existing behavior when LLV_TOKEN is absent.
2. Determine `remote`: true if the request has an `x-forwarded-for` header,
   OR if the Host header (port-stripped) is not in `{localhost, 127.0.0.1, ::1}`.
   If not remote, pass through (`NextResponse.next()`).
3. If remote:
   - If cookie `llv_auth` is present and its value matches the token (via the
     constant-time hash compare above) → pass through.
   - Else if query param `k` is present and matches the token → 307 redirect
     to the same URL with `k` stripped (preserve all other query params and
     the path/hash), setting `Set-Cookie: llv_auth=<token>; HttpOnly;
     SameSite=Lax; Path=/; Max-Age=2592000` and additionally `; Secure` when
     `x-forwarded-proto` is `https`.
   - Else:
     - path starts with `/api/` → 403 JSON
       `{ "error": "доступ заборонено: потрібен ключ" }`
     - otherwise → 403 minimal HTML body:
       `Доступ заборонено. Відкрийте посилання з ключем із термінала, де
       запущено viewer (bunx agent-log-viewer --tailscale).`
   - Never echo the token or the cookie value into any response, including
     error responses and logs.
4. `export const config = { matcher: ["/((?!_next/static|favicon.ico).*)"] };`

Edge cases to handle explicitly:
- A malformed/garbage `llv_auth` cookie must not crash — treat as no match.
- Empty-string `LLV_TOKEN` is unset (already covered above).
- Stripping `k` from the redirect URL must preserve every other query param.
- 403 responses never include the token anywhere in body/headers.

### src/lib/sameOrigin.ts (modify)
Currently `ALLOWED_HOSTS` is a fixed `{localhost, 127.0.0.1, ::1}` and the
Origin check requires `originHost === host` exactly. Change to:
- `allowedHosts = {localhost, 127.0.0.1, ::1} ∪ {hostWithoutPort(process.env.LLV_TS_HOST)}`
  when `LLV_TS_HOST` is set (the tailnet DNS name, e.g. `box.tail1234.ts.net`,
  possibly with a port — strip it with the same `hostWithoutPort` helper
  already in the file).
- Require: `hostWithoutPort(Host header) ∈ allowedHosts`, AND, when an Origin
  header is present, `hostWithoutPort(originHost) ∈ allowedHosts` (replacing
  the old strict `originHost === host` equality, since in tailnet mode the
  tailnet DNS name is a legitimate second allowed origin distinct from
  whatever literal Host string arrived).
- Keep the existing DNS-rebinding-pinning code comment/rationale, and extend
  it briefly to note why the tailnet hostname is now also pinned explicitly
  (still an allowlist, not a wildcard — rebinding protection is preserved).
- Do not touch `src/lib/tmux.ts`, `src/app/api/spawn/route.ts`,
  `src/app/api/tmux/route.ts` even though they're callers of this function —
  those files are off-limits (in-flight work elsewhere); the function
  signature must stay compatible with existing call sites.

### Acceptance criteria
Run the server (standalone or `bun start`) with env
`LLV_TOKEN=secret LLV_TS_HOST=box.tail.ts.net`:
1. Plain local curl (no XFF) of `/` and `/api/files` → 200 (local requests
   always pass regardless of token).
2. Same two requests **with** header `X-Forwarded-For: 100.100.1.2` → 403
   (remote, no cookie, no valid key).
3. `curl -i "http://127.0.0.1:<port>/?k=secret" -H "X-Forwarded-For: 100.100.1.2"`
   → 307 with a `Set-Cookie: llv_auth=secret...` header (redirect location has
   no `k` param).
4. Repeating with the `Set-Cookie` value sent back as a `Cookie` header on
   `/api/files` (still with XFF set) → 200.
5. `POST /api/tmux` with `Origin: https://box.tail.ts.net` + the valid cookie
   + XFF header → passes the origin guard in `sameOrigin.ts` (it may still
   403 for other reasons like missing body/CSRF specifics of that route, but
   it must NOT 403 for origin-host reasons — check by comparing against the
   `Origin: http://evil.com` case below to isolate the origin-guard behavior;
   if you cannot fully exercise `/api/tmux`'s full handler because it's
   off-limits to modify, at minimum confirm `rejectCrossOrigin()` returns
   `null` for this case via a small throwaway unit check, then remove the
   throwaway check).
6. Same POST with `Origin: http://evil.com` (+ cookie + XFF) → 403.
7. Without `LLV_TOKEN` set at all, rerun the **four WI-1 checks** verbatim —
   must be byte-identical to WI-1's results.

Report exact status codes and relevant headers for each numbered check.

---

## WI-4 — Tailscale orchestration

Files: `bin/tailscale.mjs` (new), `bin/cli.mjs` (extend with real
`--tailscale`/`--new-token` behavior).

Threat model (why token auth is mandatory here): tailnet exposure grants
transcript read (secrets in logs) and arbitrary command execution
(`/api/tmux` send-keys, `/api/spawn`). Tailnets can contain shared/external
nodes, so token auth is unconditional whenever `--tailscale` is used. The app
still binds loopback only; exposure happens via `tailscale serve` (tailnet-only
by default, a foreground child process, auto-clears when that child exits).
Never use `tailscale funnel` (public internet) and never background the
`serve` child (`--bg`) — it must die when the CLI dies.

### bin/tailscale.mjs (new)
Export functions the CLI wires together:
1. **detect**: `tailscale` on `PATH`, else check
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (macOS fallback).
   Not found → the CLI should exit 1 with:
   `Tailscale не знайдено. Встановіть: https://tailscale.com/download — і повторіть.`
2. **status**: run `tailscale status --json`, parse `BackendState` and
   `Self.DNSName` (strip trailing dot). If `BackendState` is `NeedsLogin` or
   `Stopped`, print guidance to run `tailscale up` and exit 1 (no stack
   trace). If `DNSName` is missing/empty, print guidance about enabling
   MagicDNS/HTTPS certs in the tailnet admin console and exit 1.
3. **serve**: spawn `tailscale serve <port>` as a **foreground** child
   (inherit lifetime with the CLI — killed together). Watch its stderr; if it
   matches `/operator|access denied|permission/i`, print:
   `Tailscale вимагає прав оператора. Виконайте один раз у своєму терміналі:
   sudo tailscale set --operator=$USER — і перезапустіть.`
   (never run `sudo` yourself — only print the instruction). If the serve
   child dies **after** having started successfully, print a warning but
   **keep the local server alive** (don't tear down the whole CLI).
4. **token**: file at `${XDG_CONFIG_HOME:-~/.config}/agent-log-viewer/token`,
   mode `0600`. Content: 32 hex chars from `crypto.randomBytes(16)`. Created
   on first `--tailscale` run if absent; reused on subsequent runs. An
   unreadable/corrupt token file (wrong length, non-hex, permission error) is
   regenerated rather than crashing the CLI.
   `--new-token` forces rotation (write a fresh token, overwrite the file)
   even if one already exists.

### bin/cli.mjs wiring
- On `--tailscale`: run detect → status → (create/reuse/rotate token) →
  set `LLV_TOKEN` and `LLV_TS_HOST` (`Self.DNSName`, trailing dot stripped)
  in the server child's env → spawn the local server as before (still bound
  to `127.0.0.1`, not the tailnet) → spawn `tailscale serve <port>` via the
  serve() function → on readiness, print the extended banner (below),
  including a QR code of the tailnet URL via `qrcode-terminal`
  (`import("qrcode-terminal")`, lazy so plain local runs never pay the cost).
- Non-loopback `--hostname` (from WI-2) combined with `--tailscale` (or used
  standalone): force-enable token mode too (generate/reuse token even without
  `--tailscale`) and print a loud warning, since binding non-loopback without
  a token would expose the app to anyone reaching that interface. This is the
  piece WI-2 deferred to WI-4 — implement it here.
- Ctrl+C / SIGTERM: kill both the server child and the tailscale-serve child
  (if running), exit 0.

Banner additions (Ukrainian) when `--tailscale` is active, appended to the
WI-2 banner:
```
  Tailnet:   https://<dns>/?k=<token>
  [QR code here]
  Посилання містить ключ доступу — не пересилайте його стороннім.
  Після першого відкриття ключ зберігається у cookie на 30 днів.
```

### Acceptance criteria
On this box (tailscale confirmed NOT installed — verified `which tailscale`
returns nothing):
1. `node bin/cli.mjs --tailscale --no-open` exits 1 with the install hint
   above, and starts **no** server process at all (verify no listener came
   up).

With a **fake `tailscale` shim** on `PATH` for testing (write a small script,
place its directory first in `PATH` for the test invocation only — do not
install anything system-wide, do not touch the user's real PATH/profile):
- `status --json` subcommand → prints JSON with
  `BackendState: "Running"`, `Self: { DNSName: "box.tail1234.ts.net." }`
- `serve <port>` subcommand → just sleeps (simulating a healthy running serve)
- a second shim variant whose `serve` instead prints
  `access denied: ... operator ...` to stderr and exits, to test the operator
  hint path

Checks:
2. Banner shows `https://box.tail1234.ts.net/?k=<32 hex chars>`, a QR code
   renders (non-empty terminal QR output), the spawned server's env contains
   both `LLV_TOKEN` (32 hex chars) and `LLV_TS_HOST=box.tail1234.ts.net`.
3. Token file created at `~/.config/agent-log-viewer/token` (or
   `$XDG_CONFIG_HOME` equivalent if you set that for the test) with mode
   `0600`.
4. Running a second time reuses the same token (same file content).
5. `--new-token` rotates it (file content changes).
6. Ctrl+C kills both the server child and the shimmed `tailscale serve`
   child — verify with `pgrep`.
7. With the operator-denial shim variant: CLI prints the
   `sudo tailscale set --operator=$USER` hint and the **local server keeps
   running** (still responds to `curl 127.0.0.1:<port>/api/files`).

Report exact commands, shim script contents used, and observed output for
each check. Use a throwaway `HOME`/`XDG_CONFIG_HOME` for the token-file tests
so you don't touch the real user's `~/.config`.

---

## WI-5 — Docs

Files: `README.md` (modify), `docs/RELEASING.md` (new), `ARCHITECTURE.md`
(modify).

### README.md
- "Run" section: **bunx quickstart first** (`bunx agent-log-viewer`), then
  the existing clone-and-build path second (still works, keep it, just
  reorder/relabel).
- New section "Доступ через Tailscale" (Ukrainian): how `--tailscale` works,
  what gets exposed (tailnet-only via `tailscale serve`, never funnel/public
  internet), the token-in-URL/cookie mechanics, and an explicit security
  paragraph — anyone with tailnet access to this URL can read all agent
  transcripts (including anything sensitive that appeared in a session) and
  can execute commands via the tmux/spawn endpoints, so treat the tailnet URL
  like a credential.
- Do not leave any doc claiming "localhost-only" without the tailnet caveat
  right next to it (the existing "Security model" section in README.md
  currently says "Read-only, localhost-only" — that must be updated: this
  tool is no longer read-only once `/api/tmux`/`/api/spawn` exist, and it is
  no longer localhost-only once `--tailscale` is used — check the actual
  current wording in the file and correct it accurately, don't just bolt on
  a caveat next to a now-false claim).

### docs/RELEASING.md (new)
Concise: version bump → `npm publish` → what `prepack` does automatically →
a cosmetic note that packed file paths in `npm pack --dry-run` output are
absolute-looking/harmless (if that's what you actually observe — verify
first, don't assert without checking).

### ARCHITECTURE.md
Add sections: `bin/` (cli.mjs, tailscale.mjs — one-paragraph role each),
`src/proxy.ts` (what it gates, matcher), `sameOrigin.ts` allowed-hosts change,
and an env-contract table: `LLV_TOKEN`, `LLV_TS_HOST`, `LLV_STANDALONE` —
what each does, who sets it (CLI sets the first two when relevant; prepack
sets the third).

### Acceptance criteria
- README quickstart section must be literally copy-pasteable and true given
  what you actually built (if `bunx agent-log-viewer` can't work yet because
  it isn't published to npm, say so plainly — don't claim something
  unverifiable as working; state it as "once published" if that's the honest
  status).
- Grep both docs for "localhost-only" / "read-only" and confirm no
  unqualified false claim remains.

---

## Final verification (after WI-5, whole branch)

Run and report results for:
- `npm publish --dry-run` → file list must be **only** `bin/`, `dist/`,
  `README.md`, `LICENSE` (if present), `package.json` — nothing else leaks in
  (e.g. no `src/`, no `.next/` outside `dist/standalone`, no `docs/`).
- `bunx tsc --noEmit` → clean.
- `bun run lint` → clean.
- `bun run build` → clean, green.
- Add `dist/` to `.gitignore` (it's a publish artifact, not a repo file) if
  not already covered by an existing pattern (`/build` etc. — check first,
  don't add a redundant duplicate rule).

Do not commit. Report back file-by-file what changed and the exact output of
every verification command above (paste real terminal output, not summaries
you didn't actually run).
