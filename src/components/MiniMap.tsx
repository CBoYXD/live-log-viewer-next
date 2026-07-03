"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";

import { isConversation, kidsIndex, projectKey } from "./projectModel";
import { cleanTitle, engineColor, shortTitle, ukPlural } from "./utils";

/** Collapsed corner widget size. */
const MINI_W = 300;
const MINI_H = 168;

const PLOT_L = 148;
const PLOT_W = 1150;
const RIGHT_PAD = 184;
const LANE_H = 58;
const TICK_H = 24;
const PAD_B = 18;

const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

const FOCUS_DIRECT_LIMIT = 22;
const GLOBAL_DIRECT_LIMIT = 7;
const GLOBAL_CURRENT_DIRECT_LIMIT = 12;
const GLOBAL_LANE_LIMIT = 12;

type MapScope = "project" | "global";
type MapState = FileEntry["activity"];

/**
 * Nonlinear timeline: the last hour owns half the width, older activity
 * compresses toward the left edge. 1 = right edge (now).
 */
function timeFrac(age: number): number {
  if (age <= HOUR) return 1 - (age / HOUR) * 0.5;
  if (age <= DAY) return 0.5 - ((age - HOUR) / (DAY - HOUR)) * 0.28;
  if (age <= WEEK) return 0.22 - ((age - DAY) / (WEEK - DAY)) * 0.16;
  return Math.max(0.012, 0.06 - Math.min(1, (age - WEEK) / (4 * WEEK)) * 0.05);
}

const TICKS: { label: string; age: number }[] = [
  { label: "тиждень", age: WEEK },
  { label: "доба", age: DAY },
  { label: "година", age: HOUR },
  { label: "15 хв", age: 900 },
  { label: "зараз", age: 0 },
];

function bubbleR(totalBytes: number, descendants: number): number {
  const sizeBoost = Math.log2(Math.max(1, totalBytes / 65536));
  return Math.min(15, 6 + sizeBoost * 0.8 + Math.min(4, descendants * 0.08));
}

function clusterR(count: number, descendants: number): number {
  return Math.min(26, 10 + Math.sqrt(count) * 3 + Math.min(4, Math.log2(Math.max(1, descendants + 1))));
}

function fadeByAge(age: number, live: boolean): number {
  if (live || age < 900) return 1;
  if (age < 7200) return 0.86;
  if (age < DAY) return 0.68;
  if (age < WEEK) return 0.52;
  return 0.42;
}

function dotFill(activity: MapState): string {
  if (activity === "live") return "#2f9e44";
  if (activity === "recent") return "#d29a2f";
  if (activity === "stalled") return "#d64545";
  return "#b8b8c4";
}

interface TreeSummary {
  root: FileEntry;
  project: string;
  smt: number;
  age: number;
  live: boolean;
  state: MapState;
  descendants: number;
  bytes: number;
}

interface BubbleBase {
  key: string;
  x: number;
  y: number;
  r: number;
  state: MapState;
  fade: number;
  label: boolean;
  labelSide: "left" | "right";
  labelY?: number;
  labelText: string;
  title: string;
}

interface NodeBubble extends BubbleBase {
  kind: "node";
  file: FileEntry;
  descendants: number;
  live: boolean;
}

interface ClusterBubble extends BubbleBase {
  kind: "cluster";
  project: string;
  count: number;
  descendants: number;
}

type Bubble = NodeBubble | ClusterBubble;

interface Lane {
  project: string;
  y: number;
  live: boolean;
  recent: boolean;
  visible: number;
  total: number;
  clustered: number;
}

interface Layout {
  bubbles: Bubble[];
  lanes: Lane[];
  width: number;
  height: number;
  hiddenProjects: number;
}

function treeState(root: FileEntry, live: boolean, age: number): MapState {
  if (live) return "live";
  if (root.activity === "recent" || age < HOUR) return "recent";
  if (root.activity === "stalled") return "stalled";
  return "idle";
}

