import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-nesting-policy-"));
process.env.LLV_STATE_DIR = sandbox;

const {
  DEFAULT_MAX_AGENT_NESTING_DEPTH,
  loadSpawnNestingPolicy,
  saveSpawnNestingPolicy,
  validMaxAgentNestingDepth,
} = await import("./nestingPolicy");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("an absent policy file yields the conservative default of 2", () => {
  expect(DEFAULT_MAX_AGENT_NESTING_DEPTH).toBe(2);
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 2 });
});

test("a corrupt or out-of-bounds policy file degrades to the default", () => {
  const file = path.join(sandbox, "spawn-nesting.json");
  fs.writeFileSync(file, "not json");
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 2 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, maxAgentNestingDepth: 99 }));
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 2 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 7, maxAgentNestingDepth: 3 }));
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 2 });
  fs.rmSync(file);
});

test("saved policy round-trips and bounds are validated", () => {
  saveSpawnNestingPolicy({ maxAgentNestingDepth: 3 });
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 3 });
  saveSpawnNestingPolicy({ maxAgentNestingDepth: 1 });
  expect(loadSpawnNestingPolicy()).toEqual({ maxAgentNestingDepth: 1 });
  expect(() => saveSpawnNestingPolicy({ maxAgentNestingDepth: 0 })).toThrow("between 1 and 4");
  expect(() => saveSpawnNestingPolicy({ maxAgentNestingDepth: 5 })).toThrow("between 1 and 4");
  expect(() => saveSpawnNestingPolicy({ maxAgentNestingDepth: 2.5 })).toThrow("between 1 and 4");
  expect(validMaxAgentNestingDepth(4)).toBe(true);
  expect(validMaxAgentNestingDepth("2")).toBe(false);
  fs.rmSync(path.join(sandbox, "spawn-nesting.json"));
});
