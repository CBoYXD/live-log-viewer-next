"use client";

import { useCallback, useEffect, useState } from "react";

import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useFiles } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";

const PROJECT_KEY = "llvProject";

function readHash(): { filePath: string | null; project: string | null } {
  const fileMatch = location.hash.match(/^#f=(.+)$/);
  if (fileMatch) {
    try {
      return { filePath: decodeURIComponent(fileMatch[1]), project: null };
    } catch {
      return { filePath: fileMatch[1], project: null };
    }
  }
  const projectMatch = location.hash.match(/^#p=(.+)$/);
  if (projectMatch) {
    try {
      return { filePath: null, project: decodeURIComponent(projectMatch[1]) };
    } catch {
      return { filePath: null, project: projectMatch[1] };
    }
  }
  return { filePath: null, project: null };
}

function writeHash(project: string) {
  if (project !== OVERVIEW) {
    history.replaceState(null, "", "#p=" + encodeURIComponent(project));
    return;
  }
  history.replaceState(null, "", location.pathname);
}

export function Viewer() {
  const files = useFiles();
  useAgentChimes(files);
  const [project, setProject] = useState<string>(OVERVIEW);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  /* Reopening a file whose project is already selected does not change
     `project`, so ProjectDashboard would never remount or re-read prefs.
     Bumping this on every same-project open gives it an explicit signal. */
  const [openNonce, setOpenNonce] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const initial = readHash();
    if (initial.filePath) setPendingPath(initial.filePath);
    const savedProject = initial.project ?? localStorage.getItem(PROJECT_KEY);
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      if (next.filePath) setPendingPath(next.filePath);
      else if (next.project) setProject(next.project);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    localStorage.setItem(PROJECT_KEY, nextProject);
    writeHash(nextProject);
  }, []);

  /* A file open (overview card, deep link) becomes a column of its project. */
  const openFile = useCallback(
    (file: FileEntry) => {
      const key = projectKey(file);
      queueColumnOpen(key, file.path);
      selectProject(key);
      setOpenNonce((value) => value + 1);
    },
    [selectProject],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingPath || files.length === 0) return;
    const hit = files.find((file) => file.path === pendingPath);
    if (hit) openFile(hit);
    setPendingPath(null);
  }, [pendingPath, files, openFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex h-full">
      <ProjectRail files={files} selected={project} onSelect={selectProject} />
      <main className="flex min-w-0 flex-1 flex-col">
        {project === OVERVIEW ? (
          <OverviewBoard files={files} onSelectProject={selectProject} onSelectFile={openFile} />
        ) : (
          <ProjectDashboard files={files} project={project} openNonce={openNonce} />
        )}
      </main>
    </div>
  );
}
