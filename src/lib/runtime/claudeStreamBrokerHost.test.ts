import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import {
  ClaudeStreamBrokerHost,
  FileClaudeDeliveryLedger,
  type ClaudeDeliveryLedger,
  type ClaudeDeliveryState,
} from "./claudeStreamBrokerHost";
import type { RuntimeEventStore } from "./eventStore";
import type { QueueEntry, RuntimeEvent } from "./engineHost";
import { adoptClaudeRegistryHosts, startClaudeStructuredHost } from "./registry";

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();

  load(sessionId: string): RuntimeEvent[] {
    return structuredClone(this.events.get(sessionId) ?? []);
  }

  append(sessionId: string, event: RuntimeEvent): void {
    const events = this.events.get(sessionId) ?? [];
    events.push(structuredClone(event));
    this.events.set(sessionId, events);
  }
}

class RecordingDeliveryLedger implements ClaudeDeliveryLedger {
  readonly order: string[] = [];
  private readonly states = new Map<string, ClaudeDeliveryState[]>();

  load(sessionId: string): ClaudeDeliveryState[] {
    return structuredClone(this.states.get(sessionId) ?? []);
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    this.order.push(`ledger:${entry.id}`);
    const states = this.states.get(sessionId) ?? [];
    states.push({ entry: structuredClone(entry), disposition, delivered: false });
    this.states.set(sessionId, states);
  }

  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null): void {
    this.order.push(`confirmed:${entryId}`);
    const state = this.states.get(sessionId)?.find((candidate) => candidate.entry.id === entryId);
    if (state) {
      state.delivered = true;
      state.engineMessageId = engineMessageId;
    }
  }
}

class FakeClaude extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5150;
  readonly signals: NodeJS.Signals[] = [];
  readonly inputs: Array<Record<string, unknown>> = [];
  sessionId = "";

  constructor(private readonly ledger: RecordingDeliveryLedger) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          const input = JSON.parse(line) as Record<string, unknown>;
          this.inputs.push(input);
          const message = input.message as { content?: Array<{ text?: string }> } | undefined;
          if (input.type === "user") {
            this.ledger.order.push(`stdin:${message?.content?.[0]?.text}`);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  }

  emitJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

