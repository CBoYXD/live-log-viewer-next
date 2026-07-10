import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardFileV1, BoardProjectStateV1 } from "@/lib/view/types";

export const BOARD_FILE = statePath("board.json");
const EMPTY_PREFS: BoardProjectStateV1["prefs"] = { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false };
let boardFileForTests: string | null = null;

export class BoardStoreError extends Error {
  constructor(message = "board state unavailable") { super(message); }
}

export function setBoardFileForTests(filePath: string | null): void {
  boardFileForTests = filePath;
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function aliases(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}
function projectState(value: unknown): value is BoardProjectStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<BoardProjectStateV1>;
  const prefs = state.prefs;
  return state.schemaVersion === 1 && Number.isInteger(state.revision) && state.revision! >= 0 && typeof state.updatedAt === "string" && Boolean(prefs) &&
    stringArray(prefs!.manual) && stringArray(prefs!.hidden) && stringArray(prefs!.expanded) &&
    (state.pathAliases === undefined || aliases(state.pathAliases)) &&
    (prefs!.viewMode === null || prefs!.viewMode === "scheme" || prefs!.viewMode === "list") && typeof prefs!.taskPanelOpen === "boolean";
}

function emptyBoard(): BoardProjectStateV1 {
  return { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), pathAliases: {}, prefs: { ...EMPTY_PREFS, manual: [], hidden: [], expanded: [] } };
}

function read(filePath: string): BoardFileV1 {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BoardFileV1>;
    if (!parsed || typeof parsed.projects !== "object" || parsed.projects === null || Array.isArray(parsed.projects)) throw new BoardStoreError("invalid board state");
    if (!Object.values(parsed.projects).every(projectState)) throw new BoardStoreError("invalid board project state");
    return { projects: Object.fromEntries(Object.entries(parsed.projects).map(([project, state]) => [project, { ...state, pathAliases: state.pathAliases ?? {} }])) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    if (error instanceof BoardStoreError) throw error;
    throw new BoardStoreError();
  }
}
function write(value: BoardFileV1, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}
export function boardFor(project: string, filePath = boardFileForTests ?? BOARD_FILE): BoardProjectStateV1 {
  return read(filePath).projects[project] ?? emptyBoard();
}
export type BoardPatch = Partial<BoardProjectStateV1["prefs"]>;
type BoardWriteResult = { ok: true; board: BoardProjectStateV1 } | { ok: false; board: BoardProjectStateV1 };

function sameReduced(left: BoardProjectStateV1, right: BoardProjectStateV1): boolean {
  return JSON.stringify({ prefs: left.prefs, pathAliases: left.pathAliases ?? {} }) === JSON.stringify({ prefs: right.prefs, pathAliases: right.pathAliases ?? {} });
}

function writeReduced(project: string, baseRevision: number, reduce: (current: BoardProjectStateV1) => BoardProjectStateV1, filePath: string): BoardWriteResult {
  const value = read(filePath);
  const current = value.projects[project] ?? emptyBoard();
  const reduced = reduce(current);
  if (sameReduced(current, reduced)) return { ok: true, board: current };
  if (current.revision !== baseRevision) return { ok: false, board: current };
  const next: BoardProjectStateV1 = { ...reduced, schemaVersion: 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), pathAliases: reduced.pathAliases ?? {} };
  value.projects[project] = next;
  write(value, filePath);
  return { ok: true, board: next };
}

export function patchBoard(project: string, baseRevision: number, patch: BoardPatch, filePath = boardFileForTests ?? BOARD_FILE): { ok: true; board: BoardProjectStateV1 } | { ok: false; board: BoardProjectStateV1 } {
  return writeReduced(project, baseRevision, (current) => ({ ...current, prefs: { ...current.prefs, ...patch } }), filePath);
}

export function mutateBoard(project: string, baseRevision: number, mutations: readonly BoardMutationV1[], filePath = boardFileForTests ?? BOARD_FILE): BoardWriteResult {
  return writeReduced(project, baseRevision, (current) => applyBoardMutations(current, mutations), filePath);
}

function mergedBoards(states: readonly BoardProjectStateV1[]): BoardProjectStateV1 {
  const ordered = states
    .map((state, index) => ({ state, index, timestamp: Date.parse(state.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : 0;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : 0;
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ state }) => state);
  const aliases = ordered.reduce<Record<string, string>>(
    (combined, state) => ({ ...combined, ...(state.pathAliases ?? {}) }),
    {},
  );
  const roles = new Map<string, "manual" | "hidden" | "expanded">();
  let viewMode: BoardProjectStateV1["prefs"]["viewMode"] = null;
  let taskPanelOpen = false;
  let normalizedAliases: Record<string, string> = aliases;
  for (const state of ordered) {
    const normalized = applyBoardMutations({ ...state, pathAliases: aliases }, []);
    normalizedAliases = normalized.pathAliases ?? {};
    for (const role of ["manual", "hidden", "expanded"] as const) {
      for (const pathname of normalized.prefs[role]) {
        roles.delete(pathname);
        roles.set(pathname, role);
      }
    }
    viewMode = normalized.prefs.viewMode;
    taskPanelOpen = normalized.prefs.taskPanelOpen;
  }
  const prefs = {
    manual: [] as string[],
    hidden: [] as string[],
    expanded: [] as string[],
    viewMode,
    taskPanelOpen,
  };
  for (const [pathname, role] of roles) prefs[role].push(pathname);
  return { ...ordered.at(-1)!, pathAliases: normalizedAliases, prefs };
}

/** Move durable board preferences along with catalog project-key repairs.
    Sources remain intact whenever a merge cannot preserve board invariants. */
export function migrateBoardProjects(
  migrations: ReadonlyMap<string, string>,
  filePath = statePath("board.json"),
): boolean {
  if (migrations.size === 0) return true;
  const value = read(filePath);
  let changed = false;
  let complete = true;
  const sourcesByTarget = new Map<string, string[]>();
  for (const [sourceProject, targetProject] of migrations) {
    if (sourceProject === targetProject) continue;
    sourcesByTarget.set(targetProject, [...(sourcesByTarget.get(targetProject) ?? []), sourceProject]);
  }
  for (const [targetProject, sourceProjects] of sourcesByTarget) {
    const sources = sourceProjects.flatMap((project) => value.projects[project] ? [value.projects[project]!] : []);
    if (sources.length === 0) continue;
    const target = value.projects[targetProject];
    if (!target && sources.length === 1) {
      value.projects[targetProject] = sources[0]!;
      for (const sourceProject of sourceProjects) delete value.projects[sourceProject];
      changed = true;
      continue;
    }
    try {
      const states = target ? [target, ...sources] : sources;
      const merged = mergedBoards(states);
      value.projects[targetProject] = target && sameReduced(target, merged)
        ? target
        : {
            ...merged,
            revision: Math.max(...states.map((state) => state.revision)) + 1,
            updatedAt: new Date().toISOString(),
          };
      for (const sourceProject of sourceProjects) delete value.projects[sourceProject];
      changed = true;
    } catch {
      complete = false;
      continue;
    }
  }
  if (changed) write(value, filePath);
  return complete;
}
