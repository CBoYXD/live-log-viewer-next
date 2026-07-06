import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed, createFeedSession, type Item } from "./parse";

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;
const codexFile = { path: "/tmp/x.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const plainFile = { path: "/tmp/x.output", engine: "codex", fmt: "plain", activity: "recent" } as FileEntry;

/* Auto-incrementing ids inside plain-cmd items depend on how many pushes the
   session has ever seen, so a slid window numbers them differently than a
   fresh one-shot parse. The ids are opaque uniqueness tokens; normalize them
   before structural comparison. */
function normalize(items: Item[]): unknown {
  return JSON.parse(
    JSON.stringify(items, (key, value) =>
      typeof value === "string" && (key === "id" || key === "ids") ? value.replace(/^plain-\d+-/, "plain-N-") : value,
    ),
  );
}

/**
 * Feed `lines` into one session chunk-by-chunk with useLogTail's cap-trim
 * semantics, and after every chunk compare the incremental snapshot against a
 * fresh one-shot parse of the same window.
 */
function assertParity(file: FileEntry, lines: string[], opts: { cap?: number; chunks?: number[]; showSvc?: boolean; live?: boolean } = {}) {
  const { cap = 0, chunks = [1, 3, 2, 5, 1, 4], showSvc = false, live = false } = opts;
  const session = createFeedSession({ engine: file.engine, fmt: file.fmt, showSvc, lineFilter: "" });
  const liveFile = { ...file, activity: live ? "live" : file.activity } as FileEntry;
  let window: string[] = [];
  let start = 0;
  let fed = 0;
  let step = 0;
  while (fed < lines.length) {
    const take = Math.min(chunks[step % chunks.length], lines.length - fed);
    window = window.concat(lines.slice(fed, fed + take));
    fed += take;
    step += 1;
    if (cap > 0 && window.length > cap) {
      start += window.length - cap;
      window = window.slice(-cap);
    }
    const incremental = session.feed(window, start, live);
    const oneShot = buildFeed(liveFile, window, showSvc, "");
    expect(normalize(incremental.items.map((entry) => entry.item))).toEqual(normalize(oneShot.items));
    expect(incremental.hiddenServiceCount).toBe(oneShot.hiddenServiceCount);
  }
  return session;
}

const claudeUser = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-06T10:00:00Z", message: { content: text } });
const claudeProse = (text: string, stop: string | null = "end_turn") =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:01Z",
    message: { stop_reason: stop, content: [{ type: "text", text }] },
  });
const claudeThink = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
const claudeTool = (id: string, name: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:02Z",
    message: { content: [{ type: "tool_use", id, name, input: { command } }] },
  });
const claudeResult = (id: string, text: string, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-07-06T10:00:03Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
  });
const claudeSend = (id: string, to: string, message: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:04Z",
    message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to, summary: "s", message } }] },
  });