function fakeSpawn(
  child: FakeClaude,
  captured: { args?: string[]; options?: SpawnOptionsWithoutStdio },
) {
  return (_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    captured.args = args;
    captured.options = options;
    const sessionIndex = args.indexOf("--session-id");
    child.sessionId = args[sessionIndex + 1] ?? "";
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

async function nextEvent(iterator: AsyncIterator<RuntimeEvent>): Promise<RuntimeEvent> {
  const next = await iterator.next();
  if (next.done) throw new Error("event stream ended");
  return next.value;
}

describe("ClaudeStreamBrokerHost", () => {
  test("persists sends before stdin and fans durable events to late viewers", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const eventStore = new MemoryEventStore();
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "must-not-cross",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-cross",
        PRIVATE_SERVICE_TOKEN: "must-not-cross",
      },
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.197" }),
      spawnProcess: fakeSpawn(child, captured),
    });

    expect(captured.options?.env).toEqual({ NODE_ENV: "test", PATH: process.env.PATH });
    expect(captured.args).toContain("--input-format");
    expect(captured.args).toContain("--output-format");
    expect(captured.args).toContain("--safe-mode");
    expect(captured.args).toContain("--replay-user-messages");
    expect(captured.args?.slice(-2)).toEqual(["--session-id", host.identity.sessionId]);
    const owner = host.attach(0)[Symbol.asyncIterator]();
    expect(await nextEvent(owner)).toEqual({ kind: "session-status", status: "idle", seq: 1 });

    const receipt = await host.send({ id: "delivery-one", text: "begin" });
    expect(receipt).toEqual({ outcome: "turn-started", turnId: "delivery-one" });
    expect(ledger.order.slice(0, 2)).toEqual(["ledger:delivery-one", "stdin:begin"]);

    child.emitJson({ type: "system", subtype: "init", session_id: host.identity.sessionId, apiKeySource: "none", model: "claude-test" });
    child.emitJson({ type: "user", session_id: host.identity.sessionId, uuid: "user-one", message: { role: "user", content: [{ type: "text", text: "begin" }] } });
    child.emitJson({ type: "assistant", session_id: host.identity.sessionId, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    child.emitJson({ type: "result", subtype: "success", session_id: host.identity.sessionId, result: "done" });

    expect(await nextEvent(owner)).toEqual({ kind: "turn-started", turnId: "delivery-one", seq: 2 });
    expect(await nextEvent(owner)).toMatchObject({ kind: "item", turnId: "delivery-one", phase: "completed" });
    expect(await nextEvent(owner)).toEqual({ kind: "delta", turnId: "delivery-one", text: "done", seq: 4 });
    expect(await nextEvent(owner)).toMatchObject({ kind: "item", turnId: "delivery-one", phase: "completed" });
    expect(await nextEvent(owner)).toEqual({ kind: "turn-ended", turnId: "delivery-one", status: "completed", seq: 6 });
    expect(await nextEvent(owner)).toEqual({ kind: "session-status", status: "idle", seq: 7 });
    expect(ledger.order).toContain("confirmed:delivery-one");

    const late = host.attach(3)[Symbol.asyncIterator]();
    expect(await nextEvent(late)).toEqual({ kind: "delta", turnId: "delivery-one", text: "done", seq: 4 });
    expect((await host.health()).account).toEqual({ type: "claude.ai", planType: "max" });
    await host.release();
  });

  test("queues ordinary active-turn sends and resumes the same durable session", async () => {
    const ledger = new RecordingDeliveryLedger();
    const eventStore = new MemoryEventStore();
    const firstChild = new FakeClaude(ledger);
    const first = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(firstChild, {}),
    });
    const sessionId = first.identity.sessionId;
    expect(await first.send({ id: "first", text: "one" })).toEqual({ outcome: "turn-started", turnId: "first" });
    expect(await first.send({ id: "second", text: "two" })).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    expect(await first.send({ id: "second", text: "two" })).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    expect(firstChild.inputs.filter((input) => input.type === "user")).toHaveLength(2);
    firstChild.emitJson({ type: "user", session_id: sessionId, uuid: "user-one", message: { role: "user", content: [{ type: "text", text: "one" }] } });
    firstChild.emitJson({ type: "result", subtype: "success", session_id: sessionId });
    expect((await first.health()).activeTurnRef).toBe("second");
    firstChild.emitJson({ type: "user", session_id: sessionId, uuid: "user-two", message: { role: "user", content: [{ type: "text", text: "two" }] } });
    firstChild.emitJson({ type: "result", subtype: "success", session_id: sessionId });
    await first.release();

    const replacementChild = new FakeClaude(ledger);
    const captured: { args?: string[] } = {};
    const replacement = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(replacementChild, captured),
    });
    expect(captured.args).toContain("--resume");
    expect(captured.args?.at(captured.args.indexOf("--resume") + 1)).toBe(sessionId);
    expect(await replacement.send({ id: "second", text: "two" })).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    expect(replacementChild.inputs).toHaveLength(0);
    await replacement.release();
  });

  test("retries a ledgered pre-actuation entry and confirms an actuated entry from transcript", async () => {
    const pendingLedger = new RecordingDeliveryLedger();
    pendingLedger.recordQueued("pending-session", { id: "pending", text: "retry me" }, "turn-started");
    const pendingChild = new FakeClaude(pendingLedger);
    const pending = await ClaudeStreamBrokerHost.adopt("pending-session", {
      cwd: "/repo",
      deliveryLedger: pendingLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(pendingChild, {}),
    });
    expect(await pending.send({ id: "pending", text: "retry me" })).toEqual({ outcome: "turn-started", turnId: "pending" });
    expect(pendingChild.inputs.filter((input) => input.type === "user")).toHaveLength(1);
    await pending.release();

    const confirmedLedger = new RecordingDeliveryLedger();
    confirmedLedger.recordQueued("confirmed-session", { id: "confirmed", text: "already sent" }, "turn-started");
    const confirmedChild = new FakeClaude(confirmedLedger);
    const confirmed = await ClaudeStreamBrokerHost.adopt("confirmed-session", {
      cwd: "/repo",
      deliveryLedger: confirmedLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [{ text: "already sent", uuid: "transcript-user", timestamp: new Date().toISOString() }],
      spawnProcess: fakeSpawn(confirmedChild, {}),
    });
    expect(await confirmed.send({ id: "confirmed", text: "already sent" })).toEqual({ outcome: "turn-started", turnId: "confirmed" });
    expect(confirmedChild.inputs).toHaveLength(0);
    expect(confirmedLedger.order).toContain("confirmed:confirmed");
    await confirmed.release();
  });

  test("uses explicit control messages for interrupt and attention answers", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    await host.send({ id: "active", text: "work" });
    const interrupted = host.interrupt("active");
    const request = child.inputs.find((input) => input.type === "control_request")!;
    expect(request.request).toEqual({ subtype: "interrupt" });
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
    await interrupted;

    child.emitJson({ type: "control_request", request_id: "permission-one", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    await Bun.sleep(0);
    expect((await host.health()).pendingAttention).toEqual(["permission-one"]);
    await host.answer("permission-one", { behavior: "deny" });
    expect(child.inputs.at(-1)).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "permission-one", response: { behavior: "deny" } },
    });
    expect((await host.health()).pendingAttention).toEqual([]);
    await host.release();
  });

  test("requires subscription OAuth before spawning", async () => {
    let spawned = false;
    await expect(ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      readAuthStatus: () => ({ loggedIn: true, authMethod: "apiKey", subscriptionType: null }),
      spawnProcess: () => {
        spawned = true;
        throw new Error("unexpected spawn");
      },
    })).rejects.toThrow("requires a claude.ai subscription login");
    expect(spawned).toBeFalse();
  });

  test("requires the exact structured-host opt-in before start", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const options = {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    };
    await expect(startClaudeStructuredHost(options, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" }))
      .rejects.toThrow("structured hosts are disabled");
    expect(child.sessionId).toBe("");
    const host = await startClaudeStructuredHost(options, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" });
    expect(child.sessionId).toBe(host.identity.sessionId);
    await host.release();
  });

  test("boot adoption resumes claimed Claude rows and persists broker columns", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "adopted-claude-session";
    registry.upsert({
      key: { engine: "claude", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 4,
        protocolVersion: "2.1.196",
        writerClaimEpoch: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const captured: { args?: string[] } = {};
    const adopted = await adoptClaudeRegistryHosts(
      registry,
      () => ({
        cwd: "/repo",
        deliveryLedger: ledger,
        eventStore: new MemoryEventStore(),
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.197" }),
        readTranscript: () => [],
        spawnProcess: fakeSpawn(child, captured),
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toHaveLength(1);
    expect(captured.args).toContain("--resume");
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "idle",
      claimEpoch: 3,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        eventCursor: 5,
        protocolVersion: "2.1.197",
        writerClaimEpoch: 3,
      },
    });
    await adopted[0]!.host.release();
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });
  });

  test("file delivery ledger survives restart and repairs a partial tail", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-ledger-"));
    const ledger = new FileClaudeDeliveryLedger(directory);
    ledger.recordQueued("durable", { id: "entry", text: "hello" }, "turn-started");
    ledger.confirmDelivered("durable", "entry", "engine-user");
    expect(new FileClaudeDeliveryLedger(directory).load("durable")).toMatchObject([{
      entry: { id: "entry", text: "hello" },
      disposition: "turn-started",
      delivered: true,
      engineMessageId: "engine-user",
    }]);
    const filename = path.join(directory, "durable.jsonl");
    fs.appendFileSync(filename, "{partial");
    ledger.recordQueued("durable", { id: "second", text: "world" }, "queued-next-turn");
    expect(ledger.load("durable").map((state) => state.entry.id)).toEqual(["entry", "second"]);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  });
});
