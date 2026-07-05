import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-configdir-test-"));
const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_STATE = process.env.LLV_STATE_DIR;

const { inboxDir, migrateLegacyDir, stateDir, statePath } = await import("./configDir");

afterAll(() => {
  if (REAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = REAL_XDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("LLV_STATE_DIR overrides the state dir wholesale", () => {
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "custom-state");
  expect(stateDir()).toBe(path.join(SANDBOX, "custom-state"));
  expect(statePath("flows", "artifact.md")).toBe(path.join(SANDBOX, "custom-state", "flows", "artifact.md"));
  delete process.env.LLV_STATE_DIR;
});

test("state and inbox live under the agent-log-viewer config dir", () => {
  const xdg = path.join(SANDBOX, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.LLV_STATE_DIR;
  /* Pre-created targets: the resolution is under test here, and an existing
     dir keeps the migration from copying the machine's real legacy state. */
  fs.mkdirSync(path.join(xdg, "agent-log-viewer", "state"), { recursive: true });
  fs.mkdirSync(path.join(xdg, "agent-log-viewer", "inbox"), { recursive: true });
  expect(stateDir()).toBe(path.join(xdg, "agent-log-viewer", "state"));
  expect(inboxDir()).toBe(path.join(xdg, "agent-log-viewer", "inbox"));
});

test("migration copies the legacy tree once and leaves the source in place", () => {
  const legacy = path.join(SANDBOX, "legacy-state");
  const target = path.join(SANDBOX, "new-state");
  fs.mkdirSync(path.join(legacy, "flows"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), '{"flows":[]}');
  fs.writeFileSync(path.join(legacy, "flows", "artifact.md"), "round");

  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe('{"flows":[]}');
  expect(fs.readFileSync(path.join(target, "flows", "artifact.md"), "utf8")).toBe("round");
  expect(fs.existsSync(path.join(legacy, "flows.json"))).toBe(true);
});

test("an existing target is never overwritten by the legacy copy", () => {
  const legacy = path.join(SANDBOX, "legacy-2");
  const target = path.join(SANDBOX, "target-2");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), "OLD");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "flows.json"), "NEW");
  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe("NEW");
});

test("a missing legacy dir leaves the target untouched", () => {
  const target = path.join(SANDBOX, "target-3");
  migrateLegacyDir(target, path.join(SANDBOX, "no-such-legacy"));
  expect(fs.existsSync(target)).toBe(false);
});