function buildTrees(files: FileEntry[]): TreeSummary[] {
  const now = Date.now() / 1000;
  const kids = kidsIndex(files);
  const roots = files.filter((file) => isConversation(file));

  return roots.map((root) => {
    let smt = root.mtime;
    let live = root.activity === "live";
    let bytes = root.size;
    let descendants = 0;
    const stack = [...(kids.get(root.path) ?? [])];
    const seen = new Set<string>([root.path]);
    while (stack.length) {
      const node = stack.pop()!;
      if (seen.has(node.path)) continue;
      seen.add(node.path);
      descendants += 1;
      smt = Math.max(smt, node.mtime);
      live ||= node.activity === "live";
      bytes += node.size;
      stack.push(...(kids.get(node.path) ?? []));
    }
    const age = Math.max(0, now - smt);
    return {
      root,
      project: projectKey(root),
      smt,
      age,
      live,
      state: treeState(root, live, age),
      descendants,
      bytes,
    };
  });
}

function treePriority(tree: TreeSummary, currentProject: string): number {
  return (
    (tree.project === currentProject ? 5000 : 0) +
    (tree.live ? 4000 : 0) +
    (tree.state === "recent" ? 2000 : 0) +
    Math.max(0, 1200 - tree.age / 120) +
    Math.min(500, tree.descendants * 8)
  );
}

function clusterBucket(age: number): { key: string; label: string; age: number } {
  if (age <= DAY * 3) return { key: "3d", label: "давні", age: DAY * 2 };
  if (age <= WEEK) return { key: "7d", label: "тиждень", age: WEEK };
  if (age <= MONTH) return { key: "30d", label: "місяць", age: WEEK * 2 };
  return { key: "archive", label: "архів", age: MONTH };
}

function selectLaneProjects(
  byProject: Map<string, TreeSummary[]>,
  currentProject: string,
  scope: MapScope,
): { projects: string[]; hiddenProjects: number } {
  if (scope === "project") return { projects: byProject.has(currentProject) ? [currentProject] : [], hiddenProjects: 0 };

  const entries = [...byProject.entries()].sort((a, b) => {
    if (a[0] === currentProject) return -1;
    if (b[0] === currentProject) return 1;
    const aLive = a[1].some((tree) => tree.live);
    const bLive = b[1].some((tree) => tree.live);
    if (aLive !== bLive) return aLive ? -1 : 1;
    const aRecent = a[1].some((tree) => tree.state === "recent" || tree.age <= DAY);
    const bRecent = b[1].some((tree) => tree.state === "recent" || tree.age <= DAY);
    if (aRecent !== bRecent) return aRecent ? -1 : 1;
    return Math.max(...b[1].map((tree) => tree.smt)) - Math.max(...a[1].map((tree) => tree.smt));
  });

  const projects = entries.slice(0, GLOBAL_LANE_LIMIT).map(([project]) => project);
  return { projects, hiddenProjects: Math.max(0, entries.length - projects.length) };
}

function visibleTreesForLane(trees: TreeSummary[], currentProject: string, scope: MapScope): TreeSummary[] {
  const limit = scope === "project" ? FOCUS_DIRECT_LIMIT : trees[0]?.project === currentProject ? GLOBAL_CURRENT_DIRECT_LIMIT : GLOBAL_DIRECT_LIMIT;
  const required = trees.filter((tree) => tree.live || tree.state === "recent" || tree.age <= (scope === "project" ? DAY * 2 : DAY));
  const selected = new Map(required.map((tree) => [tree.root.path, tree]));
  for (const tree of [...trees].sort((a, b) => treePriority(b, currentProject) - treePriority(a, currentProject))) {
    if (selected.size >= limit) break;
    selected.set(tree.root.path, tree);
  }
  return [...selected.values()].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.state !== b.state) return a.state === "recent" ? -1 : b.state === "recent" ? 1 : 0;
    return b.smt - a.smt;
  });
}

function placeInLane(
  x: number,
  r: number,
  center: number,
  placed: { x: number; y: number; r: number }[],
): number {
  for (const dy of [0, -14, 14, -25, 25]) {
    const y = center + dy;
    if (!placed.some((item) => Math.hypot(item.x - x, item.y - y) < item.r + r + 4)) return y;
  }
  return center;
}

