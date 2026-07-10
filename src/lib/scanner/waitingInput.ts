import { detectLiveRateLimit, parseScreenMenu, screenAtIdleComposer, screenWaitsForInput } from "@/lib/status";
import { paneScreen, resolveTarget } from "@/lib/tmux";

import type { FileEntry, RateLimitState, WaitingInput } from "../types";

const QUIET_SECONDS = 15;
const STABLE_MS = 15_000;
const PROBE_TTL_MS = 10 * 60_000;

interface ProbeState {
  screen: string;
  at: number;
  since: number;
}

const probes = new Map<string, ProbeState>();

function looksPromptLike(screen: string): boolean {
  return screenWaitsForInput(screen);
}

/* Raw fallback body of the card when the dialog didn't parse: the last screen
   lines with their line breaks kept, instead of a three-line « | » mash. */
function screenBlock(screen: string): string {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim());
  return lines.slice(-10).join("\n").slice(-1200);
}

export interface WaitingProbe {
  waiting: WaitingInput | null;
  rateLimit: RateLimitState | null;
  /** The pane was read and shows a plain composer, no dialog: the agent is
      parked at its prompt, so a still-open turn in the transcript is an
      interrupt artifact rather than a wait on the user. */
  atComposer: boolean;
}

const NO_PROBE: WaitingProbe = { waiting: null, rateLimit: null, atComposer: false };

export interface WaitingInputProbeDeps {
  now(): number;
  resolveTarget(pid: number): Promise<string | null>;
  paneScreen(target: string): Promise<string>;
}

const DEFAULT_DEPS: WaitingInputProbeDeps = {
  now: () => Date.now(),
  resolveTarget,
  paneScreen,
};

export async function waitingInputProbe(entry: FileEntry, deps: WaitingInputProbeDeps = DEFAULT_DEPS): Promise<WaitingProbe> {
  const now = deps.now();
  for (const [key, value] of probes) {
    if (now - value.at > PROBE_TTL_MS) probes.delete(key);
  }
  if (entry.proc !== "running" || entry.pid === null || entry.pendingQuestion) {
    probes.delete(entry.path);
    return NO_PROBE;
  }
  if (now / 1000 - entry.mtime < QUIET_SECONDS) return NO_PROBE;
  const target = await deps.resolveTarget(entry.pid);
  if (target === null) return NO_PROBE;
  const screen = await deps.paneScreen(target);
  const liveRateLimit = detectLiveRateLimit(screen, now / 1000);
  if (liveRateLimit) {
    probes.delete(entry.path);
    return {
      waiting: null,
      rateLimit: { source: "pane", accountId: null, window: null, resetAt: liveRateLimit.resetAt },
      atComposer: false,
    };
  }
  if (!looksPromptLike(screen)) {
    probes.delete(entry.path);
    /* Only a positively idle composer counts: a quiet busy screen (long
       command, streamed output, no menu) must keep its stalled verdict, or
       the turn-open guard downstream (activity, STAGE_DONE detection) loses
       its meaning. */
    return { waiting: null, rateLimit: null, atComposer: screenAtIdleComposer(screen) };
  }
  const previous = probes.get(entry.path);
  if (!previous || previous.screen !== screen) {
    probes.set(entry.path, { screen, at: now, since: now / 1000 });
    return NO_PROBE;
  }
  probes.set(entry.path, { ...previous, at: now });
  if (now / 1000 - previous.since < STABLE_MS / 1000) return NO_PROBE;
  return {
    waiting: { since: previous.since, screenTail: screenBlock(screen), target, menu: parseScreenMenu(screen) },
    rateLimit: null,
    atComposer: false,
  };
}
