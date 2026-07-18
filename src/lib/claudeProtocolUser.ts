/**
 * The single meta/command classification contract for Claude `type:"user"`
 * transcript records, shared by feed rendering and turn-duration scanning
 * (issue #406). A record classified here as protocol is harness metadata —
 * slash-command echoes, caveat/task-notification wrappers, interrupt
 * sentinels, compaction summaries, relayed-session envelopes: the feed
 * renders it as a system row and the turn scanner must never let it initiate
 * or steer a work-duration window. Human provenance (`origin.kind:"human"`,
 * `promptSource:"typed"`) always outranks the wrapper shape.
 *
 * Pure and dependency-free on purpose: the feed parser bundles for the
 * client, so this module must not pull in `node:fs`-backed scanner helpers.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

/** Flattened text of a Claude user record's `message.content` — a plain
    string or the joined `text` parts of a content array. */
export function claudeUserText(content: unknown): string {
  return typeof content === "string" ? content : arr(content).map((part) => str(part.text)).filter(Boolean).join("\n");
}

/** True when a Claude user record is harness metadata rather than a human or
    relaying-agent prompt. See the module doc for the contract. */
export function isClaudeProtocolUser(record: Record<string, unknown>): boolean {
  const originKind = str(rec(record.origin).kind);
  /* Claude records queued human input with the same envelope fields that its
     harness uses. Explicit human provenance and typed prompts keep their
     transcript role through any wrapper text. */
  if (originKind === "human" || str(record.promptSource) === "typed") return false;
  if (
    record.isMeta === true ||
    record.isCompactSummary === true ||
    "interruptedMessageId" in record ||
    "promptSource" in record ||
    "origin" in record
  ) {
    return true;
  }
  const text = claudeUserText(rec(record.message).content).trim();
  return (
    /^\[Request interrupted by user\]$/.test(text) ||
    /^<local-command-caveat>\s*Caveat:[\s\S]*<\/local-command-caveat>$/.test(text) ||
    /^<task-notification\b[^>]*>[\s\S]*<\/task-notification>$/.test(text) ||
    /^This came from another Claude session\b[\s\S]*not typed by your user[\s\S]*$/.test(text)
  );
}