function buildLayout(files: FileEntry[], currentProject: string, scope: MapScope): Layout {
  const trees = buildTrees(files);
  const byProject = new Map<string, TreeSummary[]>();
  for (const tree of trees) {
    const list = byProject.get(tree.project);
    if (list) list.push(tree);
    else byProject.set(tree.project, [tree]);
  }

  const { projects, hiddenProjects } = selectLaneProjects(byProject, currentProject, scope);
  const lanes: Lane[] = [];
  const bubbles: Bubble[] = [];

  projects.forEach((project, idx) => {
    const laneTrees = byProject.get(project) ?? [];
    const visible = visibleTreesForLane(laneTrees, currentProject, scope);
    const visiblePaths = new Set(visible.map((tree) => tree.root.path));
    const clustered = laneTrees.filter((tree) => !visiblePaths.has(tree.root.path));
    const y = TICK_H + idx * LANE_H;
    const center = y + LANE_H / 2;
    const placed: { x: number; y: number; r: number }[] = [];
    lanes.push({
      project,
      y,
      live: laneTrees.some((tree) => tree.live),
      recent: laneTrees.some((tree) => tree.state === "recent" || tree.age <= DAY),
      visible: visible.length,
      total: laneTrees.length,
      clustered: clustered.length,
    });

    visible.forEach((tree, directIdx) => {
      const x = PLOT_L + timeFrac(tree.age) * PLOT_W;
      const r = bubbleR(tree.bytes, tree.descendants);
      const by = placeInLane(x, r, center, placed);
      placed.push({ x, y: by, r });
      const shouldLabel =
        tree.live ||
        tree.state === "recent" ||
        (project === currentProject && scope === "project" && directIdx < 8) ||
        (project === currentProject && directIdx < 4);
      bubbles.push({
        kind: "node",
        key: tree.root.path,
        file: tree.root,
        x,
        y: by,
        r,
        descendants: tree.descendants,
        live: tree.live,
        state: tree.state,
        fade: fadeByAge(tree.age, tree.live),
        label: shouldLabel,
        labelSide: timeFrac(tree.age) > 0.7 ? "left" : "right",
        labelText: shortTitle(cleanTitle(tree.root.title), 24),
        title: `${cleanTitle(tree.root.title)} · ${tree.project}${tree.descendants ? ` · ⤷ ${tree.descendants}` : ""}`,
      });
    });

    const buckets = new Map<string, { label: string; age: number; trees: TreeSummary[] }>();
    for (const tree of clustered) {
      const bucket = clusterBucket(tree.age);
      const item = buckets.get(bucket.key);
      if (item) item.trees.push(tree);
      else buckets.set(bucket.key, { label: bucket.label, age: bucket.age, trees: [tree] });
    }

    [...buckets.entries()]
      .sort((a, b) => a[1].age - b[1].age)
      .forEach(([key, bucket]) => {
        const count = bucket.trees.length;
        const descendants = bucket.trees.reduce((sum, tree) => sum + tree.descendants, 0);
        const anyStalled = bucket.trees.some((tree) => tree.state === "stalled");
        const r = clusterR(count, descendants);
        const x = PLOT_L + timeFrac(bucket.age) * PLOT_W;
        const by = placeInLane(x, r, center, placed);
        placed.push({ x, y: by, r });
        bubbles.push({
          kind: "cluster",
          key: `cluster:${project}:${key}`,
          project,
          count,
          descendants,
          x,
          y: by,
          r,
          state: anyStalled ? "stalled" : "idle",
          fade: 0.62,
          label: false,
          labelSide: "right",
          labelText: bucket.label,
          title: `${project} · ${count} ${ukPlural(count, "давня розмова", "давні розмови", "давніх розмов")}`,
        });
      });
  });

  deoverlapLabels(bubbles);

  return {
    bubbles,
    lanes,
    width: PLOT_L + PLOT_W + RIGHT_PAD,
    height: TICK_H + lanes.length * LANE_H + PAD_B,
    hiddenProjects,
  };
}

