import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { agentRegistry } = await import("@/lib/agent/registry");
const { POST } = await import("./route");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seedCaller(role: string): { capability: string; conversationId: ViewerConversationId; path: string } {
  const store = agentRegistry();
  const capability = crypto.randomBytes(32).toString("base64url");
  const reviews = role === "reviewer"
    ? store.ensureConversation("codex", `/sessions/reviewed-${crypto.randomUUID()}.jsonl`, "terra").id
    : null;
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role,
    reviewsConversationId: reviews,
    parentConversationId: reviews,
    origin: { kind: "operator" },
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const sessionId = crypto.randomUUID();
  const artifactPath = `/sessions/caller-${sessionId}.jsonl`;
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return { capability, conversationId: settled.conversation.id, path: artifactPath };
}

function pipelineRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an authenticated reviewer caller cannot create a pipeline", async () => {
  const caller = seedCaller("reviewer");
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd(), src: caller.path },
    { "x-llv-spawn-capability": caller.capability },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "reviewer_origin_spawn",
    error: expect.stringContaining("in-session"),
  });
});

test("a declared reviewer src is rejected even without a capability header", async () => {
  const caller = seedCaller("verifier");
  const response = await POST(pipelineRequest({ task: "escape", repoDir: process.cwd(), src: caller.path }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "reviewer_origin_spawn" });
});

test("an authenticated builder caller and an unattributed external caller keep today's behavior", async () => {
  const caller = seedCaller("builder");
  const authenticated = await POST(pipelineRequest(
    { task: "", repoDir: process.cwd(), src: caller.path },
    { "x-llv-spawn-capability": caller.capability },
  ));
  expect(authenticated.status).toBe(400);
  expect(await authenticated.json()).toEqual({ error: "task is required" });

  const external = await POST(pipelineRequest({ task: "" }));
  expect(external.status).toBe(400);
  expect(await external.json()).toEqual({ error: "task is required" });
});

test("a capability header that does not authenticate is rejected before pipeline creation", async () => {
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd() },
    { "x-llv-spawn-capability": "B".repeat(43) },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: expect.stringContaining("x-llv-spawn-capability") });
});
