import { afterEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { FileEntry } from "@/lib/types";

import { stableNodeDomOrder } from "./domOrder";
import type { SchemeNode } from "./layout";

const dom = new HappyWindow();
const testDocument = dom.document as unknown as Document;
const testWindow = dom as unknown as Window;

function file(path: string, title: string): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "project",
    title,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: 1,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function node(entry: FileEntry, x: number): SchemeNode {
  return { file: entry, tasks: [], under: [], isRoot: true, x, y: 0, w: 600, h: 780 };
}

function PaneList({ nodes, selected }: { nodes: SchemeNode[]; selected: string }) {
  return (
    <div>
      {stableNodeDomOrder(nodes).map((item) => (
        <div
          key={item.file.path}
          data-scheme-node={item.file.path}
          style={{ transform: `translate(${item.x}px, ${item.y}px)` }}
        >
          <div className={selected === item.file.path ? "ring-2" : undefined}>
            <span data-reader-title>{item.file.title}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

afterEach(() => testDocument.body.replaceChildren());

test("a reading pane keeps its DOM state when a more active pane overtakes it", () => {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
  });
  const readerFile = file("/reader", "Reader pane");
  const overtakerFile = file("/overtaker", "Overtaker pane");
  const initial = [node(readerFile, 0), node(overtakerFile, 600)];
  const overtaken = [node(overtakerFile, 0), node(readerFile, 600)];
  const host = testDocument.createElement("div");
  testDocument.body.append(host);
  const root: Root = createRoot(host);
  const render = (next: SchemeNode[]) => {
    flushSync(() => {
      root.render(<PaneList nodes={next} selected="/reader" />);
    });
  };

  render(initial);
  const initialPaneOrder = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-node]"), (pane) => pane.dataset.schemeNode);
  const reader = host.querySelector('[data-scheme-node="/reader"]') as HTMLElement;
  const title = reader.querySelector("[data-reader-title]") as HTMLElement;
  reader.scrollTop = 240;
  reader.tabIndex = 0;
  reader.focus();
  const range = testDocument.createRange();
  range.selectNodeContents(title);
  const selection = testWindow.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  render(overtaken);

  const panes = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-node]"));
  expect(host.querySelector('[data-scheme-node="/reader"]')).toBe(reader);
  expect(reader.scrollTop).toBe(240);
  expect(testDocument.activeElement).toBe(reader);
  expect(selection.toString()).toBe("Reader pane");
  expect(reader.querySelector(".ring-2")).toBeTruthy();
  expect(reader.style.transform).toContain("600px");
  expect(panes.map((pane) => pane.dataset.schemeNode)).toEqual(initialPaneOrder);

  flushSync(() => root.unmount());
  host.remove();
});
