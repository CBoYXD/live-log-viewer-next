import type { FileEntry } from "../types";
import { activity } from "./activity";
import { discoverFiles } from "./discover";
import { numberValue, readJson } from "./json";
import { linkEntries } from "./links";
import { entryModel } from "./model";
import { outputHolders, pidAlive } from "./process";
import { assignTranscriptPids } from "./transcripts";

function applyProcessState(entry: FileEntry, holders: Map<string, number>, job: Record<string, unknown> | null) {
  if (entry.root === "codex-jobs") {
    if (!job) return;
    const pid = numberValue(job.pid);
    entry.pid = pid;
    if (job.status === "running") {
      if (pid !== null && pidAlive(pid)) {
        entry.proc = "running";
        entry.activity = "live";
      } else {
        entry.proc = "killed";
        if (entry.activity === "live") entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle";
      }
      return;
    }
    entry.proc = "done";
    return;
  }
  if (entry.root === "claude-tasks" && entry.path.endsWith(".output")) {
    const holder = holders.get(entry.path) ?? null;
    entry.pid = holder;
    entry.proc = holder === null ? "done" : "running";
    if (holder !== null) entry.activity = "live";
  }
}

/**
 * TODO(codex): full pipeline port of `list_files` from the prototype
 * (the original single-file Python prototype):
 *
 *  1. discover.ts  — walk ROOTS, filter EXTS, skip `tool-results/` and
 *     everything in claude-tasks that is not `<slug>/<sid>/tasks/*.output`,
 *     skip a-prefixed task outputs that mirror subagents/agent-<id>.jsonl,
 *     stat each file, sort by mtime desc, cap at FILE_CAP.
 *  2. describe.ts  — project/title/kind/engine/fmt per root (port `describe`,
 *     `_scan_jsonl_title`, `_project_from_slug`), size-keyed cache.
 *  3. activity.ts  — port `_tail_records`, `_jsonl_turn_state`, `_activity`
 *     (age gate: files quiet >30 min are idle without reading).
 *  4. model.ts     — port `_entry_model` + `_short_model`.
 *  5. links.ts     — port `_link_entries` (parent links + bg-task command
 *     recovery + project inheritance from root ancestor).
 *
 * Steps 3-5 run only on the capped shortlist.
 */
const NO_HOLDERS: Map<string, number> = new Map();

export async function listFiles(): Promise<FileEntry[]> {
  const entries = discoverFiles();
  // The /proc fd scan is only needed to attribute background-task outputs to a
  // live pid. When the shortlist has no such entries, skip the scan entirely;
  // activity() only consults holders on the same claude-tasks/.output path.
  const needsHolders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output"));
  const holders = needsHolders ? outputHolders() : NO_HOLDERS;
  const jobs = new Map<string, Record<string, unknown> | null>();
  for (const entry of entries) {
    const job = entry.root === "codex-jobs" ? readJson(entry.path.replace(/\.log$/, ".json")) : null;
    jobs.set(entry.path, job);
    entry.activity = activity(entry.root, entry.path, entry.mtime, entry.size, job);
    entry.model = entryModel(entry);
  }
  for (const entry of entries) {
    applyProcessState(entry, holders, jobs.get(entry.path) ?? null);
  }
  assignTranscriptPids(entries);
  linkEntries(entries);
  return entries;
}
