import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "../agent/registry";
import { archivedTranscriptPaths, pinnedPathFor } from "./index";

afterEach(() => setAgentRegistryForTests(null));

test("a corrupt agent registry yields an empty demotion set and discovery stays available", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unsupported registry schema also degrades to no demotion", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-schema-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 999 }));
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a conversation-id pin resolves to its current generation path", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-${process.pid}`, "agent-registry.json"));
  const conversation = store.ensureConversation("codex", "/repo/current.jsonl", "default");
  setAgentRegistryForTests(store);
  expect(pinnedPathFor(conversation.id)).toBe("/repo/current.jsonl");
  /* Plain paths pass through; unknown ids leave the scan unpinned. */
  expect(pinnedPathFor("/plain/path.jsonl")).toBe("/plain/path.jsonl");
  expect(pinnedPathFor("conversation_unknown")).toBeUndefined();
});

test("an unreadable registry leaves a conversation-id pin unresolved", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-pin-corrupt-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(pinnedPathFor("conversation_x")).toBeUndefined();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
