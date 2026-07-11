"use client";

import { useEffect, useRef } from "react";

import { paneState, type PaneState } from "@/components/paneState";
import { isAuxTask } from "@/components/projectModel";
import { conversationIdentity, isArchivedPredecessor } from "@/lib/accounts/identity";
import { chime, type ChimeKind, panForPane, primeAudio } from "@/lib/chime";
import type { FileEntry } from "@/lib/types";

const CHIME_OF: Partial<Record<PaneState, ChimeKind>> = {
  waiting: "waiting",
  returned: "returned",
  stalled: "stalled",
};

/** Several agents finishing in one poll ring as a cascade, not a cluster chord. */
const STAGGER_MS = 220;

export interface TrackedConversation {
  state: PaneState;
  parent: string | null;
  /** The entry this identity currently resolves to, so the transition scan
      reads the live annotation without a second path lookup. */
  file: FileEntry;
}

export interface PlannedChime {
  kind: ChimeKind;
  /** Conversation identity the chime pans toward. */
  id: string;
}

export interface ChimePlan {
  /** Baseline for the next poll: every identity ever seen with its last known
      state — identities that fell out of the capped feed are retained, so a
      conversation that merely churned out of the recency cap and returned does
      not read as a brand-new agent (that was the storm of identical chimes). */
  tracked: Map<string, TrackedConversation>;
  /** Children that have rung their spawn blip. */
  linked: Set<string>;
  chimes: PlannedChime[];
}

/**
 * Pure transition scan behind {@link useAgentChimes}: compares the current
 * poll against the accumulated baseline and plans which chimes to ring.
 * `prev === null` is the first poll after page load — it only seeds the
 * baseline, so reloading over finished work stays silent.
 */
export function planAgentChimes(
  files: readonly FileEntry[],
  prev: ReadonlyMap<string, TrackedConversation> | null,
  linked: ReadonlySet<string>,
): ChimePlan {
  /* Keyed by the stable conversation identity, never the transcript path: a
     committed account migration swaps the path but keeps the conversation, so
     tracking by identity means succession is silent instead of ringing a
     spurious finish-then-spawn cascade (falls back to path pre-migration).
     Archived predecessors share their successor's identity and would flap the
     tracked state between generations, so they are skipped outright. */
  const next = new Map<string, TrackedConversation>();
  for (const file of files) {
    if (!isAuxTask(file) && !isArchivedPredecessor(file)) next.set(conversationIdentity(file), { state: paneState(file), parent: file.parent, file });
  }
  const nextLinked = new Set(linked);
  const chimes: PlannedChime[] = [];
  if (!prev) {
    for (const [id, cur] of next) if (cur.parent) nextLinked.add(id);
    return { tracked: next, linked: nextLinked, chimes };
  }
  for (const [id, cur] of next) {
    const file = cur.file;
    const kind = file?.pendingQuestion || file?.waitingInput ? "question" : CHIME_OF[cur.state];
    const was = prev.get(id);
    const finished = kind !== undefined && (was?.state === "live" || was === undefined);
    if (kind !== undefined && finished) chimes.push({ kind, id });
    if (cur.parent && !nextLinked.has(id)) {
      nextLinked.add(id);
      /* Skip the blip when a finish chime just announced this same
         conversation — a subagent that lived its whole life between polls
         rings once. */
      if (!finished) chimes.push({ kind: "spawned", id });
    }
  }
  return { tracked: new Map([...prev, ...next]), linked: nextLinked, chimes };
}

/**
 * Watches the polled file list for lifecycle transitions and rings a chime
 * when an agent finishes its turn: left `live` into an attention state, or
 * appeared already finished (a branch that ran its whole life between polls).
 * A new node joining the agent tree — a fresh subagent, or an existing
 * conversation whose parent link got resolved — rings its own `spawned`
 * blip, unless a finish chime for the same path already carries the news.
 * The first poll after page load only seeds the baseline — reloading over
 * finished work stays silent.
 */
export function useAgentChimes(files: FileEntry[]) {
  const prevRef = useRef<Map<string, TrackedConversation> | null>(null);
  /* Children that already rang their spawn blip; a parent link that flaps
     null → set → null in the scanner must not re-announce the same agent. */
  const linkedRef = useRef<Set<string>>(new Set());

  useEffect(() => primeAudio(), []);

  useEffect(() => {
    if (!files.length) return;
    const plan = planAgentChimes(files, prevRef.current, linkedRef.current);
    prevRef.current = plan.tracked;
    linkedRef.current = plan.linked;
    plan.chimes.forEach((planned, voice) => chime(planned.kind, panForPane(planned.id), voice * STAGGER_MS));
  }, [files]);
}
