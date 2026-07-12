# PR #154: Chime loop on project switch and limits no-data UI state

## Task statement

Stop the lifecycle-chime cascade triggered by selected-project hydration, preserve real question and push notifications, and verify the limits footer explains throttling for a never-cached Claude account.

## Acceptance criteria

- AC1: Production browser evidence identifies the lifecycle Web Audio path and reports the measured firing volume and rate.
- AC2: Switching projects seeds previously unseen historical attention entries silently.
- AC3: Conversation transition history survives project switches and repeated polls.
- AC4: A known live-to-waiting transition during hydration remains audible, and a genuinely new same-scope question rings once.
- AC5: Scanner `notifyQuestion` web push delivery remains unchanged and keeps its persisted attention-id guard.
- AC6: A regression test covers the production-sized 464-entry project hydration batch.
- AC7: A never-cached Claude account with `oauth-rate-limited` provenance shows the throttled state and next retry time in the limits footer.
- AC8: The diff contains no engine or tmux changes.
- AC9: The patched browser replay records zero lifecycle chimes for the reproduced project switch.
- AC10: `bun test` and `bunx tsc --noEmit` pass.

## Validation gates

- Headless Puppeteer production baseline and patched local replay.
- `bun test`.
- `bunx tsc --noEmit`.
- Non-draft PR with a clean merge state.
