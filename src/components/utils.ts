import type { FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

export { cleanTitle, shortTitle } from "@/lib/title";

export function escText(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export function fmtAge(mtime: number): string {
  const s = Date.now() / 1000 - mtime;
  if (s < 90) return Math.round(s) + " с тому";
  if (s < 5400) return Math.round(s / 60) + " хв тому";
  if (s < 129600) return Math.round(s / 3600) + " год тому";
  return Math.round(s / 86400) + " д тому";
}

export function hhmm(ts: unknown): string {
  if (typeof ts !== "string" && typeof ts !== "number") return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("uk", { hour12: false });
}

export function typeInfo(file: FileEntry) {
  if (file.engine === "shell") return { glyph: "❯", cls: "bg-[#f1f1f4] border border-line text-[#777]", aux: true, tip: "фонова команда" };
  if (file.root === "codex-jobs") return { glyph: "⚙", cls: "bg-white border border-dashed border-[#9fd4c8] text-codex", aux: true, tip: "джоба Codex" };
  if (file.engine === "codex") return { glyph: "⌘", cls: "bg-codex-soft text-codex", aux: false, tip: "сесія Codex" };
  if (file.kind === "субагент") return { glyph: "⤷", cls: "bg-white border border-[#f3d9cd] text-claude", aux: false, tip: "субагент Claude" };
  return { glyph: "✳", cls: "bg-claude-soft text-claude", aux: false, tip: "сесія Claude" };
}

/** Ukrainian plural form: ukPlural(n, "гілка", "гілки", "гілок"). */
export function ukPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Same activity encoding everywhere: green pulse, amber, red, gray. */
export function activityDot(activity: FileEntry["activity"]): string {
  if (activity === "live") return "animate-pulse bg-ok";
  if (activity === "recent") return "bg-[#d29a2f]";
  if (activity === "stalled") return "bg-err";
  return "bg-[#c9c9d1]";
}

/** Engine identity color as a raw value for SVG connectors. */
export function engineColor(file: FileEntry): string {
  if (file.engine === "codex") return "#0d8a72";
  if (file.engine === "claude") return "#d97757";
  return "#9a9aa4";
}

/** Engine identity color for column top borders. */
export function engineEdge(file: FileEntry): string {
  if (file.engine === "codex") return "border-t-codex";
  if (file.engine === "claude") return "border-t-claude";
  return "border-t-[#9a9aa4]";
}

export function engineBadge(file: FileEntry) {
  const label = { codex: "Codex", claude: "Claude", shell: "Bash" }[file.engine] ?? file.engine;
  const cls =
    file.engine === "codex"
      ? "bg-codex-soft text-codex"
      : file.engine === "claude"
        ? "bg-claude-soft text-claude"
        : "bg-[#ececf1] text-[#555]";
  return { label, cls };
}

export function syntheticFile(pathname: string): FileEntry {
  const root = pathname.includes("/.codex/sessions/")
    ? "codex-sessions"
    : pathname.includes("/.claude/projects/")
      ? "claude-projects"
      : /\/tmp\/claude-\d+\//.test(pathname)
        ? "claude-tasks"
        : "codex-jobs";
  const fmt = pathname.endsWith(".jsonl") ? (root === "claude-projects" ? "claude" : "codex") : "plain";
  const engine = root.startsWith("codex") ? "codex" : root === "claude-tasks" ? "shell" : "claude";
  return {
    path: pathname,
    root,
    fmt,
    engine,
    kind: "",
    title: cleanTitle(pathname.split("/").pop() || pathname, 120),
    project: "",
    mtime: Date.now() / 1000,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    parent: null,
    name: pathname,
  };
}
