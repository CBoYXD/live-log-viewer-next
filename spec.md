# Issues 31 and 113: deterministic agent reaping and verified tmux kills

## Task statement

Implement deterministic lifecycle cleanup for stale agent conversations and a reliable conversation-kill primitive. Resolve kills through registry-owned tmux pane identities, verify termination of the pane shell and recorded agent processes, apply policy TTLs to eligible automated conversations, protect active or user-managed conversations, schedule cleanup through the durable controller, journal active attempts, and expose a dry-run lifecycle report.

## Acceptance criteria

- AC1: Conversation kills resolve the target from registry-owned pane IDs and return a clear error when the target cannot be resolved.
- AC2: A successful kill requires every process start identity, verifies the tmux pane shell and live argv, and applies the persisted identity to every detached headless-reviewer liveness and signaling path.
- AC3: Reaper classification covers flow workers, headless reviewers, Viewer-launched probes, resume duplicates, and agents whose transcripts are missing, using the policy TTL assigned to each class.
- AC4: Automatic cleanup protects user-authored conversations, incomplete or failed authorship scans, agents in the middle of a turn, externally managed probe-shaped agents, and conversations manually placed on the board.
- AC5: Reaper evaluation runs through the durable controller and journals active reap attempts.
- AC6: `GET /api/lifecycle/reaper` exposes the dry-run report without actuating cleanup.
- AC7: Automatic reap actuation requires `LLV_REAPER_ENABLED=1`.
- AC8: Focused tests cover pane and detached-process kill resolution, process-death verification, classification, protection rules, scheduling, journaling, and the lifecycle API.
- AC9: `bun test` and `bunx tsc --noEmit` pass.
- AC10: Flow cleanup consumes immutable-SHA-bound GitHub PR merge evidence that survives squash merges, stale local refs, and deleted worktrees.
- AC11: One candidate actuation failure is journaled and leaves later eligible candidates available for the same sweep.
- AC12: Conversation kill acquires the per-session operation lock, refreshes registry host evidence inside the lock, and marks the verified entry unhosted after termination.