function deoverlapLabels(bubbles: Bubble[]) {
  const boxes: { x1: number; x2: number; y: number }[] = [];
  for (const bubble of [...bubbles].filter((item) => item.label).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const width = bubble.labelText.length * 6.4 + 18;
    const x1 = bubble.labelSide === "right" ? bubble.x + bubble.r + 5 : bubble.x - bubble.r - 5 - width;
    const x2 = x1 + width;
    let labelY = bubble.y - 8;
    for (let guard = 0; guard < 8; guard += 1) {
      const hit = boxes.some((box) => box.x1 < x2 && box.x2 > x1 && Math.abs(box.y - labelY) < 15);
      if (!hit) break;
      labelY += 15;
    }
    bubble.labelY = labelY;
    boxes.push({ x1, x2, y: labelY });
  }
}

function TimelineCanvas({
  layout,
  scale,
  interactive,
  showLabels,
  currentProject,
  onNode,
}: {
  layout: Layout;
  scale: number;
  interactive: boolean;
  showLabels: boolean;
  currentProject: string;
  onNode: (file: FileEntry) => void;
}) {
  return (
    <div
      className={`relative ${interactive ? "" : "pointer-events-none"}`}
      style={{ width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: "top left" }}
    >
      <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
        {layout.lanes.map((lane, idx) => (
          <rect
            key={"lane:" + lane.project}
            x={0}
            y={lane.y}
            width={layout.width}
            height={LANE_H}
            fill={
              lane.project === currentProject
                ? "rgba(103,96,220,0.075)"
                : idx % 2
                  ? "rgba(107,107,118,0.035)"
                  : "transparent"
            }
          />
        ))}
        {TICKS.map((tick) => {
          const x = PLOT_L + timeFrac(tick.age) * PLOT_W;
          return (
            <line
              key={"tick:" + tick.label}
              x1={x}
              y1={TICK_H - 4}
              x2={x}
              y2={layout.height - PAD_B}
              stroke="rgba(107,107,118,0.14)"
              strokeDasharray="2 4"
            />
          );
        })}
      </svg>
      {TICKS.map((tick) => (
        <span
          key={"ticklabel:" + tick.label}
          className="absolute text-[9.5px] font-semibold text-dim"
          style={{ left: PLOT_L + timeFrac(tick.age) * PLOT_W - 18, top: 3 }}
        >
          {tick.label}
        </span>
      ))}
      {layout.lanes.map((lane) => (
        <span
          key={"lanelabel:" + lane.project}
          className={`absolute truncate pr-2 text-right text-[11px] ${
            lane.live ? "font-bold text-ink" : lane.recent ? "font-semibold text-ink/80" : "font-semibold text-dim"
          }`}
          style={{ left: 4, top: lane.y + LANE_H / 2 - 13, width: PLOT_L - 12 }}
          title={`${lane.project} · ${lane.total} ${ukPlural(lane.total, "розмова", "розмови", "розмов")}`}
        >
          <span className="block truncate">{lane.project}</span>
          {lane.clustered ? (
            <span className="block text-[9px] font-semibold text-dim">
              {lane.visible} видно · {lane.clustered} в групах
            </span>
          ) : (
            <span className="block text-[9px] font-semibold text-dim">{lane.visible} видно</span>
          )}
        </span>
      ))}
      {layout.bubbles.map((bubble) =>
        bubble.kind === "node" ? (
          <button
            key={bubble.key}
            className="absolute flex cursor-pointer items-center justify-center rounded-full transition-[filter] duration-150 hover:z-10 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            style={{
              left: bubble.x - bubble.r - 4,
              top: bubble.y - bubble.r - 4,
              width: bubble.r * 2 + 8,
              height: bubble.r * 2 + 8,
            }}
            title={bubble.title}
            aria-label={`Відкрити ${cleanTitle(bubble.file.title, 60)}`}
            tabIndex={interactive ? 0 : -1}
            onClick={() => onNode(bubble.file)}
          >
            <span
              className={`flex items-center justify-center rounded-full ${bubble.live ? "animate-pulse" : ""}`}
              style={{
                width: bubble.r * 2,
                height: bubble.r * 2,
                background: dotFill(bubble.state),
                border: `${bubble.r > 11 ? 2.5 : 1.5}px solid ${engineColor(bubble.file)}`,
                opacity: bubble.fade,
              }}
            />
            {bubble.descendants > 0 && bubble.r >= 8 ? (
              <span
                className="absolute rounded-full bg-panel/95 px-1 text-[8px] font-bold text-[#555]"
                style={{ right: -4, bottom: -3, opacity: bubble.fade }}
              >
                +{bubble.descendants}
              </span>
            ) : null}
          </button>
        ) : (
          <span
            key={bubble.key}
            className="pointer-events-none absolute flex items-center justify-center rounded-full border border-line bg-bg/90 text-[10px] font-bold text-dim shadow-sm"
            style={{
              left: bubble.x - bubble.r,
              top: bubble.y - bubble.r,
              width: bubble.r * 2,
              height: bubble.r * 2,
              opacity: bubble.fade,
            }}
            title={bubble.title}
          >
            {bubble.count}
          </span>
        ),
      )}
      {showLabels
        ? layout.bubbles
            .filter((bubble) => bubble.label)
            .map((bubble) => (
              <span
                key={"label:" + bubble.key}
                className={`pointer-events-none absolute whitespace-nowrap rounded-full border border-line bg-panel/90 px-1.5 text-[10px] ${
                  bubble.state === "live" ? "font-bold" : "font-semibold"
                }`}
                style={{
                  ...(bubble.labelSide === "right"
                    ? { left: bubble.x + bubble.r + 5 }
                    : { right: layout.width - bubble.x + bubble.r + 5 }),
                  top: bubble.labelY ?? bubble.y - 8,
                  opacity: bubble.fade,
                }}
              >
                {bubble.labelText}
              </span>
            ))
        : null}
    </div>
  );
}

