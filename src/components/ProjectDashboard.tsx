"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { TaskStrip } from "./BranchPane";
import { clearDraftStorage } from "./DraftAgentPane";
import { claimedReviewerPaths } from "./flows/flowModel";
import { SchemeBoard } from "./scheme/SchemeBoard";
import { Switchboard } from "./Switchboard";
import { buildBranchGroups, collapsedTrees, projectKey, residualItems } from "./projectModel";
import { DeleteProjectButton, QuietFileList } from "./ProjectTrash";
import { SoundToggle } from "./SoundToggle";
import { ResidualStrip } from "./TreeAside";
import { ukPlural } from "./utils";

/** How long an opened node keeps its highlight ring on the scheme. */
const HIGHLIGHT_MS = 1800;

interface Props {
  files: FileEntry[];
  flows: Flow[];
  project: string;
  /** Bumped by Viewer on every openFile so a same-project open re-reads prefs
      even though `project` itself did not change. */
  openNonce: number;
}

/** Manual additions and removals of scheme nodes, persisted per project. */
interface ColumnPrefs {
  manual: string[];
  hidden: string[];
}

const prefsKey = (project: string) => `llvCols:${project}`;
/* Conversation drafts survive remounts and reloads within the tab: an agent
   booted from a draft keeps its waiting pane until the transcript arrives. */
const draftsKey = (project: string) => `llvDrafts:${project}`;

function loadDrafts(project: string): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftsKey(project)) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadPrefs(project: string): ColumnPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(prefsKey(project)) ?? "{}") as Partial<ColumnPrefs>;
    return { manual: raw.manual ?? [], hidden: raw.hidden ?? [] };
  } catch {
    return { manual: [], hidden: [] };
  }
}

/** Pre-adds a conversation as a manual scheme node of its project. */
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