describe("feed session parity with one-shot parse", () => {
  test("claude transcript: tools, results, grouping, tmsg delivery, compaction", () => {
    const lines = [
      claudeUser("зроби перший крок"),
      claudeThink("мізкую про перший крок і план дій"),
      claudeTool("c1", "Bash", "ls -la"),
      claudeResult("c1", "total 8"),
      claudeProse("Готово, ось результат."),
      // A run of five commands: folds into one cmd-group once a prose lands after.
      claudeTool("g1", "Bash", "echo 1"),
      claudeResult("g1", "1"),
      claudeTool("g2", "Bash", "echo 2"),
      claudeResult("g2", "exited with code 3"),
      claudeTool("g3", "Read", "cat a.txt"),
      claudeResult("g3", "aaa"),
      claudeTool("g4", "Bash", "echo 4"),
      claudeResult("g4", "4"),
      claudeTool("g5", "Bash", "echo 5"),
      claudeResult("g5", "5"),
      claudeProse("Серія завершена."),
      claudeSend("m1", "worker-1", "перевір гілку"),
      claudeResult("m1", '{"success": true, "msg_id": "abc123"}'),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "t", compactMetadata: { trigger: "auto", preTokens: 9000 } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "Підсумок розмови." } }),
      claudeUser("продовжуй"),
      claudeProse("Продовжую."),
    ];
    assertParity(claudeFile, lines);
    assertParity(claudeFile, lines, { cap: 7, chunks: [2, 1, 3] });
    assertParity(claudeFile, lines, { showSvc: true });
    assertParity(claudeFile, lines, { live: true, chunks: [1] });
  });

  test("codex rollout: echo dedup, shell calls, compaction pair, service rows", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "t0", payload: { model: "gpt-5.2", cwd: "/tmp" } }),
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "запусти тести" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t1", payload: { type: "user_message", message: "запусти тести" } }),
      JSON.stringify({ type: "event_msg", timestamp: "t2", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "t3", payload: { type: "function_call", name: "shell", call_id: "s1", arguments: JSON.stringify({ command: "bun test" }) } }),
      JSON.stringify({ type: "response_item", timestamp: "t4", payload: { type: "function_call_output", call_id: "s1", output: "42 pass" } }),
      JSON.stringify({ type: "response_item", timestamp: "t5", payload: { type: "reasoning" } }),
      JSON.stringify({ type: "response_item", timestamp: "t6", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Тести зелені." }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t6", payload: { type: "agent_message", message: "Тести зелені." } }),
      JSON.stringify({ type: "compacted", timestamp: "t7" }),
      JSON.stringify({ type: "event_msg", timestamp: "t7", payload: { type: "context_compacted" } }),
      JSON.stringify({ type: "event_msg", timestamp: "t8", payload: { type: "task_complete" } }),
    ];
    assertParity(codexFile, lines);
    assertParity(codexFile, lines, { showSvc: true });
    /* The sliding-cap variant leaves out the doubled echo records: a full
       re-parse of a window whose original slid out resurrects the echo as a
       fresh bubble, while the session correctly keeps it deduplicated — that
       divergence is the artifact, so parity is asserted without it. */
    const noEcho = lines.filter((_, idx) => idx !== 2 && idx !== 8 && idx !== 10);
    assertParity(codexFile, noEcho, { cap: 4, chunks: [1, 2] });
    assertParity(codexFile, noEcho, { cap: 3, chunks: [1] });
  });

  test("plain job log: command lifecycle and a pending structured block", () => {
    const lines = [
      "[10:00] Running command: /usr/bin/zsh -lc bun run build",
      "[10:01] Command completed",
      "[10:01] Проміжна відповідь агента",
      "[10:02] Running command: bun test",
      "[10:03] Command failed: exited with code 1",
      "plain raw line without brackets",
    ];
    assertParity(plainFile, lines, { chunks: [1] });
    assertParity(plainFile, lines, { cap: 3, chunks: [2, 1] });
  });

  test("window slide past a tool_use: its result degrades to the svc fallback", () => {
    const lines = [
      claudeTool("c1", "Bash", "sleep 100"),
      claudeUser("а"),
      claudeUser("б"),
      claudeUser("в"),
      claudeResult("c1", "done late"),
    ];
    // cap 3 evicts the tool_use before its result arrives on both sides.
    assertParity(claudeFile, lines, { cap: 3, chunks: [1], showSvc: true });
  });
});

describe("feed session identity stability", () => {
  test("appending prose keeps every existing item identity", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("раз"), claudeProse("один"), claudeUser("два")];
    const before = session.feed(lines, 0, true);
    const after = session.feed([...lines, claudeProse("другий")], 0, true);
    expect(after.items.length).toBe(before.items.length + 1);
    for (let i = 0; i < before.items.length; i += 1) {
      expect(after.items[i].item).toBe(before.items[i].item);
      expect(after.items[i].key).toBe(before.items[i].key);
    }
  });

  test("a tool_result changes only its own cmd item", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("го"), claudeTool("c1", "Bash", "ls"), claudeTool("c2", "Bash", "pwd")];
    const before = session.feed(lines, 0, true);
    const after = session.feed([...lines, claudeResult("c1", "ok done")], 0, true);
    // user bubble and the untouched second call keep their identity
    expect(after.items[0].item).toBe(before.items[0].item);
    expect(after.items[2].item).toBe(before.items[2].item);
    // the resolved call is a fresh object with the result attached
    expect(after.items[1].item).not.toBe(before.items[1].item);
    const resolved = after.items[1].item;
    if (resolved.kind !== "cmd") throw new Error("expected cmd item");
    expect(resolved.call.status).toBe("ok");
    expect(after.items[1].key).toBe(before.items[1].key);
  });

  test("idempotent re-feed of an unchanged window returns the cached snapshot", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("раз"), claudeProse("один")];
    const first = session.feed(lines, 0, false);
    const second = session.feed(lines, 0, false);
    expect(second).toBe(first);
  });

  test("a folded cmd-group keeps its identity across unrelated appends", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      lines.push(claudeTool("g" + i, "Bash", "echo " + i), claudeResult("g" + i, String(i)));
    }
    lines.push(claudeProse("після серії"));
    const before = session.feed(lines, 0, false);
    const group = before.items[0].item;
    expect(group.kind).toBe("cmd-group");
    const after = session.feed([...lines, claudeProse("ще одна відповідь")], 0, false);
    expect(after.items[0].item).toBe(group);
  });

  test("prepended history resets the session and reparses the wider window", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const older = [claudeUser("стара репліка")];
    const recent = [claudeUser("нова"), claudeProse("відповідь")];
    session.feed(recent, 0, false);
    const widened = session.feed(older.concat(recent), -1, false);
    expect(normalize(widened.items.map((entry) => entry.item))).toEqual(
      normalize(buildFeed(claudeFile, older.concat(recent), false, "").items),
    );
  });
});
