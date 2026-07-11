import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { RoleConfig } from "@/lib/roles/types";

import { StageRow, type RoleCatalogItem } from "./StageRow";
import type { DraftStage } from "./pipelineModel";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

function role(id: string, config: RoleConfig): RoleCatalogItem {
  return { id, name: id, description: "", config, parameters: [], capabilities: ["read-write"], promptScaffold: "", safetyFences: [], promptPreview: "" } as unknown as RoleCatalogItem;
}
const CATALOG: RoleCatalogItem[] = [role("architect", { engine: "claude", model: "fable", effort: "high" })];
const DEFAULT_RUNTIME: RoleConfig = { engine: "codex", model: "gpt-5.6-sol", effort: "high" };
const baseStage: DraftStage = { key: "k", kind: "run", roleId: "", engine: "codex", model: "", effort: "", access: "read-write", prompt: "", roleParams: {} };

/* A controlled host so StageRow's onChange updates the stage between interactions. */
function Host({ onStage }: { onStage: (stage: DraftStage) => void }) {
  const [stage, setStage] = useState<DraftStage>(baseStage);
  return (
    <StageRow
      index={0}
      total={2}
      stage={stage}
      roles={CATALOG}
      defaultRuntime={DEFAULT_RUNTIME}
      onChange={(next) => { setStage(next); onStage(next); }}
      onRemove={() => {}}
      onMove={() => {}}
    />
  );
}

afterEach(() => document.body.replaceChildren());

test("selecting a role then No role returns the runtime to the pipeline default", () => {
  let latest: DraftStage = baseStage;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<Host onStage={(s) => { latest = s; }} />); });

  const select = host.querySelector("select") as HTMLSelectElement;
  /* Pick Architect → its Claude/Fable runtime autofills. */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ roleId: "architect", engine: "claude", model: "fable", effort: "high" });

  /* Back to No role: engine/model/effort must reset to the default, not keep Claude/Fable. */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ roleId: "", engine: "codex", model: "", effort: "" });

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("clearing a role's model override shows the role runtime, not the Builder fallback", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<Host onStage={() => {}} />); });

  const summary = () => host.querySelector(".font-mono") as HTMLElement;
  const select = host.querySelector("select") as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(summary().textContent).toContain("fable");

  /* Open the runtime editor and clear the model. The collapsed summary must fall
     back through Architect's own runtime (fable), not the Builder default (sol). */
  const edit = host.querySelector('[aria-label="Edit runtime for stage 1"]') as HTMLElement;
  flushSync(() => { edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const modelInput = host.querySelector('input[aria-label="Model"]') as HTMLInputElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(modelInput, "");
    modelInput.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(summary().textContent).toContain("fable");
  expect(summary().textContent).not.toContain("gpt-5.6-sol");

  flushSync(() => { root.unmount(); });
  host.remove();
});
