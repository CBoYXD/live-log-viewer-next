import { READY_MARKERS } from "@/lib/status";
import type { PendingQuestion } from "@/lib/types";

/**
 * Pure screen→structure parsing for the TUI option menus both agent CLIs
 * draw. Everything here is a function of the captured screen string, so the
 * fragile knowledge — cursor glyphs, box-drawing noise, highlight detection —
 * is testable against recorded screens without a live pane.
 */

export interface OptionLine {
  index: number;
  raw: string;
  label: string;
  normalized: string;
  highlighted: boolean;
}

export function normalizeText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/[│┃║╎╏─━═┌┐└┘╭╮╰╯├┤┬┴┼╠╣╦╩╬]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fragments(text: string): string[] {
  const words = normalizeText(text).split(" ").filter((word) => word.length >= 3);
  const out: string[] = [];
  for (let size = Math.min(5, words.length); size >= 2; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const fragment = words.slice(i, i + size).join(" ");
      if (fragment.length >= 12 && fragment.length <= 55) out.push(fragment);
    }
  }
  return out;
}

export function screenHasFragment(screen: string, text: string): boolean {
  const normalized = normalizeText(screen);
  const candidates = fragments(text);
  if (candidates.length) return candidates.some((fragment) => normalized.includes(fragment));
  const fallback = normalizeText(text);
  return fallback.length > 0 && normalized.includes(fallback);
}

/** Whether the captured screen still shows the question the client answered. */
export function screenMatchesQuestion(screen: string, pending: PendingQuestion): boolean {
  const sources = pending.kind === "plan" ? [pending.plan ?? ""] : pending.questions?.map((question) => question.question) ?? [];
  return sources.some((source) => source && screenHasFragment(screen, source));
}

function cleanOptionLabel(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/^[\s│┃║╎╏>❯›▶▸➜→*-]+/, "")
    .replace(/^[○●◉◯☐☑✓✔]\s*/, "")
    .replace(/^\d+[\).:]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOptionLine(line: string): boolean {
  return /^\s*(?:[│┃║╎╏]\s*)?(?:[>❯›▶▸➜→]\s*)?(?:[○●◉◯☐☑✓✔]\s*)?(?:\d+[\).:]|[-*])\s+/.test(line);
}

function isHighlighted(line: string): boolean {
  return /^\s*(?:[│┃║╎╏]\s*)?[>❯›▶▸➜→]/.test(line);
}

export function parseAllOptions(screen: string): OptionLine[] {
  const lines = screen.split("\n");
  const options: OptionLine[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!isOptionLine(raw)) continue;
    const label = cleanOptionLabel(raw);
    if (!label) continue;
    options.push({ index, raw, label, normalized: normalizeText(label), highlighted: isHighlighted(raw) });
  }
  return options;
}

/**
 * The menu the cursor currently sits in: the contiguous run of option lines
 * around the highlighted one. Numbered lists elsewhere on the screen (e.g. in
 * the assistant's own prose) would otherwise pollute navigation.
 */
export function parseOptions(screen: string): OptionLine[] {
  const options = parseAllOptions(screen);
  const active = options.findLast((option) => option.highlighted);
  if (!active) return options;
  const members = new Set<number>([active.index]);
  let cursor = active.index - 1;
  while (options.some((option) => option.index === cursor)) {
    members.add(cursor);
    cursor -= 1;
  }
  cursor = active.index + 1;
  while (options.some((option) => option.index === cursor)) {
    members.add(cursor);
    cursor += 1;
  }
  return options.filter((option) => members.has(option.index));
}

export function optionMatches(option: OptionLine, expected: string): boolean {
  const label = normalizeText(expected);
  return option.normalized.includes(label) || label.includes(option.normalized);
}

/** The plan-dialog option to pick for an approve/reject decision, when visible. */
export function planOption(screen: string, approve: boolean): OptionLine | null {
  const options = parseOptions(screen);
  // These match the agent's on-screen option labels, so they must cover the
  // Ukrainian plan-dialog wording too — keep the Cyrillic tokens alongside the
  // English ones (same reason the uk i18n locale stays).
  const plainAccept = /\b(yes|approve|accept|proceed)\b|затверд|схвал/i;
  const autoAccept = /\bauto[- ]?accept\b/i;
  const reject = /\b(no|reject|keep planning|continue planning|back)\b|відхил|назад/i;
  const hit = approve
    ? options.find((option) => plainAccept.test(option.label) && !autoAccept.test(option.label)) ?? options.find((option) => plainAccept.test(option.label))
    : options.find((option) => reject.test(option.label));
  return hit ?? null;
}

export function composerReady(screen: string): boolean {
  const tail = screen.split("\n").slice(-8).join("\n");
  return READY_MARKERS.test(tail) || /^\s*[❯›]/m.test(tail);
}
