"use client";

import { useCallback, useEffect, useState } from "react";

import { useFiles } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

import { FocusView } from "./FocusView";
import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard } from "./ProjectDashboard";
import { OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";
import { syntheticFile } from "./utils";

const PROJECT_KEY = "llvProject";

function readHash(): { focusPath: string | null; project: string | null } {
  const focusMatch = location.hash.match(/^#f=(.+)$/);
  if (focusMatch) {
    try {
      return { focusPath: decodeURIComponent(focusMatch[1]), project: null };
    } catch {
      return { focusPath: focusMatch[1], project: null };
    }
  }
  const projectMatch = location.hash.match(/^#p=(.+)$/);
  if (projectMatch) {
    try {
      return { focusPath: null, project: decodeURIComponent(projectMatch[1]) };
    } catch {
      return { focusPath: null, project: projectMatch[1] };
    }
  }
  return { focusPath: null, project: null };
}

function writeHash(project: string, focusPath: string | null) {
  if (focusPath) {
    history.replaceState(null, "", "#f=" + encodeURIComponent(focusPath));
    return;
  }
  if (project !== OVERVIEW) {
    history.replaceState(null, "", "#p=" + encodeURIComponent(project));
    return;
  }
  history.replaceState(null, "", location.pathname);
}

export function Viewer() {
  const files = useFiles();
  const [project, setProject] = useState<string>(OVERVIEW);
  const [focus, setFocus] = useState<FileEntry | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const initial = readHash();
    if (initial.focusPath) setPendingPath(initial.focusPath);
    const savedProject = initial.project ?? localStorage.getItem(PROJECT_KEY);
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      if (next.focusPath) setPendingPath(next.focusPath);
      else if (next.project) {
        setProject(next.project);
        setFocus(null);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    setFocus(null);
    localStorage.setItem(PROJECT_KEY, nextProject);
    writeHash(nextProject, null);
  }, []);

  const selectFile = useCallback((file: FileEntry) => {
    const key = projectKey(file);
    setProject(key);
    setFocus(file);
    localStorage.setItem(PROJECT_KEY, key);
    writeHash(key, file.path);
  }, []);

  const backToProject = useCallback(() => {
    setFocus(null);
    writeHash(project, null);
  }, [project]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingPath || files.length === 0) return;
    const hit = files.find((file) => file.path === pendingPath);
    selectFile(hit ?? syntheticFile(pendingPath));
    setPendingPath(null);
  }, [pendingPath, files, selectFile]);

  useEffect(() => {
    if (!focus) return;
    const fresh = files.find((file) => file.path === focus.path);
    if (fresh && fresh !== focus) setFocus(fresh);
  }, [files, focus]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex h-full">
      {/* The rail hides in focus mode so the reading column centers on the viewport. */}
      {focus ? null : <ProjectRail files={files} selected={project} onSelect={selectProject} />}
      <main className="flex min-w-0 flex-1 flex-col">
        {focus ? (
          <FocusView
            key={focus.path}
            file={focus}
            files={files}
            projectLabel={projectKey(focus)}
            onBack={backToProject}
            onSelect={selectFile}
          />
        ) : project === OVERVIEW ? (
          <OverviewBoard files={files} onSelectProject={selectProject} onSelectFile={selectFile} />
        ) : (
          <ProjectDashboard files={files} project={project} onSelect={selectFile} />
        )}
      </main>
    </div>
  );
}
