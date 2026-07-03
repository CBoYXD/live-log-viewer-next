import type { FileEntry } from "../types";
import { activity } from "./activity";
import { discoverFiles } from "./discover";
import { linkEntries } from "./links";
import { entryModel } from "./model";

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
export async function listFiles(): Promise<FileEntry[]> {
  const entries = discoverFiles();
  for (const entry of entries) {
    entry.activity = activity(entry.root, entry.path, entry.mtime, entry.size);
    entry.model = entryModel(entry);
  }
  linkEntries(entries);
  return entries;
}
