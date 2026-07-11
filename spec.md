# Issue 121: deployment proxy request forwarding

## Task statement

Investigate the first managed Viewer cutover failure where `serveViewerDeploymentProxy` accepted connections on the stable listener while returning zero response bytes. Repair request forwarding for the production `bun-container` runtime, preserve the target-file listener-switch design, cover the failure with a real TCP regression test, and remove the public-repository SSH bootstrap papercut.

## Acceptance criteria

- AC1: The deployment proxy forwards a request sent immediately after downstream TCP connection and returns the candidate Viewer response.
- AC2: The proxy preserves request bytes while its upstream connection is being established under production-image Bun 1.2.18.
- AC3: A regression test drives an external TCP client through an in-process proxy and upstream listener.
- AC4: Missing, invalid, or recursive release targets continue to receive the existing `503 Service Unavailable` response.
- AC5: The default canonical remote for the public repository uses HTTPS and remains configurable through `LLV_VIEWER_CANONICAL_REMOTE`.
- AC6: `bun test` and `bunx tsc --noEmit` pass.
- AC7: Investigation and verification use unused high ports and leave the production listener, runtime-host, legacy Viewer, and managed candidate lifecycle unchanged.