export function ProjectDashboard({ files, flows, project, openNonce }: Props) {
  const highlightTimer = useRef<number | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const [prefs, setPrefs] = useState<ColumnPrefs>({ manual: [], hidden: [] });
  const [drafts, setDrafts] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  /* Mirrors `prefs` synchronously so the missing-nodes effect below can read
     the value the project-switch load just set, even within the same commit
     (state updates from sibling effects are not visible via closure yet). */
  const prefsRef = useRef(prefs);

  useEffect(() => {
    const loaded = loadPrefs(project);
    prefsRef.current = loaded;
    /* eslint-disable react-hooks/set-state-in-effect */
    setPrefs(loaded);
    setDrafts(loadDrafts(project));
    /* eslint-enable react-hooks/set-state-in-effect */
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

  /* Reviewer transcripts of active flows live inside their round decks:
     they never build their own groups, quiet trees or residual chips. */
  const groupFiles = useMemo(() => {
    const claimed = claimedReviewerPaths(flows);
    return claimed.size ? files.filter((file) => !claimed.has(file.path)) : files;
  }, [files, flows]);
  const groups = useMemo(() => buildBranchGroups(groupFiles, project), [groupFiles, project]);
  const activeRoots = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const cards = useMemo(() => collapsedTrees(groupFiles, project, activeRoots), [groupFiles, project, activeRoots]);
  const residual = useMemo(() => residualItems(groupFiles, project, activeRoots), [groupFiles, project, activeRoots]);
  const autoPaths = useMemo(
    () => new Set(groups.flatMap((group) => group.columns.map((column) => column.file.path))),
    [groups],
  );
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const manualNodes = useMemo(() => {
    const byPath = new Map(groupFiles.map((file) => [file.path, file]));
    return prefs.manual
      .map((path) => byPath.get(path))
      .filter(
        (file): file is FileEntry =>
          file !== undefined && projectKey(file) === project && !autoPaths.has(file.path) && !hiddenSet.has(file.path),
      );
  }, [prefs.manual, groupFiles, project, autoPaths, hiddenSet]);
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

  /* The highlight drives the scheme: the camera glides to the node and rings it. */
  const flashNode = (path: string) => {
    setHighlight(path);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  };

  /* A node added from the switchboard enters the layout on the next render;
     flash it then so the camera has something to glide to. */
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    flashNode(pending);
  });

  const persistDrafts = (next: string[]) => {
    setDrafts(next);
    sessionStorage.setItem(draftsKey(project), JSON.stringify(next));
  };

  /* The «+ Агент» flow: a draft conversation lands on the scheme as a full
     pane and the camera glides to it — engine, directory and the first prompt
     are picked right inside that pane. */
  const addDraft = () => {
    /* randomUUID needs a secure context; LAN http access gets the fallback. */
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
  };

  const removeDraft = (id: string) => {
    clearDraftStorage(id);
    persistDrafts(drafts.filter((item) => item !== id));
  };

  /* The draft's agent booted and its transcript arrived: the real node takes
     the draft's place (openSwitchboardFile also covers a cwd from another
     project by switching there). */
  const draftSpawned = (id: string, file: FileEntry) => {
    removeDraft(id);
    openSwitchboardFile(file);
  };

  const closeNode = (path: string) => {
    /* Closing a chat also puts out its tmux pane; fire-and-forget, since the
       node disappears either way and a pane that survived a failed request
       just stays for the next close. Branch nodes are filtered server-side —
       they share the root's pane. */
    void fetch("/api/tmux", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "kill", path }),
    }).catch(() => {});
    const manual = prefs.manual.filter((item) => item !== path);
    const hidden = autoPaths.has(path) ? [...new Set([...prefs.hidden, path])] : prefs.hidden;
    persistPrefs({ manual, hidden });
  };

  /* A node never vanishes on its own: every auto node is recorded as a
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

  /* Any open lands on the scheme: a card of another project pre-adds its node
     and switches the project; a conversation of this project joins the managed
     node list (or gets flashed when already there). */
  const openSwitchboardFile = (file: FileEntry) => {
    const fileProject = projectKey(file);
    if (fileProject !== project) {
      queueColumnOpen(fileProject, file.path);
      gotoProject(fileProject);
      return;
    }
    const visible =
      (autoPaths.has(file.path) && !hiddenSet.has(file.path)) || manualNodes.some((item) => item.path === file.path);
    if (visible) {
      flashNode(file.path);
      return;
    }
    const hidden = prefs.hidden.filter((item) => item !== file.path);
    const manual = autoPaths.has(file.path) ? prefs.manual : [...new Set([...prefs.manual, file.path])];
    persistPrefs({ manual, hidden });
    pendingFocusRef.current = file.path;
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

  const visibleGroups = groups
    .map((group) => ({ ...group, columns: group.columns.filter((column) => !hiddenSet.has(column.file.path)) }))
    .filter((group) => group.columns.length);
  /* Parentless background processes dock as colored strips at the top of the
     canvas instead of hanging as lone stub nodes in the middle of it. */
  const dockedTasks = visibleGroups.filter((group) => group.orphanTask).map((group) => group.columns[0]!.file);
  const schemeGroups = visibleGroups.filter((group) => !group.orphanTask);
  const hasNodes = schemeGroups.length > 0 || manualNodes.length > 0 || drafts.length > 0;
  /* Everything the project has on disk, freshest first. Powers the
     delete-project button and the fallback list of an empty scheme —
     transcripts whose tree lives elsewhere (scratchpad one-offs) build no
     groups/cards/residual chips, yet keep the project in the rail. */
  const projectFiles = useMemo(
    () => files.filter((file) => projectKey(file) === project).sort((a, b) => b.mtime - a.mtime),
    [files, project],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
        <h1 className="truncate text-[13.5px] font-bold">{project}</h1>
        <span className="truncate text-[11.5px] text-dim">{statusBits.length ? statusBits.join(" · ") : "зараз нічого не працює"}</span>
        <SoundToggle />
        <DeleteProjectButton files={projectFiles} />
        <button
          type="button"
          onClick={addDraft}
          aria-label="Нова розмова з агентом"
          className="ml-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="text-[13px] leading-none text-accent">+</span> Агент
        </button>
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

      {hasNodes ? (
        <SchemeBoard
          project={project}
          groups={schemeGroups}
          manual={manualNodes}
          files={files}
          flows={flows}
          drafts={drafts}
          focus={highlight}
          onSelect={openSwitchboardFile}
          onClose={closeNode}
          onDraftClose={removeDraft}
          onDraftSpawned={draftSpawned}
        />
      ) : projectFiles.length ? (
        <QuietFileList files={projectFiles} onOpen={openSwitchboardFile} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
          <div>
            <div className="text-[13.5px] font-semibold text-dim">На схемі поки порожньо</div>
            <div className="mt-0.5 text-[12px] text-dim">Відкрий пульт у правому нижньому куті і клікни розмову — вона з&apos;явиться тут</div>
          </div>
        </div>
      )}

      <Switchboard files={files} flows={flows} project={project} onOpenFile={openSwitchboardFile} />

      {residual.length ? <ResidualStrip items={residual} onSelect={openSwitchboardFile} /> : null}
    </div>
  );
}
