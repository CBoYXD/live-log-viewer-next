<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:worktree-grouping -->
# Worktree → project grouping (canonical — do not re-break)

Agents run tasks inside **worktree checkouts**. Every session that runs from a
worktree MUST group in the sidebar under its **parent repo's** project — never
as its own lookalike project. This is one algorithm, enforced in
`src/lib/scanner/describe.ts` by `projectInfoFromCwd(cwd)`, which resolves the
parent repo by trying these recognizers in order:

1. `worktreeFromPath` — Claude worktrees at `<repo>/.claude/worktrees/<name>/…`
2. `worktreeFromGitFile` — any linked git worktree, resolved from its `.git`
   **file** (`gitdir:` pointer) — works **only while the checkout exists on disk**
3. `worktreeFromCodexPath` — Codex worktrees at `~/.codex/worktrees/<hash>/<Repo>`

**The invariant that keeps biting:** a worktree's grouping must survive the
checkout being **deleted**. Codex removes its worktrees when a task ends, so any
mapping that finds the parent repo only by reading on-disk git metadata (#2)
silently fails afterward and the session fragments into a phantom
`-codex-worktrees-<hash>-<Repo>` project. Recognize each layout by **path**
(#1, #3) so a finished/deleted worktree still names the right project. Live and
dead checkouts of the same repo must resolve to the **same** project name.

When adding a new agent/worktree layout: add a pure path recognizer beside these,
wire it into `projectInfoFromCwd`, and add a "deleted worktree still groups under
its parent repo" case to `describe.test.ts`. Don't rely on the checkout being
present, and don't invent a second naming scheme.
<!-- END:worktree-grouping -->
