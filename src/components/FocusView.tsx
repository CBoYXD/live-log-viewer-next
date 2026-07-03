"use client";

import { useMemo, useState } from "react";

import type { FileEntry } from "@/lib/types";

import { LogFeed } from "./LogFeed";
import { descendantsOf } from "./projectModel";
import { ProcessStatusControls } from "./TaskHeader";
import { activityDot, cleanTitle, engineBadge, shortTitle } from "./utils";

interface Props {
  file: FileEntry;
  files: FileEntry[];
  projectLabel: string;
  onBack: () => void;
  onSelect: (file: FileEntry) => void;
}

export function FocusView({ file, files, projectLabel, onBack, onSelect }: Props) {
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showSvc, setShowSvc] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const [status, setStatus] = useState("");
  const [descExpanded, setDescExpanded] = useState(false);

  const badge = engineBadge(file);
  const ancestors = useMemo(() => {
    const byPath = new Map(files.map((entry) => [entry.path, entry]));
    const chain: FileEntry[] = [];
    const seen = new Set<string>([file.path]);
    let cur = file;
    while (cur.parent && !seen.has(cur.parent)) {
      const parent = byPath.get(cur.parent);
      if (!parent) break;
      seen.add(parent.path);
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }, [file, files]);
  const crumb = ancestors.length > 2 ? [ancestors[0]!, ancestors.at(-1)!] : ancestors;
  const descendants = useMemo(() => descendantsOf(file, files), [file, files]);
  const visibleDescendants = descExpanded ? descendants : descendants.slice(0, 6);
  const hiddenDescendantCount = Math.max(0, descendants.length - visibleDescendants.length);

  const toggleCls = (active: boolean) =>
    `shrink-0 rounded-[9px] border border-line px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
      active ? "bg-[#ecebfb] font-semibold text-accent" : "bg-panel hover:bg-bg"
    }`;

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
        <button
          className="shrink-0 rounded-[9px] border border-line bg-panel px-2.5 py-1 text-[12px] font-semibold text-accent hover:bg-[#ecebfb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onBack}
        >
          ← {projectLabel}
        </button>
        {crumb.map((ancestor, idx) => (
          <span key={ancestor.path} className="flex shrink-0 items-center gap-1">
            {idx === 1 && ancestors.length > 2 ? <span className="text-[10px] text-dim">⤷ …</span> : null}
            <button
              className="max-w-[220px] truncate rounded-full border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              title={cleanTitle(ancestor.title)}
              onClick={() => onSelect(ancestor)}
            >
              {shortTitle(cleanTitle(ancestor.title), 24)}
            </button>
            <span className="text-[10px] text-dim">⤷</span>
          </span>
        ))}
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-bold" title={cleanTitle(file.title)}>
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${badge.cls}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {badge.label}
          </span>
          {file.model ? (
            <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 font-mono text-[10px] font-semibold text-[#555]">
              {file.model}
            </span>
          ) : null}
          <span className="shrink-0 text-[10.5px] font-normal text-dim">{file.kind}</span>
          <span className="min-w-0 truncate">{cleanTitle(file.title)}</span>
        </div>
        <ProcessStatusControls key={file.path} file={file} />
        <button className={toggleCls(follow)} onClick={() => setFollow((value) => !value)}>
          Follow
        </button>
        <button className={toggleCls(paused)} onClick={() => setPaused((value) => !value)}>
          {paused ? "Продовжити" : "Пауза"}
        </button>
        <button className={toggleCls(showSvc)} onClick={() => setShowSvc((value) => !value)}>
          Службові
        </button>
        <input
          className="w-40 shrink-0 rounded-[9px] border border-line bg-bg px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          placeholder="Фільтр рядків…"
          value={lineFilter}
          onChange={(event) => setLineFilter(event.target.value)}
        />
        <span className="shrink-0 text-[11px] text-dim">{status}</span>
      </div>
      {descendants.length ? (
        <div
          className={`flex gap-1.5 overflow-x-auto border-b border-line bg-panel px-4 py-1 ${descExpanded ? "flex-wrap" : "flex-nowrap"}`}
        >
          {visibleDescendants.map(({ file: item, depth }) => {
            const itemBadge = engineBadge(item);
            const done = item.activity === "idle";
            return (
              <button
                key={item.path}
                className={`inline-flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  file.path === item.path ? "border-accent bg-[#ecebfb] text-accent" : "border-line bg-bg text-ink"
                } ${done ? "opacity-60" : ""}`}
                title={`${depth > 1 ? "гілка глибини " + depth + " · " : ""}${cleanTitle(item.title)}`}
                onClick={() => onSelect(item)}
              >
                <span className="shrink-0 font-normal text-dim">{"⤷".repeat(Math.min(depth, 3))}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${itemBadge.cls}`}>{itemBadge.label}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(item.activity)}`} />
                <span className="truncate">{shortTitle(item.title)}</span>
              </button>
            );
          })}
          {hiddenDescendantCount || descExpanded ? (
            <button
              className="inline-flex h-7 shrink-0 items-center rounded-full border border-line bg-bg px-2.5 text-[11.5px] font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => setDescExpanded((value) => !value)}
            >
              {descExpanded ? "Згорнути" : `+${hiddenDescendantCount}`}
            </button>
          ) : null}
        </div>
      ) : null}
      <LogFeed
        file={file}
        files={files}
        onSelect={onSelect}
        showSvc={showSvc}
        lineFilter={lineFilter}
        onStatus={setStatus}
        paused={paused}
        follow={follow}
        setFollow={setFollow}
      />
    </>
  );
}
