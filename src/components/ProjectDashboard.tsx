"use client";

import { CornerDownRight, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useWheelPan } from "@/hooks/useWheelPan";
import type { FileEntry } from "@/lib/types";

import { BranchPane, TaskStrip } from "./BranchPane";
import { FlipRow } from "./FlipRow";
import { Switchboard } from "./Switchboard";
import {
  type BranchGroup,
  buildBranchGroups,
  collapsedTrees,
  projectKey,
  residualItems,
} from "./projectModel";
import { ResidualStrip } from "./TreeAside";
import { activityDot, cleanTitle, engineBadge, engineColor, ukPlural } from "./utils";
import { SpawnAgentButton } from "./SpawnAgentButton";

const COL_W = 520;
const COL_GAP = 12;
/** How long a map-selected column keeps its highlight ring. */
const HIGHLIGHT_MS = 1800;
/** Crown above each tree group: header pill row + connector svg. */
const CROWN_PILL_H = 28;
const CROWN_SVG_H = 36;
const CROWN_H = CROWN_PILL_H + CROWN_SVG_H;

/**
 * The visible agents tree over a group: root pill on the trunk, bezier edges
 * dropping into every live column — who spawned whom reads at a glance.
 */
function GroupCrown({
  group,
  quietCount,
  onSelect,
  onResetOrder,
}: {
  group: BranchGroup;
  quietCount: number;
  onSelect: (file: FileEntry) => void;
  /** Set when siblings have a manual order; renders the reset control. */
  onResetOrder?: () => void;
}) {
  const root = group.columns[0]!.file;
  const badge = engineBadge(root);
  const count = group.columns.length;
  const width = count * COL_W + (count - 1) * COL_GAP;
  const rootX = COL_W / 2;
  return (
    <div className="shrink-0" style={{ width }}>
      <div className="flex justify-center" style={{ height: CROWN_PILL_H, width: COL_W }}>
        <button
          className="inline-flex h-[24px] max-w-full items-center gap-1.5 self-start rounded-full border border-line bg-panel px-2.5 shadow-card hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={cleanTitle(root.title)}
          aria-label={`Відкрити розмову ${cleanTitle(root.title, 60)}`}
          onClick={() => onSelect(root)}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(root.activity)}`} />
          <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>{badge.label}</span>
          <span className="min-w-0 truncate text-[11px] font-bold">{cleanTitle(root.title, 60)}</span>
          {count - 1 + quietCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold text-dim">
              <CornerDownRight className="h-3 w-3" aria-hidden /> {count - 1 + quietCount}{" "}
              {ukPlural(count - 1 + quietCount, "гілка", "гілки", "гілок")}
            </span>
          ) : null}
        </button>
        {onResetOrder ? (
          <button
            className="ml-1.5 inline-flex h-[22px] w-[22px] items-center justify-center self-start rounded-full border border-line bg-panel text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title="Скинути ручний порядок колонок"
            aria-label="Скинути ручний порядок колонок"
            onClick={onResetOrder}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <svg width={width} height={CROWN_SVG_H} className="block" aria-hidden>
        {group.columns.slice(1).map((column, idx) => {
          const childX = (idx + 1) * (COL_W + COL_GAP) + COL_W / 2;
          const color = engineColor(column.file);
          const bendX = rootX + (childX - rootX) * 0.45;
          return (
            <g key={column.file.path}>
              <path
                d={`M ${rootX} 8 C ${bendX} 8, ${childX} 8, ${childX} ${CROWN_SVG_H}`}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                opacity={column.file.activity === "live" ? 0.9 : 0.45}
              />
              <circle cx={childX} cy={CROWN_SVG_H - 3} r={2.5} fill={color} />
            </g>
          );
        })}
        <line x1={rootX} y1={4} x2={rootX} y2={CROWN_SVG_H} stroke={engineColor(root)} strokeWidth={3} strokeLinecap="round" />
        <circle cx={rootX} cy={5} r={4.5} fill={engineColor(root)} />
      </svg>
    </div>
  );
}

interface Props {
  files: FileEntry[];
  project: string;
  /** Bumped by Viewer on every openFile so a same-project open re-reads prefs
      even though `project` itself did not change. */
  openNonce: number;
}

/** Manual additions and removals of dashboard columns, persisted per project. */
interface ColumnPrefs {
  manual: string[];
  hidden: string[];
  /** Per tree root: branch path → manual position among siblings. */
  order: Record<string, Record<string, number>>;
}

const prefsKey = (project: string) => `llvCols:${project}`;

function loadPrefs(project: string): ColumnPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(prefsKey(project)) ?? "{}") as Partial<ColumnPrefs>;
    return { manual: raw.manual ?? [], hidden: raw.hidden ?? [], order: raw.order ?? {} };
  } catch {
    return { manual: [], hidden: [], order: {} };
  }
}

/** Pre-adds a conversation as a manual dashboard column of its project. */
export function queueColumnOpen(project: string, path: string) {
  const prefs = loadPrefs(project);
  if (!prefs.manual.includes(path)) prefs.manual.push(path);
  prefs.hidden = prefs.hidden.filter((item) => item !== path);
  localStorage.setItem(prefsKey(project), JSON.stringify(prefs));
}

/* Kept outside the component: the React Compiler's immutability check flags
   direct global mutation (location.hash = ...) inside a component body. */
function gotoProject(project: string) {
  location.hash = "#p=" + encodeURIComponent(project);
}

export function ProjectDashboard({ files, project, openNonce }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; active: boolean } | null>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const groupRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverGroupRef = useRef<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const [prefs, setPrefs] = useState<ColumnPrefs>({ manual: [], hidden: [], order: {} });
  const [highlight, setHighlight] = useState<string | null>(null);
  const dragColRef = useRef<{ group: string; path: string } | null>(null);
  /* Mirrors `prefs` synchronously so the missing-columns effect below can read
     the value the project-switch load just set, even within the same commit
     (state updates from sibling effects are not visible via closure yet). */
  const prefsRef = useRef(prefs);

  useEffect(() => {
    const loaded = loadPrefs(project);
    prefsRef.current = loaded;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setPrefs(loaded);
  }, [project, openNonce]);
  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const persistPrefs = (next: ColumnPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    localStorage.setItem(prefsKey(project), JSON.stringify(next));
  };

  const groups = useMemo(() => buildBranchGroups(files, project), [files, project]);
  const activeRoots = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const cards = useMemo(() => collapsedTrees(files, project, activeRoots), [files, project, activeRoots]);
  const residual = useMemo(() => residualItems(files, project, activeRoots), [files, project, activeRoots]);
  const autoPaths = useMemo(
    () => new Set(groups.flatMap((group) => group.columns.map((column) => column.file.path))),
    [groups],
  );
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const manualColumns = useMemo(() => {
    const byPath = new Map(files.map((file) => [file.path, file]));
    return prefs.manual
      .map((path) => byPath.get(path))
      .filter(
        (file): file is FileEntry =>
          file !== undefined && projectKey(file) === project && !autoPaths.has(file.path) && !hiddenSet.has(file.path),
      );
  }, [prefs.manual, files, project, autoPaths, hiddenSet]);
  const liveCount = useMemo(
    () =>
      groups.reduce(
        (sum, group) =>
          sum +
          group.columns.reduce(
            (colSum, column) =>
              colSum +
              (column.file.activity === "live" ? 1 : 0) +
              column.tasks.filter((task) => task.activity === "live").length,
            0,
          ),
        0,
      ),
    [groups],
  );
  const treeGroups = groups.filter((group) => !group.orphanTask).length;

  const flashColumn = (path: string) => {
    columnRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setHighlight(path);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  };

  /* A column added from the switchboard mounts on the next render; flash it then. */
  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !columnRefs.current.has(pending)) return;
    pendingScrollRef.current = null;
    flashColumn(pending);
  });

  const closeColumn = (path: string) => {
    const manual = prefs.manual.filter((item) => item !== path);
    const hidden = autoPaths.has(path) ? [...new Set([...prefs.hidden, path])] : prefs.hidden;
    persistPrefs({ ...prefs, manual, hidden });
  };

  /* A column never vanishes on its own: every auto column is recorded as a
     manual one, so a branch that goes quiet keeps its place until the user
     closes it. Capped so old projects do not accumulate forever. */
  useEffect(() => {
    const prev = prefsRef.current;
    const missing = [...autoPaths].filter((path) => !prev.manual.includes(path) && !prev.hidden.includes(path));
    if (!missing.length) return;
    const next = { ...prev, manual: [...prev.manual, ...missing].slice(-40) };
    prefsRef.current = next;
    setPrefs(next);
    localStorage.setItem(prefsKey(project), JSON.stringify(next));
  }, [autoPaths, project]);

  /* Any open lands in the column canvas: a card of another project pre-adds its
     column and switches the project; a conversation of this project joins the
     managed column list (or gets flashed when already there). */
  const openSwitchboardFile = (file: FileEntry) => {
    const fileProject = projectKey(file);
    if (fileProject !== project) {
      queueColumnOpen(fileProject, file.path);
      gotoProject(fileProject);
      return;
    }
    const visible =
      (autoPaths.has(file.path) && !hiddenSet.has(file.path)) || manualColumns.some((item) => item.path === file.path);
    if (visible) {
      flashColumn(file.path);
      return;
    }
    const hidden = prefs.hidden.filter((item) => item !== file.path);
    const manual = autoPaths.has(file.path) ? prefs.manual : [...new Set([...prefs.manual, file.path])];
    persistPrefs({ ...prefs, manual, hidden });
    pendingScrollRef.current = file.path;
  };

  useWheelPan(scrollRef);

  /* Coming back from focus mode restores the canvas position. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = sessionStorage.getItem("llvScroll:" + project);
    if (saved) el.scrollLeft = Number(saved);
    return () => {
      sessionStorage.setItem("llvScroll:" + project, String(el.scrollLeft));
    };
  }, [project]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [draggable="true"]')) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, active: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag || !el) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      drag.active = true;
      el.setPointerCapture(event.pointerId);
      el.style.userSelect = "none";
      el.style.cursor = "grabbing";
    }
    el.scrollLeft = drag.left - dx;
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (dragRef.current?.active && el) {
      el.releasePointerCapture(event.pointerId);
      el.style.userSelect = "";
      el.style.cursor = "";
    }
    dragRef.current = null;
  };

  const statusBits: string[] = [];
  if (liveCount) {
    statusBits.push(
      `${liveCount} ${ukPlural(liveCount, "гілка працює", "гілки працюють", "гілок працюють")} · ${treeGroups} ${ukPlural(treeGroups, "дерево", "дерева", "дерев")}`,
    );
  } else if (treeGroups) {
    statusBits.push(`${treeGroups} ${ukPlural(treeGroups, "нещодавня розмова", "нещодавні розмови", "нещодавніх розмов")}`);
  }
  if (cards.length) {
    statusBits.push(`${cards.length} ${ukPlural(cards.length, "тихе дерево", "тихі дерева", "тихих дерев")}`);
  }

  const setColumnRef = (path: string) => (el: HTMLDivElement | null) => {
    if (el) columnRefs.current.set(path, el);
    else columnRefs.current.delete(path);
  };
  const setGroupRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) groupRefs.current.set(key, el);
    else groupRefs.current.delete(key);
  };
  /* Reading stability: while the cursor rests on a group, that group must
     not move when a poll reshuffles columns — it opts out of FLIP and the
     canvas scroll compensates its layout delta, so neighbors glide around
     the spot the user is reading. */
  const readingGuard = (key: string) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLDivElement>) => {
      hoverGroupRef.current = key;
      event.currentTarget.setAttribute("data-flip-skip", "1");
    },
    onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => {
      if (hoverGroupRef.current === key) hoverGroupRef.current = null;
      event.currentTarget.removeAttribute("data-flip-skip");
    },
  });

  const allVisibleGroups = groups
    .map((group) => {
      const columns = group.columns.filter((column) => !hiddenSet.has(column.file.path));
      const order = prefs.order[group.key];
      if (!order || columns.length < 3) return { ...group, columns };
      const [root, ...branches] = columns;
      branches.sort((a, b) => (order[a.file.path] ?? 1e9) - (order[b.file.path] ?? 1e9));
      return { ...group, columns: root ? [root, ...branches] : branches };
    })
    .filter((group) => group.columns.length);
  /* Parentless background processes dock as colored strips at the top of the
     canvas instead of hanging as lone stub columns in the middle of it. */
  const dockedTasks = allVisibleGroups.filter((group) => group.orphanTask).map((group) => group.columns[0]!.file);
  const visibleGroups = allVisibleGroups.filter((group) => !group.orphanTask);
  const hasColumns = visibleGroups.length > 0 || manualColumns.length > 0;

  /* Drag a sibling column by its header onto another to swap places; the
     custom order survives polling via localStorage. */
  const dropColumn = (groupKey: string, targetPath: string) => {
    const drag = dragColRef.current;
    dragColRef.current = null;
    if (!drag || drag.group !== groupKey || drag.path === targetPath) return;
    const group = visibleGroups.find((item) => item.key === groupKey);
    if (!group) return;
    const branchPaths = group.columns.slice(1).map((column) => column.file.path);
    const from = branchPaths.indexOf(drag.path);
    const to = branchPaths.indexOf(targetPath);
    if (from < 0 || to < 0) return;
    branchPaths.splice(from, 1);
    branchPaths.splice(to, 0, drag.path);
    const order = Object.fromEntries(branchPaths.map((path, idx) => [path, idx]));
    persistPrefs({ ...prefs, order: { ...prefs.order, [groupKey]: order } });
  };
  const resetOrder = (groupKey: string) => {
    const next = { ...prefs.order };
    delete next[groupKey];
    persistPrefs({ ...prefs, order: next });
  };
  const dragHandleFor = (groupKey: string, path: string): React.HTMLAttributes<HTMLElement> => ({
    draggable: true,
    onDragStart: (event) => {
      dragColRef.current = { group: groupKey, path };
      event.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      dragColRef.current = null;
    },
  });

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
        <h1 className="truncate text-[13.5px] font-bold">{project}</h1>
        <span className="truncate text-[11.5px] text-dim">{statusBits.length ? statusBits.join(" · ") : "зараз нічого не працює"}</span>
        <SpawnAgentButton project={project} />
      </div>

      {dockedTasks.length ? (
        <div className="shrink-0 border-b border-line bg-[#fbfbfd]">
          {dockedTasks.map((task) => (
            <div
              key={task.path}
              className={`border-l-4 ${task.activity === "live" ? "border-l-ok bg-[#f2faf4]" : "border-l-[#9a9aa4]"}`}
            >
              <TaskStrip file={task} files={files} onSelect={openSwitchboardFile} />
            </div>
          ))}
        </div>
      ) : null}

      {hasColumns ? (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <FlipRow className="flex h-full items-stretch gap-10 px-3 py-2.5">
            {visibleGroups.map((group) => (
              <div
                key={group.key}
                data-flip-key={group.key}
                ref={setGroupRef(group.key)}
                className="flex h-full shrink-0 flex-col"
                {...readingGuard(group.key)}
              >
                <GroupCrown
                  group={group}
                  quietCount={group.returnable.length + group.finished.length}
                  onSelect={openSwitchboardFile}
                  onResetOrder={prefs.order[group.key] ? () => resetOrder(group.key) : undefined}
                />
                <FlipRow className="flex min-h-0 flex-1" style={{ gap: COL_GAP }}>
                  {group.columns.map((column) => {
                    const isRootCol = column.file.path === group.key;
                    return (
                      <div
                        key={column.file.path}
                        data-flip-key={column.file.path}
                        ref={setColumnRef(column.file.path)}
                        className={`flex min-h-0 rounded-[10px] transition-shadow ${
                          highlight === column.file.path ? "ring-2 ring-accent/60" : ""
                        }`}
                        style={{ width: COL_W }}
                        onDragOver={(event) => {
                          if (!isRootCol && dragColRef.current?.group === group.key) event.preventDefault();
                        }}
                        onDrop={() => {
                          if (!isRootCol) dropColumn(group.key, column.file.path);
                        }}
                      >
                        <BranchPane
                          file={column.file}
                          tasks={column.tasks}
                          files={files}
                          onSelect={openSwitchboardFile}
                          isRoot={isRootCol}
                          onClose={() => closeColumn(column.file.path)}
                          dragHandle={isRootCol ? undefined : dragHandleFor(group.key, column.file.path)}
                        />
                      </div>
                    );
                  })}
                </FlipRow>
              </div>
            ))}
            {manualColumns.map((file) => (
              <div key={file.path} data-flip-key={file.path} className="flex h-full shrink-0 flex-col" style={{ width: COL_W }}>
                <div style={{ height: CROWN_H }} className="shrink-0" />
                <div
                  ref={setColumnRef(file.path)}
                  className={`flex min-h-0 flex-1 rounded-[10px] transition-shadow ${
                    highlight === file.path ? "ring-2 ring-accent/60" : ""
                  }`}
                >
                  <BranchPane
                    file={file}
                    tasks={[]}
                    files={files}
                    onSelect={openSwitchboardFile}
                    isRoot={!file.parent}
                    onClose={() => closeColumn(file.path)}
                  />
                </div>
              </div>
            ))}
          </FlipRow>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
          <div>
            <div className="text-[13.5px] font-semibold text-dim">Жодної відкритої колонки</div>
            <div className="mt-0.5 text-[12px] text-dim">Відкрий пульт у правому нижньому куті і клікни розмову — вона додасться сюди</div>
          </div>
        </div>
      )}

      <Switchboard files={files} project={project} onOpenFile={openSwitchboardFile} />

      {residual.length ? <ResidualStrip items={residual} onSelect={openSwitchboardFile} /> : null}
    </div>
  );
}
