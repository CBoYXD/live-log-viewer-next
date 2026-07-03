import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Engine, Fmt, RootKey } from "../types";
import { cleanTitle } from "../title";
import { globalCache } from "./caches";
import { readJson, recordValue, recordsValue, stringValue } from "./json";

interface Meta {
  project: string;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
}

const metaCache = globalCache<[number, Meta]>("meta");
// Title and codex project live in the immutable head of a growing transcript,
// so both are keyed by path and kept for good once resolved. A live file grows
// on every poll, so a size-keyed meta cache would re-read the whole file each
// tick; these caches read only the head and stop reading once the answer is
// fixed. A head that has not yet produced a title (empty/short file) is left
// open so growth can still yield one.
const titleCache = globalCache<[number, string | null]>("title");
const codexProjectCache = globalCache<string>("codex-project");

const HEAD_BYTES = 131_072;

function readHead(pathname: string, size: number): { text: string; read: number } | null {
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString("utf8", 0, read), read };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Claude project slugs encode the cwd with "/" and "." replaced by "-":
// "-home-user-Projects-my-app" → "my-app", plain home dir → its basename.
const homeSlug = "-" + os.homedir().split(path.sep).filter(Boolean).join("-");
const slugPrefixes = [homeSlug + "-Projects-", homeSlug + "-"];
const skipTitlePrefixes = ["<", "#", "Caveat:", "{", "[", "This session is being continued"];

export function projectFromSlug(slug: string): string {
  if (slug === homeSlug) return path.basename(os.homedir());
  for (const prefix of slugPrefixes) {
    if (slug.startsWith(prefix)) return slug.slice(prefix.length) || slug;
  }
  return slug;
}

function goodTitle(text: unknown): string | null {
  const val = typeof text === "string" ? text.trim() : "";
  return val && !skipTitlePrefixes.some((prefix) => val.startsWith(prefix)) ? val : null;
}

function titleFromLines(lines: string[], wantCodex: boolean): string | null {
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed;
    } catch {
      continue;
    }
    if (obj.type === "summary") {
      const title = goodTitle(obj.summary);
      if (title) return title;
    }
    // Compaction successors open with the raw continuation prompt; the
    // generated ai-title record names the conversation better.
    if (obj.type === "ai-title") {
      const title = goodTitle(obj.aiTitle);
      if (title) return title;
    }
    if (wantCodex) {
      const payload = recordValue(obj.payload) ?? {};
      if (payload.type === "user_message") {
        const title = goodTitle(payload.message);
        if (title) return title;
      }
      if (payload.type === "message" && payload.role === "user") {
        const text = recordsValue(payload.content)
          .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
          .join(" ")
          .trim();
        const title = goodTitle(text);
        if (title) return title;
      }
    } else if (obj.type === "user") {
      const content = recordValue(obj.message)?.content;
      if (typeof content === "string") {
        const title = goodTitle(content);
        if (title) return title;
      }
      const text = recordsValue(content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join(" ")
        .trim();
      const title = goodTitle(text);
      if (title) return title;
    }
  }
  return null;
}

function scanJsonlTitle(pathname: string, size: number, wantCodex: boolean): string | null {
  const cached = titleCache.get(pathname);
  if (cached && (cached[1] !== null || cached[0] >= HEAD_BYTES)) return cached[1];
  const head = readHead(pathname, size);
  if (!head) return cached?.[1] ?? null;
  const title = titleFromLines(head.text.split("\n").slice(0, 151), wantCodex);
  titleCache.set(pathname, [head.read, title]);
  return title;
}

export function describe(rootName: RootKey, root: string, pathname: string, st: fs.Stats): Meta {
  const cached = metaCache.get(pathname);
  if (cached?.[0] === st.size) return cached[1];
  const rel = path.relative(root, pathname);
  const fn = path.basename(pathname);
  let project = "інше";
  let title: string | null = null;
  let engine: Engine = "claude";
  let kind = "";
  let fmt: Fmt = "plain";
  if (rootName === "codex-jobs") {
    const slug = rel.split(path.sep)[0] ?? "";
    const parts = slug.split("-");
    const suffix = parts.at(-1) ?? "";
    project = parts.length >= 2 && suffix.length >= 12 ? parts.slice(0, -1).join("-") : slug;
    engine = "codex";
    kind = "джоба";
    const job = readJson(pathname.replace(/\.log$/, ".json"));
    if (job) {
      const bits = [stringValue(job.kindLabel) ?? "", stringValue(job.title) ?? ""].filter(Boolean);
      const head = bits.join(" · ");
      const summary = (stringValue(job.summary) ?? "").split(/\s+/).join(" ").trim();
      title = (head + (summary ? " — " + summary : "")) || fn;
    } else title = fn;
  } else if (rootName === "codex-sessions") {
    project = codexProjectCache.get(pathname) ?? "";
    if (!project) {
      const head = readHead(pathname, st.size);
      if (head) {
        try {
          const first = JSON.parse(head.text.split("\n")[0] ?? "{}");
          project = path.basename(stringValue(recordValue(first.payload)?.cwd) ?? "");
        } catch {
          project = "";
        }
      }
      if (project) codexProjectCache.set(pathname, project);
    }
    if (!project) project = "codex";
    engine = "codex";
    kind = "сесія";
    fmt = "codex";
    title = scanJsonlTitle(pathname, st.size, true) ?? "Сесія Codex";
  } else if (rootName === "claude-projects") {
    const slug = rel.split(path.sep)[0] ?? "";
    project = projectFromSlug(slug);
    fmt = "claude";
    if (fn.startsWith("agent-")) {
      kind = "субагент";
      const meta = readJson(pathname.slice(0, -".jsonl".length) + ".meta.json") ?? {};
      title =
        stringValue(meta.description) ??
        stringValue(meta.name) ??
        "Субагент " + fn.slice("agent-".length).split(".")[0];
    } else {
      kind = "сесія";
      title = scanJsonlTitle(pathname, st.size, false) ?? "Сесія Claude";
    }
  } else if (rootName === "claude-tasks") {
    const slug = rel.split(path.sep)[0] ?? "";
    project = projectFromSlug(slug);
    engine = "shell";
    kind = "фон";
    title = "Фонова задача " + fn.split(".")[0];
  }
  const meta = {
    project,
    title: cleanTitle(title ?? fn, 120),
    engine,
    kind,
    fmt,
  };
  metaCache.set(pathname, [st.size, meta]);
  return meta;
}