function MapLegend({ hiddenProjects }: { hiddenProjects: number }) {
  return (
    <div className="pointer-events-none absolute bottom-2 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-full bg-panel/90 px-2.5 py-1 text-[9.5px] text-dim">
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> працює
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-[#d29a2f]" /> свіже
      </span>
      <span>число в колі = згорнута історія</span>
      {hiddenProjects ? <span>{hiddenProjects} проєктів приховано</span> : null}
    </div>
  );
}

function ZoomButton({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="h-7 min-w-7 rounded-[7px] border border-line bg-bg px-2 text-[12px] font-bold text-dim hover:text-ink disabled:cursor-default disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Corner minimap: project focus by default, with an expanded global view for
 * live/recent cross-project navigation.
 */
export function MiniMap({
  files,
  project,
  onNode,
}: {
  files: FileEntry[];
  project: string;
  onNode: (file: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState<MapScope>("project");
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number; active: boolean } | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, el.scrollWidth - el.clientWidth), top: 0 });
  }, [scope, expanded]);

  const compactLayout = useMemo(() => buildLayout(files, project, "project"), [files, project]);
  const layout = useMemo(() => buildLayout(files, project, scope), [files, project, scope]);

  if (!compactLayout.bubbles.length) return null;

  if (!expanded) {
    const scale = Math.min(MINI_W / compactLayout.width, (MINI_H - 18) / compactLayout.height);
    const openCompact = () => {
      setScope("project");
      setZoom(1);
      setExpanded(true);
    };
    return (
      <div
        role="button"
        tabIndex={0}
        className="absolute bottom-11 right-3 z-20 overflow-hidden rounded-[12px] border border-line bg-panel/95 shadow-card backdrop-blur hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        style={{ width: MINI_W, height: MINI_H }}
        aria-label="Розгорнути мапу проєкту"
        title="Мапа проєкту, клік щоб розгорнути"
        onClick={openCompact}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openCompact();
          }
        }}
      >
        <span className="absolute left-2 top-1.5 z-10 rounded-full bg-panel/90 px-1.5 text-[9.5px] font-bold uppercase tracking-[.5px] text-dim">
          мапа проєкту
        </span>
        <span className="absolute right-2 top-1.5 z-10 text-[11px] text-dim" aria-hidden>
          ⤢
        </span>
        <span
          className="absolute left-1 top-4 block origin-top-left"
          style={{ width: compactLayout.width * scale, height: compactLayout.height * scale }}
        >
          <TimelineCanvas
            layout={compactLayout}
            scale={scale}
            interactive={false}
            showLabels={false}
            currentProject={project}
            onNode={onNode}
          />
        </span>
      </div>
    );
  }

  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1600;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 900;
  const panelW = Math.min(1680, viewportW * 0.96);
  const panelH = viewportH * 0.92;
  const fitScale = Math.min(1.15, (panelW - 32) / layout.width, (panelH - 92) / layout.height);
  const renderScale = Math.max(0.34, fitScale * zoom);
  const canZoomOut = zoom > 0.72;
  const canZoomIn = zoom < 2.1;

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const el = viewportRef.current;
    if (!el) return;
    panRef.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, active: false };
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const el = viewportRef.current;
    if (!pan || !el) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.active) {
      if (Math.hypot(dx, dy) < 7) return;
      pan.active = true;
      el.setPointerCapture(event.pointerId);
      el.style.cursor = "grabbing";
      el.style.userSelect = "none";
    }
    el.scrollLeft = pan.left - dx;
    el.scrollTop = pan.top - dy;
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (panRef.current?.active && el) {
      el.releasePointerCapture(event.pointerId);
      el.style.cursor = "";
      el.style.userSelect = "";
    }
    panRef.current = null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35" onClick={() => setExpanded(false)}>
      <div
        className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-panel shadow-card"
        style={{ width: panelW, height: panelH }}
        role="dialog"
        aria-label="Мапа сесій"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="text-[11px] font-bold uppercase tracking-[.5px] text-dim">Мапа сесій</span>
          <div className="flex rounded-[8px] border border-line bg-bg p-0.5" aria-label="Режим мапи">
            {(["project", "global"] as const).map((item) => (
              <button
                key={item}
                className={`h-7 rounded-[6px] px-2.5 text-[11px] font-bold ${
                  scope === item ? "bg-panel text-ink shadow-sm" : "text-dim hover:text-ink"
                } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
                aria-pressed={scope === item}
                onClick={() => {
                  setScope(item);
                  setZoom(1);
                }}
              >
                {item === "project" ? "проєкт" : "усі"}
              </button>
            ))}
          </div>
          <span className="truncate text-[11.5px] text-dim">
            {scope === "project"
              ? "поточний проєкт · старі розмови згорнуті в групи"
              : "активні й нещодавні проєкти · архів згорнутий"}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <ZoomButton label="−" title="Зменшити масштаб" disabled={!canZoomOut} onClick={() => setZoom((value) => Math.max(0.7, value - 0.18))} />
            <ZoomButton label={`${Math.round(zoom * 100)}%`} title="Скинути масштаб" onClick={() => setZoom(1)} />
            <ZoomButton label="+" title="Збільшити масштаб" disabled={!canZoomIn} onClick={() => setZoom((value) => Math.min(2.15, value + 0.18))} />
            <button
              className="ml-2 rounded-[7px] border border-line bg-bg px-2.5 py-1 text-[11px] font-semibold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Згорнути мапу"
              onClick={() => setExpanded(false)}
            >
              згорнути ✕
            </button>
          </div>
        </div>
        <div
          ref={viewportRef}
          className="relative min-h-0 flex-1 overflow-auto bg-bg/35 p-3"
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div style={{ width: layout.width * renderScale, height: layout.height * renderScale }}>
            <TimelineCanvas
              layout={layout}
              scale={renderScale}
              interactive
              showLabels
              currentProject={project}
              onNode={(file) => {
                setExpanded(false);
                onNode(file);
              }}
            />
          </div>
          <MapLegend hiddenProjects={layout.hiddenProjects} />
        </div>
      </div>
    </div>
  );
}
