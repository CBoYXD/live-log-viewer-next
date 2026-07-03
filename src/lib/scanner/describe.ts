import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Engine, Fmt, RootKey } from "../types";
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

// Claude project slugs encode the cwd with "/" and "." replaced by "-":
// "-home-user-Projects-my-app" → "my-app", plain home dir → its basename.
const homeSlug = "-" + os.homedir().split(path.sep).filter(Boolean).join("-");
const slugPrefixes = [homeSlug + "-Projects-", homeSlug + "-"];
const skipTitlePrefixes = ["<", "#", "Caveat:", "{", "["];

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

function scanJsonlTitle(pathname: string, wantCodex: boolean): string | null {
  let data: string;
  try {
    data = fs.readFileSync(pathname, "utf8");
  } catch {
    return null;
  }
  const lines = data.split("\n").slice(0, 151);
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
    try {
      const first = JSON.parse(fs.readFileSync(pathname, "utf8").split("\n")[0] ?? "{}");
      const cwd = stringValue(recordValue(first.payload)?.cwd) ?? "";
      project = path.basename(cwd) || "codex";
    } catch {
      project = "codex";
    }
    engine = "codex";
    kind = "сесія";
    fmt = "codex";
    title = scanJsonlTitle(pathname, true) ?? "Сесія Codex";
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
      title = scanJsonlTitle(pathname, false) ?? "Сесія Claude";
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
    title: (title ?? fn).split(/\s+/).join(" ").slice(0, 120),
    engine,
    kind,
    fmt,
  };
  metaCache.set(pathname, [st.size, meta]);
  return meta;
}
