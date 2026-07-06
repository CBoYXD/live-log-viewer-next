import { describe, expect, test } from "bun:test";

import { killTargetAllowed, noteSessionTargets } from "./resources";

describe("kill-target allowlist", () => {
  test("nothing is killable before a snapshot exists", () => {
    noteSessionTargets([]);
    expect(killTargetAllowed("agents:1.0")).toBe(false);
  });

  test("only targets from the last snapshot pass", () => {
    noteSessionTargets(["agents:1.0", "agents:2.0"]);
    expect(killTargetAllowed("agents:1.0")).toBe(true);
    expect(killTargetAllowed("agents:2.0")).toBe(true);
    expect(killTargetAllowed("agents:3.0")).toBe(false);
    expect(killTargetAllowed("main:0.0")).toBe(false);
    expect(killTargetAllowed("")).toBe(false);
  });

  test("a new snapshot replaces the allowlist, never accumulates", () => {
    noteSessionTargets(["agents:1.0"]);
    noteSessionTargets(["agents:2.0"]);
    expect(killTargetAllowed("agents:1.0")).toBe(false);
    expect(killTargetAllowed("agents:2.0")).toBe(true);
  });
});
