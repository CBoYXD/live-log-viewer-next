import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { pidAlive } from "@/lib/scanner/process";

/**
 * Spawn parentage of a handoff: the card on a conversation pane boots a fresh
 * agent that inherits the source transcript, and the new conversation must
 * land in the source's tree — linked and placed next to it — instead of
 * standing as an unrelated root. The transcript of the new agent does not
 * exist yet at spawn time, so the fact is recorded in two steps: the spawn
 * remembers «tmux pane pid → source transcript», and the scanner later matches
 * a new conversation to that pane through its /proc ancestry. The proven
 * child link is then persisted by path (like codex lineage), so it survives
 * both the process exit and a server restart.
 */
const LINEAGE_FILE = statePath("handoff-lineage.json");
const MAX_CHILDREN = 2000;

interface StoreShape {
  panes?: Record<string, string>;
  children?: Record<string, string>;
}

/** Pane pid of a handoff window → source transcript, while the pane lives. */
let panes: Map<number, string> | null = null;
/** New conversation transcript → source transcript, durable. */
let children: Map<string, string> | null = null;
let dirty = false;

function load(): { panes: Map<number, string>; children: Map<string, string> } {
  if (panes && children) return { panes, children };
  panes = new Map();
  children = new Map();
  let stored: StoreShape = {};
  try {
    stored = JSON.parse(fs.readFileSync(LINEAGE_FILE, "utf8")) as StoreShape;
  } catch {
    /* first run or unreadable cache: start empty */
  }
  for (const [pidRaw, parent] of Object.entries(stored.panes ?? {})) {
    const pid = Number(pidRaw);
    /* A dead pane pid can only match again after the OS reuses it — drop it. */
    if (Number.isInteger(pid) && pid > 0 && typeof parent === "string" && pidAlive(pid)) panes.set(pid, parent);
  }
  for (const [child, parent] of Object.entries(stored.children ?? {})) {
    /* A child link earns its bytes only while the child transcript exists, so
       the store shrinks with the sessions directories instead of growing. */
    if (typeof parent === "string" && fs.existsSync(child)) children.set(child, parent);
  }
  const storedSize = Object.keys(stored.panes ?? {}).length + Object.keys(stored.children ?? {}).length;
  if (panes.size + children.size !== storedSize) dirty = true;
  return { panes, children };
}

/** Records that the pane just booted for a handoff descends from `parent`. */
export function rememberHandoffPane(panePid: number, parent: string): void {
  if (!Number.isInteger(panePid) || panePid <= 0) return;
  const store = load();
  if (store.panes.get(panePid) === parent) return;
  store.panes.set(panePid, parent);
  dirty = true;
  persistHandoffLineage();
}

/** Source transcript of the handoff pane `pid` belongs to, if any. */
export function handoffParentForPid(pid: number): string | null {
  return load().panes.get(pid) ?? null;
}

export function rememberHandoffChild(child: string, parent: string): void {
  const store = load();
  if (store.children.get(child) === parent) return;
  store.children.set(child, parent);
  /* Map keeps insertion order, so the oldest links fall out first. */
  while (store.children.size > MAX_CHILDREN) {
    const oldest = store.children.keys().next().value;
    if (oldest === undefined) break;
    store.children.delete(oldest);
  }
  dirty = true;
}

/** Previously proven handoff source of the `child` transcript, if any. */
export function handoffParentForChild(child: string): string | null {
  return load().children.get(child) ?? null;
}

export function persistHandoffLineage(): void {
  if (!dirty) return;
  dirty = false;
  const store = load();
  try {
    fs.mkdirSync(path.dirname(LINEAGE_FILE), { recursive: true });
    fs.writeFileSync(
      LINEAGE_FILE,
      JSON.stringify({
        panes: Object.fromEntries([...store.panes].map(([pid, parent]) => [String(pid), parent])),
        children: Object.fromEntries(store.children),
      }),
    );
  } catch {
    /* best-effort: a lost cache only costs one unlinked handoff */
  }
}
