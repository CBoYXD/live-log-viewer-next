# Issue 26: TTS read answer aloud

## Task statement

Add OpenAI text-to-speech for assistant answers through `/api/tts`, expose play/stop controls only when an environment API key is available, stream audio, and exclude tool calls and code blocks from spoken text.

## Acceptance criteria

- AC1: `/api/tts` uses `OPENAI_API_KEY`, returns a clean `501` when unavailable, and streams successful OpenAI audio responses.
- AC2: Assistant prose messages expose play/stop controls while structured tool-call rows remain excluded.
- AC3: Spoken text excludes fenced, unmatched fenced, empty fenced, and indented code blocks.
- AC4: Rapid interactions cancel stale synthesis and playback, with no overlapping audio or leaked object URLs.
- AC5: Answers above the API limit are bounded to 4,096 characters before synthesis.
- AC6: Invalid JSON values, including `null`, receive a clean `400` response.
- AC7: `bun test` and `bunx tsc --noEmit` pass.
