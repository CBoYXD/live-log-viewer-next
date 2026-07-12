# PR #143: Claude limits backoff and footer visibility

## Task statement

Back off Claude limits polling after provider failures, honor `Retry-After`, distinguish re-authentication failures, and keep footer status honest in English and Ukrainian.

## Acceptance criteria

- AC1: Failed limits reads are cached per engine and account for a cooldown.
- AC2: Consecutive Claude 429 responses use a 1m, 2m, 4m exponential schedule capped at 15m.
- AC3: A valid `Retry-After` extends the cooldown when required by the provider.
- AC4: Concurrent refreshes for one engine and account share one upstream request.
- AC5: A successful read resets the 429 backoff and preserves the fresh-cache fast path.
- AC6: Claude 429 provenance shows provider throttling and the next retry time, including when retained quota windows come from cache.
- AC7: Claude 401 provenance shows re-login guidance, including when retained quota windows come from cache.
- AC8: Footer status strings remain aligned in English and Ukrainian.
- AC9: `bun test` and `bunx tsc --noEmit` pass.
