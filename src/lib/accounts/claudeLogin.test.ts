import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("./claude");
const { ClaudeLoginSupervisor, cleanClaudeLoginOutput, loginUrlFromOutput } = await import("./claudeLogin");
type ClaudeLoginPorts = import("./claudeLogin").ClaudeLoginPorts;

class FakeChild extends EventEmitter { pid = 4242; stdout = new EventEmitter(); stderr = new EventEmitter(); writes: string[] = []; stdin = { write: (text: string) => { this.writes.push(text); return true; }, end: () => undefined }; }
let child: FakeChild; let signals: string[];
function ports(): ClaudeLoginPorts { return { spawn: () => child as never, kill: (_pid, signal) => { signals.push(signal); }, pidStartToken: () => "start-1", isExpectedClaude: () => true, status: async () => ({ loggedIn: true, method: "oauth", email: "a@example.test", plan: "max" }), now: () => 1_000, setTimeout: (fn, ms) => { if (ms <= 2_000) fn(); return {} as NodeJS.Timeout; }, clearTimeout: () => undefined }; }
beforeEach(() => { fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }); child = new FakeChild(); signals = []; });
afterAll(() => { if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE; if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME; fs.rmSync(SANDBOX, { recursive: true, force: true }); });

test("parser handles ANSI and chunks while only allowlisted URLs survive", () => {
  expect(cleanClaudeLoginOutput("\u001b[31mhello\u001b[0m")).toBe("hello");
  expect(loginUrlFromOutput("https://evil.test/x https://claude.ai/login?a=1")).toBe("https://claude.ai/login?a=1");
});

test("fake supervised login accepts one bounded code, contains it, and cancels without tmux", async () => {
  const account = createManagedClaudeAccount("Work");
  const supervisor = new ClaudeLoginSupervisor(ports(), () => true);
  const operation = supervisor.start(account.id);
  child.stdout.emit("data", Buffer.from("open \u001b[32mhttps://claude.ai/oauth\u001b[0m"));
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "awaiting_code", loginUrl: "https://claude.ai/oauth", acceptsCode: true }));
  await supervisor.input(operation.operationId, "one-time-code");
  expect(child.writes).toEqual(["one-time-code\n"]);
  await expect(supervisor.input(operation.operationId, "again")).rejects.toThrow("already submitted");
  const cancelled = await supervisor.cancel(operation.operationId);
  expect(cancelled.phase).toBe("canceled"); expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(JSON.stringify(cancelled)).not.toContain("one-time-code");
});

test("restart reconciliation rejects PID reuse and preserves only an interrupted safe DTO", () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000001", accountId: "work", phase: "awaiting_browser", pid: 4242, startToken: "old-start", generation: 3, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), pidStartToken: () => "new-process" }, () => true);
  expect(signals).toEqual([]);
  expect(supervisor.get("00000000-0000-4000-8000-000000000001")).toEqual(expect.objectContaining({ phase: "interrupted", loginUrl: null, acceptsCode: false }));
});
