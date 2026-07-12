import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import { CodexAppServerHost } from "./codexAppServerHost";
import { adoptCodexRegistryHosts, persistCodexHost, startCodexStructuredHost, structuredHostsEnabled } from "./registry";

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<Record<string, unknown>> = [];
  private turn = 0;

  constructor(private readonly threadId = "thread-149") {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(id: string, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.144.1 (Linux)" });
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (method === "thread/start" || method === "thread/resume") return this.respond(message.id, { thread: { id: this.threadId, path: `/sessions/${this.threadId}.jsonl` } });
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      return;
    }
    if (method === "turn/steer") return this.respond(message.id, { turnId: (message.params as { expectedTurnId: string }).expectedTurnId });
    if (method === "turn/interrupt") return this.respond(message.id, {});
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

function fakeSpawn(server: FakeAppServer, captured?: { options?: SpawnOptionsWithoutStdio }) {
  return (_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    if (captured) captured.options = options;
    return server as unknown as ChildProcessWithoutNullStreams;
  };
}

async function nextEvent(iterable: AsyncIterable<unknown>): Promise<unknown> {
  return (await iterable[Symbol.asyncIterator]().next()).value;
}

describe("CodexAppServerHost", () => {
  test("fans out replay, fences steering, answers attention, and persists host columns", async () => {
    const server = new FakeAppServer();
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      env: { NODE_ENV: "test", PATH: process.env.PATH, OPENAI_API_KEY: "must-not-cross" },
      spawnProcess: fakeSpawn(server, captured),
    });
    expect((captured.options?.env as NodeJS.ProcessEnv).OPENAI_API_KEY).toBeUndefined();
    expect(host.identity).toEqual({ threadId: "thread-149", path: "/sessions/thread-149.jsonl" });

    const first = host.attach(0);
    const second = host.attach(0);
    expect(await nextEvent(first)).toEqual({ kind: "session-status", status: "idle", seq: 1 });
    expect(await nextEvent(second)).toEqual({ kind: "session-status", status: "idle", seq: 1 });

    const started = await host.send({ id: "delivery-one", text: "begin" });
    expect(started).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(await host.send({ id: "stale", text: "wrong", expectedTurnId: "turn-old" })).toEqual({ outcome: "rejected", reason: "stale-turn" });
    expect(await host.send({ id: "delivery-two", text: "steer", expectedTurnId: "turn-1" })).toEqual({ outcome: "steered", turnId: "turn-1" });
    const steer = server.requests.find((request) => request.method === "turn/steer")!;
    expect(steer.params).toMatchObject({ expectedTurnId: "turn-1", clientUserMessageId: "delivery-two" });

    server.request("approval-1", "item/commandExecution/requestApproval", { command: "touch allowed" });
    await Bun.sleep(0);
    const attention = (await host.health()).pendingAttention[0]!;
    expect(attention).toBe("item/commandExecution/requestApproval:approval-1");
    await host.answer(attention, { decision: "accept" });
    expect(server.requests.at(-1)).toMatchObject({ id: "approval-1", result: { decision: "accept" } });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: host.identity.threadId };
    registry.upsert({
      key,
      artifactPath: host.identity.path!,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      claimEpoch: 7,
      claimOwner: "viewer",
      pendingAction: null,
    });
    await persistCodexHost(registry, key, host, 7);
    expect(registry.snapshot().entries["codex:thread-149"]?.structuredHost).toMatchObject({
      kind: "codex-app-server",
      endpoint: "stdio:4242",
      eventCursor: 3,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 7,
      activeTurnRef: "turn-1",
      pendingAttention: [],
    });
    await host.release();
  });

  test("resumes the same engine thread after a host-process replacement", async () => {
    const first = await CodexAppServerHost.start({ cwd: "/repo", spawnProcess: fakeSpawn(new FakeAppServer("durable-thread")) });
    await first.release();
    const replacementServer = new FakeAppServer("durable-thread");
    const replacement = await CodexAppServerHost.adopt("durable-thread", { cwd: "/repo", spawnProcess: fakeSpawn(replacementServer) });
    expect(replacement.identity.threadId).toBe("durable-thread");
    expect(replacementServer.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    await replacement.release();
  });

  test("requires an exact opt-in value", async () => {
    expect(structuredHostsEnabled({ NODE_ENV: "test" })).toBeFalse();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" })).toBeFalse();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" })).toBeTrue();
    await expect(startCodexStructuredHost(
      { cwd: "/repo", spawnProcess: fakeSpawn(new FakeAppServer()) },
      { NODE_ENV: "test" },
    )).rejects.toThrow("structured hosts are disabled");
  });

  test("boot adoption resumes every flagged Codex registry row", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "adopted-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/adopted-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 12,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 3,
        activeTurnRef: null,
        pendingAttention: [],
      },
      claimEpoch: 3,
      claimOwner: "viewer",
      pendingAction: null,
    });
    const disabled = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", spawnProcess: fakeSpawn(new FakeAppServer("adopted-thread")) }),
      { NODE_ENV: "test" },
    );
    expect(disabled).toEqual([]);

    const server = new FakeAppServer("adopted-thread");
    const adopted = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", spawnProcess: fakeSpawn(server) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toHaveLength(1);
    expect(server.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost).toMatchObject({
      eventCursor: 13,
      writerClaimEpoch: 3,
      endpoint: "stdio:4242",
    });
    await adopted[0]!.host.release();
  });
});
