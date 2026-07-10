import { expect, test } from "bun:test";

import { turnStateFromRecords } from "./turnState";

test("issue 51 keeps a Codex turn busy through interim assistant text and tool work", () => {
  const records = [
    { payload: { type: "turn_started" } },
    { payload: { type: "agent_message" } },
    { payload: { type: "custom_tool_call" } },
    { payload: { type: "agent_message" } },
  ];
  expect(turnStateFromRecords(records, true)).toMatchObject({ state: "busy", source: "tool" });
  expect(turnStateFromRecords([...records, { timestamp: "2026-07-10T12:00:00.000Z", payload: { type: "turn_complete" } }], true)).toEqual({ state: "terminal", source: "lifecycle", terminalAt: "2026-07-10T12:00:00.000Z" });
});
