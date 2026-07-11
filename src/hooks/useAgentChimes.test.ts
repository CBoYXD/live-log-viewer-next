import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { planAgentChimes, type TrackedConversation } from "./useAgentChimes";

/* Deterministic fixtures: `waitingInput` forces paneState "waiting" without
   touching the wall clock; `activity: "live"` forces "live"; everything else
   idles into "done". */
function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: over.path,
    project: "proj",
    worktree: null,
    title: null,
    engine: "claude",
    kind: "conversation",
    fmt: "jsonl",
    parent: null,
    mtime: 1_700_000_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

const live = (path: string, over: Partial<FileEntry> = {}) => entry({ path, activity: "live", ...over });
const waiting = (path: string, over: Partial<FileEntry> = {}) => entry({ path, waitingInput: { reason: "turn done" } as unknown as FileEntry["waitingInput"], ...over });

test("first poll seeds the baseline silently", () => {
  const plan = planAgentChimes([waiting("/a"), live("/b")], null, new Set());
  expect(plan.chimes).toEqual([]);
  expect([...plan.tracked.keys()].sort()).toEqual(["/a", "/b"]);
});

test("live → waiting rings once, then stays silent", () => {
  const seed = planAgentChimes([live("/a")], null, new Set());
  const rung = planAgentChimes([waiting("/a")], seed.tracked, seed.linked);
  expect(rung.chimes.map((chimePlan) => chimePlan.kind)).toEqual(["question"]);
  const again = planAgentChimes([waiting("/a")], rung.tracked, rung.linked);
  expect(again.chimes).toEqual([]);
});

test("an identity that churns out of the capped feed and returns does not re-ring", () => {
  const seed = planAgentChimes([live("/a"), waiting("/b")], null, new Set());
  /* /b falls out of the recency cap for one poll… */
  const middle = planAgentChimes([live("/a")], seed.tracked, seed.linked);
  expect(middle.chimes).toEqual([]);
  /* …and its baseline survives the absence: the return is not a new agent. */
  expect(middle.tracked.has("/b")).toBe(true);
  const back = planAgentChimes([live("/a"), waiting("/b")], middle.tracked, middle.linked);
  expect(back.chimes).toEqual([]);
});

test("a genuinely new conversation that appears already finished rings", () => {
  const seed = planAgentChimes([live("/a")], null, new Set());
  const plan = planAgentChimes([live("/a"), waiting("/new")], seed.tracked, seed.linked);
  expect(plan.chimes).toEqual([{ kind: "question", id: "/new" }]);
});

test("archived migration predecessors neither ring nor clobber the successor's state", () => {
  const successor = live("/gen2", { conversationId: "conversation_x" });
  const predecessor = waiting("/gen1", { conversationId: "conversation_x", migratedTo: "/gen2" });
  const seed = planAgentChimes([successor, predecessor], null, new Set());
  /* Only the successor generation is tracked, under the stable identity. */
  expect([...seed.tracked.keys()]).toEqual(["conversation_x"]);
  expect(seed.tracked.get("conversation_x")?.state).toBe("live");
  /* The predecessor re-listing on a later poll stays silent. */
  const plan = planAgentChimes([successor, predecessor], seed.tracked, seed.linked);
  expect(plan.chimes).toEqual([]);
});

test("a child joining the tree blips spawned once, even across feed churn", () => {
  const seed = planAgentChimes([live("/parent")], null, new Set());
  const spawn = planAgentChimes([live("/parent"), live("/child", { parent: "/parent" })], seed.tracked, seed.linked);
  expect(spawn.chimes).toEqual([{ kind: "spawned", id: "/child" }]);
  /* The child churns out of the feed and returns: no second blip. */
  const middle = planAgentChimes([live("/parent")], spawn.tracked, spawn.linked);
  const back = planAgentChimes([live("/parent"), live("/child", { parent: "/parent" })], middle.tracked, middle.linked);
  expect(back.chimes).toEqual([]);
});

test("a subagent that lived its whole life between polls rings the finish, not the blip", () => {
  const prev = new Map<string, TrackedConversation>([["/parent", { state: "live", parent: null, file: live("/parent") }]]);
  const plan = planAgentChimes([live("/parent"), waiting("/child", { parent: "/parent" })], prev, new Set());
  expect(plan.chimes).toEqual([{ kind: "question", id: "/child" }]);
});
