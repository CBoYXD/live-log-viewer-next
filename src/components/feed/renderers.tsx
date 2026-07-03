"use client";

import { useState } from "react";
import type { ReactNode } from "react";

import type { FileEntry } from "@/lib/types";

import { hhmm } from "../utils";

type Call = { cmd: string; output: string; status: "run" | "ok" | "err"; label: string; icon: string; open: boolean };
type ReviewSeverity = "Critical" | "High" | "Medium" | "Low" | "Info" | "P0" | "P1" | "P2" | "P3";
type ReviewFinding = {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  title: string;
  body: string;
};
type ReviewCardItem = {
  kind: "review";
  ts: unknown;
  verdict?: "REQUEST_CHANGES" | "APPROVE" | "COMMENT";
  findings: ReviewFinding[];
  summary: string[];
  raw: string;
};
type CitationEntry = {
  target: string;
  line?: string;
  note?: string;
  raw: string;
};
type MemCitationItem = {
  kind: "mem-citation";
  entries: CitationEntry[];
  rolloutIds: string[];
  raw: string;
  truncated: boolean;
};
type Tmsg = {
  kind: "tmsg";
  ts: unknown;
  dir: "in" | "out";
  peer: string;
  summary: string;
  text: string;
  /** Outgoing only: delivery state recovered from the tool result. */
  delivery?: "ok" | "err";
  msgId?: string;
};
type Item =
  | { kind: "prose"; ts: unknown; text: string; engine: "codex" | "claude" }
  | { kind: "user"; ts: unknown; text: string }
  | { kind: "svc"; text: string }
  | { kind: "note"; text: string }
  | { kind: "cmd"; id: string; call: Call }
  | { kind: "edit"; files: string }
  | ReviewCardItem
  | MemCitationItem
  | Tmsg
  | { kind: "tnote"; text: string }
  | { kind: "think"; text: string }
  | { kind: "image"; media: string; data: string; w?: number; h?: number; bytes?: number }
  | { kind: "blob"; bytes: number; text: string }
  | { kind: "raw"; text: string; err: boolean };

const BLOB_MIN = 20_000;
const BLOB_KEEP = 200_000;
const RAW_DEBUG_KEEP = 24_000;
const MEM_CITATION_RE = /<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>/g;
const VERDICT_RE = /\b(REQUEST_CHANGES|APPROVE|COMMENT)\b/;
const FINDING_RE =
  /^\s*(?:[-*]\s*)?(?:(?:\[(P[0-3])\])|(Critical|High|Medium|Low|Info|P[0-3]))\s*(?:[–—:-]\s*)?(.+)$/i;
const PATH_RE =
  /((?:\.{1,2}\/|\/|~\/)?[\w@.+-][\w@.+\-/]*\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|md|json|ya?ml|toml|css|scss|html|sql|sh|env|ftl|txt))(?::(\d+))?/i;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const SECRET_VALUE_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd)\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;

/* A near-whitespace-free run this large is base64/binary:
   render it as a compact chip to keep the feed readable. */
function looksLikeBlob(text: string): boolean {
  if (text.length <= BLOB_MIN) return false;
  const ws = text.match(/\s/g)?.length ?? 0;
  return ws / text.length < 0.02;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TMSG_RE = /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g;

function tmsgAttr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
}

function textPart(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x)) : [];
}

function md(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{part.slice(1, -1)}</span>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

function debugRaw(text: string): { raw: string; truncated: boolean } {
  const redacted = text.replace(SECRET_VALUE_RE, (_whole, key: string, sep: string, quote: string) => `${key}${sep}${quote}[redacted]`);
  return { raw: redacted.slice(0, RAW_DEBUG_KEEP), truncated: redacted.length > RAW_DEBUG_KEEP };
}

function normalizeSeverity(value: string): ReviewSeverity {
  const upper = value.toUpperCase();
  if (upper === "P0" || upper === "P1" || upper === "P2" || upper === "P3") return upper;
  const lower = value.toLowerCase();
  if (lower === "critical") return "Critical";
  if (lower === "high") return "High";
  if (lower === "medium") return "Medium";
  if (lower === "low") return "Low";
  return "Info";
}

function splitTargetLine(target: string): { target: string; line?: string } {
  const match = target.match(/^(.*?):(\d+(?:-\d+)?)$/);
  if (!match) return { target };
  return { target: match[1] ?? target, line: match[2] };
}

function parseLinkedTarget(text: string): { file?: string; line?: number } {
  const markdown = text.match(MARKDOWN_LINK_RE);
  if (markdown) {
    const target = splitTargetLine((markdown[2] ?? "").replace(/^file:\/\//, ""));
    const line = target.line ? Number(target.line.split("-", 1)[0]) : undefined;
    return { file: target.target || markdown[1], line: Number.isFinite(line) ? line : undefined };
  }
  const plain = text.match(PATH_RE);
  if (!plain) return {};
  const line = plain[2] ? Number(plain[2]) : undefined;
  return { file: plain[1], line: Number.isFinite(line) ? line : undefined };
}

function plainTextTitle(text: string): string {
  return text
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(PATH_RE, "")
    .replace(/^[\s:–—-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function parseReview(text: string, ts: unknown): ReviewCardItem | null {
  const verdict = text.match(VERDICT_RE)?.[1] as ReviewCardItem["verdict"] | undefined;
  const findings: ReviewFinding[] = [];
  const summary: string[] = [];
  let current: ReviewFinding | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const match = line.match(FINDING_RE);
    if (match) {
      const severity = normalizeSeverity(match[1] || match[2] || "Info");
      const body = (match[3] ?? "").trim();
      const target = parseLinkedTarget(body);
      const title = plainTextTitle(body) || body.slice(0, 180) || "Finding";
      current = { severity, file: target.file, line: target.line, title, body: debugRaw(body).raw };
      findings.push(current);
      continue;
    }
    const trimmed = line.trim();
    if (current && /^\s{2,}\S/.test(rawLine)) {
      current.body = `${current.body}\n${debugRaw(trimmed).raw}`.trim();
      continue;
    }
    current = null;
    if (!trimmed || VERDICT_RE.test(trimmed) || /^(findings?|summary|open questions?|tests?|residual risk)\s*:?\s*$/i.test(trimmed)) {
      continue;
    }
    if (findings.length === 0 && summary.length < 3 && trimmed.length <= 240) summary.push(trimmed);
  }

  const reviewish =
    Boolean(verdict) ||
    /^findings?\s*:?$/im.test(text) ||
    findings.length >= 2 ||
    (findings.length === 1 && /\b(review|findings?|request_changes|approve|comment)\b/i.test(text));
  if (!reviewish) return null;
  return { kind: "review", ts, verdict, findings, summary, raw: debugRaw(text).raw };
}

function parseMemCitation(matchText: string, entriesText: string, idsText: string): MemCitationItem {
  const entries = entriesText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((raw): CitationEntry => {
      const note = raw.match(/\|note=\[(.*)\]$/)?.[1];
      const locator = raw.replace(/\|note=\[.*\]$/, "");
      const target = splitTargetLine(locator);
      return { target: target.target, line: target.line, note, raw };
    });
  const rolloutIds = idsText
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const raw = debugRaw(matchText);
  return { kind: "mem-citation", entries, rolloutIds, raw: raw.raw, truncated: raw.truncated };
}

function newCmd(cmd: string, icon = "❯"): Call {
  return { cmd, icon, output: "", status: "run", label: "виконується…", open: false };
}

function attach(call: Call | undefined, output: string, errFlag?: boolean) {
  if (!call) return null;
  const code = output.match(/exited with code (\d+)/)?.[1];
  const body = output
    .replace(/^Chunk ID:[^\n]*\n/, "")
    .replace(/Wall time:[^\n]*\n/, "")
    .replace(/Original token count:[^\n]*\n?/, "")
    .trim();
  const isErr = errFlag === true || (code !== undefined && code !== "0");
  call.status = isErr ? "err" : "ok";
  call.label = isErr ? "✗ " + (code && code !== "0" ? "exit " + code : "помилка") : "✓ ok";
  call.open ||= isErr;
  if (body) {
    const limit = isErr ? 60_000 : 12_000;
    call.output = (call.output + "\n" + body).trim().slice(-limit);
  }
  return call;
}

export function buildFeed(file: FileEntry, lines: string[], showSvc: boolean, lineFilter: string) {
  const calls = new Map<string, Call>();
  const tmsgs = new Map<string, Tmsg>();
  const items: Item[] = [];
  let hiddenServiceCount = 0;
  let lastProse = "";
  const pushBlobIfHuge = (text: string): boolean => {
    if (!looksLikeBlob(text)) return false;
    items.push({ kind: "blob", bytes: text.length, text: text.slice(0, BLOB_KEEP) });
    return true;
  };
  const pushImage = (block: Record<string, unknown>, fileWrap: Record<string, unknown>) => {
    const source = rec(block.source);
    const data = textPart(source.data) || textPart(fileWrap.base64);
    if (!data) return;
    const mt = textPart(source.media_type) || textPart(fileWrap.type);
    const media = mt.startsWith("image/") ? mt : "image/png";
    const dims = rec(fileWrap.dimensions);
    items.push({
      kind: "image",
      media,
      data,
      w: num(dims.originalWidth),
      h: num(dims.originalHeight),
      bytes: num(fileWrap.originalSize),
    });
  };
  const pushStructuredCodex = (ts: unknown, text: string) => {
    if (!MEM_CITATION_RE.test(text)) {
      MEM_CITATION_RE.lastIndex = 0;
      const review = parseReview(text.trim(), ts);
      if (!review) return false;
      items.push(review);
      return true;
    }
    MEM_CITATION_RE.lastIndex = 0;
    let handled = false;
    let last = 0;
    const pushTextPart = (part: string) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const review = parseReview(trimmed, ts);
      if (review) {
        items.push(review);
        handled = true;
      } else {
        items.push({ kind: "prose", ts, text: trimmed, engine: "codex" });
      }
    };

    MEM_CITATION_RE.lastIndex = 0;
    for (const match of text.matchAll(MEM_CITATION_RE)) {
      const whole = match[0];
      const index = match.index ?? 0;
      pushTextPart(text.slice(last, index));
      items.push(parseMemCitation(whole, match[1] ?? "", match[2] ?? ""));
      handled = true;
      last = index + whole.length;
    }
    pushTextPart(text.slice(last));
    return handled;
  };
  const addProse = (ts: unknown, text: string) => {
    if (!text.trim() || text === lastProse) return;
    lastProse = text;
    if (pushBlobIfHuge(text)) return;
    if (file.engine === "codex" && pushStructuredCodex(ts, text)) return;
    items.push({ kind: "prose", ts, text, engine: file.engine === "codex" ? "codex" : "claude" });
  };
  const addCmd = (ts: unknown, cmd: string, callId?: string, icon?: string) => {
    const id = callId || "plain-" + items.length + "-" + String(ts ?? "");
    const call = newCmd(cmd, icon);
    calls.set(id, call);
    items.push({ kind: "cmd", id, call });
    return call;
  };
  const addOutput = (callId: string | undefined, output: string, err?: boolean) => {
    if (!callId) return;
    const tmsg = tmsgs.get(callId);
    if (tmsg) {
      /* The routing echo repeats the whole message body; keep only the delivery state. */
      tmsg.delivery = err || /"success"\s*:\s*false/.test(output) ? "err" : "ok";
      tmsg.msgId = output.match(/"msg_id"\s*:\s*"([^"]+)"/)?.[1];
      return;
    }
    const call = attach(calls.get(callId), output, err);
    if (!call && output && showSvc) items.push({ kind: "svc", text: "output: " + output.slice(0, 200) });
  };
  const addSvc = (text: string) => {
    if (showSvc) items.push({ kind: "svc", text: text.slice(0, 300) });
    else hiddenServiceCount += 1;
  };
  const addNote = (text: string) => {
    items.push({ kind: "note", text });
  };
  /* Inbound teammate traffic arrives as user text wrapped in <teammate-message>;
     idle_notification JSON bodies collapse to a thin service-style row. */
  const addUserText = (ts: unknown, text: string) => {
    const rest = text.replace(TMSG_RE, (_whole, attrs: string, body: string) => {
      const peer = tmsgAttr(attrs, "teammate_id") || "тімейт";
      const summary = tmsgAttr(attrs, "summary");
      const trimmed = body.trim();
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === "idle_notification") {
            const at = hhmm(obj.timestamp);
            items.push({ kind: "tnote", text: `${peer}: звільнився${at ? " · " + at : ""}` });
            return "";
          }
        } catch {
          /* render as a regular teammate card */
        }
      }
      items.push({ kind: "tmsg", ts, dir: "in", peer, summary, text: trimmed });
      return "";
    });
    const leftover = rest.replace(/Another Claude session sent a message:\s*/g, "").trim();
    if (leftover && !pushBlobIfHuge(leftover)) items.push({ kind: "user", ts, text: leftover });
  };
  const renderCodex = (obj: Record<string, unknown>) => {
    const p = rec(obj.payload);
    const ts = obj.timestamp;
    if (obj.type === "session_meta") {
      return addNote(`Сесія Codex створена · ${textPart(p.model)} · ${textPart(p.cwd)}`);
    }
    if (obj.type === "event_msg") {
      if (p.type === "agent_message" && p.message) return addProse(ts, textPart(p.message));
      if (p.type === "user_message" && p.message) return items.push({ kind: "user", ts, text: textPart(p.message) });
      if (p.type === "task_started") return addNote("Задача стартувала" + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "task_complete") return addNote("Задачу завершено" + (ts ? " · " + hhmm(ts) : ""));
      return addSvc(textPart(p.type) || "event");
    }
    if (obj.type === "response_item") {
      if (p.type === "message") {
        const text = arr(p.content).map((c) => textPart(c.text) || textPart(c.input_text)).join(" ").trim();
        if (!text) return addSvc("message " + textPart(p.role));
        return p.role === "user" ? items.push({ kind: "user", ts, text }) : addProse(ts, text);
      }
      if (p.type === "function_call") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(textPart(p.arguments) || "{}");
        } catch {
          args = {};
        }
        const name = textPart(p.name);
        if (name === "exec_command" || name === "shell") {
          const cmd = String(args.cmd ?? args.command ?? "").replace(/^\/usr\/bin\/zsh -lc /, "");
          return addCmd(ts, cmd, textPart(p.call_id));
        }
        if (name === "apply_patch") {
          const files = String(args.input ?? "").match(/(Add|Update|Delete) File: [^\n]+/g);
          items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : "патч" });
          return;
        }
        if (name === "write_stdin") return addSvc("stdin → сесія " + String(args.session_id ?? ""));
        return addCmd(ts, name + " " + JSON.stringify(args).slice(0, 120), textPart(p.call_id), "🔧");
      }
      if (p.type === "function_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      if (p.type === "reasoning") return addSvc("reasoning");
      return addSvc(textPart(p.type) || "item");
    }
    addSvc(textPart(obj.type) || "запис");
  };
  const renderClaude = (obj: Record<string, unknown>) => {
    const ts = obj.timestamp;
    if (obj.type === "user" && obj.message) {
      const content = rec(obj.message).content;
      const fileWrap = rec(rec(obj.toolUseResult).file);
      if (typeof content === "string") addUserText(ts, content);
      else {
        for (const part of arr(content)) {
          if (part.type === "text") addUserText(ts, textPart(part.text));
          else if (part.type === "image") pushImage(part, fileWrap);
          else if (part.type === "tool_result") {
            const inner = arr(part.content);
            for (const block of inner) {
              if (block.type === "image") pushImage(block, fileWrap);
            }
            const contentText =
              typeof part.content === "string"
                ? part.content
                : inner.filter((x) => x.type !== "image").map((x) => textPart(x.text)).join(" ");
            addOutput(textPart(part.tool_use_id), contentText, part.is_error === true);
          }
        }
      }
      return;
    }
    if (obj.type === "assistant" && obj.message) {
      for (const part of arr(rec(obj.message).content)) {
        if (part.type === "text" && textPart(part.text).trim()) addProse(ts, textPart(part.text));
        else if (part.type === "thinking" && textPart(part.thinking).trim()) {
          items.push({ kind: "think", text: textPart(part.thinking).replace(/\s+/g, " ").trim() });
        } else if (part.type === "tool_use" && textPart(part.name) === "SendMessage") {
          const input = rec(part.input);
          const message = input.message;
          if (typeof message === "string") {
            const item: Tmsg = {
              kind: "tmsg",
              ts,
              dir: "out",
              peer: String(input.to ?? ""),
              summary: String(input.summary ?? ""),
              text: message,
            };
            items.push(item);
            if (textPart(part.id)) tmsgs.set(textPart(part.id), item);
          } else {
            addSvc(`SendMessage → ${String(input.to ?? "")} · ${textPart(rec(message).type) || "протокол"}`);
          }
        } else if (part.type === "tool_use") {
          const input = rec(part.input);
          const cmd = String(input.command ?? input.file_path ?? input.prompt ?? JSON.stringify(input));
          addCmd(ts, textPart(part.name) + ": " + cmd.slice(0, 160), textPart(part.id), "🔧");
        }
      }
      return;
    }
    addSvc(textPart(obj.type) || "запис");
  };
  const renderPlain = (rawLine: string) => {
    // Shell .output files carry terminal ANSI/OSC escapes; strip them for display.
    const line = rawLine.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (/Assistant message$/.test(line)) return;
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const ts = m?.[1] ?? null;
    const rest = m?.[2] ?? line;
    if (!rest || /^Assistant message captured/.test(rest)) return;
    if (/^Running command: /.test(rest)) return addCmd(ts, rest.replace(/^Running command: /, "").replace(/^\/usr\/bin\/zsh -lc /, ""));
    if (/^Command (completed|failed)/.test(rest)) {
      const last = [...calls.values()].at(-1);
      if (last) {
        attach(last, /^Command failed/.test(rest) ? rest + "\n(це джоб-лог: він не містить stdout команд; повний вивід — у rollout-сесії Codex у списку зліва)" : rest, /^Command failed/.test(rest));
      }
      return;
    }
    if (/^Applying \d+ file/.test(rest)) return items.push({ kind: "edit", files: rest });
    if (m && !/^(Running|Command|Applying)/.test(rest)) return addProse(ts, rest);
    if (pushBlobIfHuge(line)) return;
    items.push({ kind: "raw", text: line, err: /error|failed|traceback|exception/i.test(line) });
  };
  for (const line of lines) {
    if (lineFilter && !line.toLowerCase().includes(lineFilter)) continue;
    if (file.fmt === "claude" || file.fmt === "codex") {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          if (file.fmt === "claude") renderClaude(obj);
          else renderCodex(obj);
        }
      } catch {
        renderPlain(line);
      }
    } else renderPlain(line);
  }
  return { items, hiddenServiceCount };
}

type ImageView = "chip" | "thumb" | "full";

export function ImageCard({ media, data, w, h, bytes }: { media: string; data: string; w?: number; h?: number; bytes?: number }) {
  const [view, setView] = useState<ImageView>("chip");
  const kb = Math.round((bytes ?? (data.length * 3) / 4) / 1024);
  const dims = w && h ? `${w}×${h}` : "зображення";
  if (view === "chip") {
    return (
      <button
        type="button"
        onClick={() => setView("thumb")}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-chip">🖼</span>
        <span className="font-semibold">{dims}</span>
        <span className="text-dim">· {kb} КБ</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">показати</span>
      </button>
    );
  }
  const full = view === "full";
  return (
    <div className="my-2 ml-9">
      {/* Lazy insert: the data URI only enters the DOM once expanded. next/image cannot serve a base64 data URI here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`data:${media};base64,${data}`}
        alt={`зображення ${dims}`}
        onClick={() => setView(full ? "chip" : "full")}
        className={`cursor-pointer rounded-[14px] border border-line ${full ? "max-w-full" : "max-h-[240px]"}`}
      />
      <button type="button" onClick={() => setView("chip")} className="mt-1 block text-[12px] text-dim">
        згорнути
      </button>
    </div>
  );
}

export function BlobCard({ bytes, text }: { bytes: number; text: string }) {
  const [open, setOpen] = useState(false);
  const kb = Math.round(bytes / 1024);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-chip">🧱</span>
        <span className="font-semibold">даних {kb} КБ</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">показати</span>
      </button>
    );
  }
  return (
    <div className="my-2 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
      <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-all bg-[#fafafc] px-3.5 py-2.5 font-mono text-[11.5px]">
        {text}
      </pre>
      <button type="button" onClick={() => setOpen(false)} className="block w-full border-t border-line px-3.5 py-1.5 text-[12px] text-dim">
        згорнути
      </button>
    </div>
  );
}

function severityClass(severity: ReviewSeverity): string {
  if (severity === "Critical" || severity === "High" || severity === "P0" || severity === "P1") return "border-err/30 bg-[#fff4f4] text-err";
  if (severity === "Medium" || severity === "P2") return "border-[#d89b21]/35 bg-[#fff9ea] text-[#9a6500]";
  if (severity === "Low" || severity === "P3") return "border-line bg-chip text-[#555]";
  return "border-line bg-panel text-dim";
}

function verdictClass(verdict: ReviewCardItem["verdict"]): string {
  if (verdict === "REQUEST_CHANGES") return "bg-[#fff0f0] text-err border-err/25";
  if (verdict === "APPROVE") return "bg-[#eefaf1] text-ok border-ok/25";
  return "bg-chip text-[#555] border-line";
}

function ReviewCard({ item }: { item: ReviewCardItem }) {
  const findingCount = item.findings.length;
  const visibleFindings = item.findings.slice(0, 12);
  return (
    <div className="my-3.5 ml-9 overflow-hidden rounded-[14px] border border-codex/20 bg-panel shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-codex-soft text-[13px] font-extrabold text-codex">⌘</span>
        <span className="text-[13.5px] font-bold">Codex review</span>
        {item.verdict ? (
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-bold ${verdictClass(item.verdict)}`}>{item.verdict}</span>
        ) : null}
        <span className="text-[11px] text-dim">
          {findingCount ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : "без findings"}
        </span>
        {hhmm(item.ts) ? <span className="ml-auto text-[11px] text-dim">{hhmm(item.ts)}</span> : null}
      </div>
      <div className="px-3.5 py-2.5">
        {item.summary.length ? (
          <div className="mb-2 space-y-1 text-[13px] text-[#444]">
            {item.summary.map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-words">
                {md(line)}
              </div>
            ))}
          </div>
        ) : null}
        {visibleFindings.length ? (
          <div className="space-y-2">
            {visibleFindings.map((finding, idx) => (
              <div key={idx} className="rounded-[10px] border border-line bg-[#fbfbfd] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold ${severityClass(finding.severity)}`}>
                    {finding.severity}
                  </span>
                  {finding.file ? (
                    <code className="min-w-0 max-w-full truncate rounded-md bg-chip px-1.5 py-0.5 font-mono text-[11.5px]" title={finding.file}>
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </code>
                  ) : null}
                </div>
                <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px]">{md(finding.title)}</div>
                {finding.body && finding.body !== finding.title ? (
                  <details className="mt-1 text-[12px] text-dim">
                    <summary className="cursor-pointer list-none font-semibold text-accent">details</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words">{md(finding.body)}</div>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {item.findings.length > visibleFindings.length ? (
          <div className="mt-2 text-[12px] text-dim">ще {item.findings.length - visibleFindings.length} findings у raw</div>
        ) : null}
        <details className="mt-2 rounded-[10px] border border-line bg-[#fafafc] text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-dim">raw review text</summary>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11.5px] text-[#555]">
            {item.raw}
          </pre>
        </details>
      </div>
    </div>
  );
}

function MemCitationCard({ item }: { item: MemCitationItem }) {
  const visibleEntries = item.entries.slice(0, 8);
  const visibleIds = item.rolloutIds.slice(0, 5);
  return (
    <div className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip text-[13px]">↩</span>
        <span className="text-[13px] font-bold">Memory citations</span>
        <span className="text-[11px] text-dim">
          {item.entries.length} entries · {item.rolloutIds.length} rollout IDs
        </span>
      </div>
      <div className="px-3.5 py-2.5">
        {visibleEntries.length ? (
          <div className="space-y-1.5">
            {visibleEntries.map((entry, idx) => (
              <div key={idx} className="min-w-0 rounded-[9px] bg-[#fbfbfd] px-2.5 py-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="min-w-0 max-w-full truncate rounded-md bg-chip px-1.5 py-0.5 font-mono text-[11.5px]" title={entry.target}>
                    {entry.target}
                    {entry.line ? `:${entry.line}` : ""}
                  </code>
                </div>
                {entry.note ? <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-[#555]">{entry.note}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-dim">без citation entries</div>
        )}
        {item.entries.length > visibleEntries.length ? (
          <div className="mt-1.5 text-[12px] text-dim">ще {item.entries.length - visibleEntries.length} entries у raw</div>
        ) : null}
        {visibleIds.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {visibleIds.map((id) => (
              <code key={id} className="rounded-full bg-chip px-2 py-0.5 font-mono text-[10.5px] text-[#555]">
                {id.slice(0, 8)}
              </code>
            ))}
            {item.rolloutIds.length > visibleIds.length ? <span className="text-[11px] text-dim">+{item.rolloutIds.length - visibleIds.length}</span> : null}
          </div>
        ) : null}
        <details className="mt-2 rounded-[10px] border border-line bg-[#fafafc] text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-dim">
            raw citation block{item.truncated ? " · обрізано" : ""}
          </summary>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11.5px] text-[#555]">
            {item.raw}
          </pre>
        </details>
      </div>
    </div>
  );
}

export function FeedItem({ item }: { item: Item }) {
  if (item.kind === "image") return <ImageCard media={item.media} data={item.data} w={item.w} h={item.h} bytes={item.bytes} />;
  if (item.kind === "blob") return <BlobCard bytes={item.bytes} text={item.text} />;
  if (item.kind === "review") return <ReviewCard item={item} />;
  if (item.kind === "mem-citation") return <MemCitationCard item={item} />;
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : "bg-claude";
    const icon = item.engine === "codex" ? "⌘" : "✳";
    return (
      <div className="my-3.5 flex gap-2.5">
        <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${cls}`}>{icon}</div>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {hhmm(item.ts) ? <div className="mb-0.5 text-[11px] text-dim">{hhmm(item.ts)}</div> : null}
          {md(item.text)}
        </div>
      </div>
    );
  }
  if (item.kind === "user") {
    const long = item.text.length > 500;
    return (
      <div className="my-3.5 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl bg-user px-4 py-2.5">
          {long ? <details><summary>{item.text.slice(0, 180)}… ({item.text.length} симв.)</summary>{item.text}</details> : item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "cmd") {
    const statusCls = item.call.status === "ok" ? "text-ok" : item.call.status === "err" ? "text-err" : "text-dim";
    return (
      <details className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card" open={item.call.open}>
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip text-[13px]">{item.call.icon}</span>
          <code className="max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-chip px-2 py-0.5 font-mono text-[12.5px]">{item.call.cmd}</code>
          <span className={`ml-auto shrink-0 text-xs font-semibold ${statusCls}`}>{item.call.label}</span>
        </summary>
        <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap border-t border-line bg-[#fafafc] px-3.5 py-2.5 font-mono text-[12.5px]">
          {"$ " + item.call.cmd + (item.call.output ? "\n" + item.call.output : "\n(вивід у цьому лог-файлі відсутній — повний є в rollout-сесії Codex)")}
        </pre>
      </details>
    );
  }
  if (item.kind === "edit") {
    return (
      <div className="my-2.5 ml-9 flex items-center gap-3 rounded-[14px] border border-line bg-panel px-3.5 py-2.5 shadow-card">
        <span className="flex h-7.5 w-7.5 items-center justify-center rounded-lg bg-chip">📝</span>
        <div>
          <div className="text-[13.5px] font-semibold">{item.files}</div>
          <div className="text-xs text-dim">файли змінені</div>
        </div>
      </div>
    );
  }
  if (item.kind === "tmsg") {
    const long = item.text.length > 420 || item.text.split("\n").length > 6;
    return (
      <div className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-accent/25 bg-[#f8f8fd] shadow-card">
        <div className="flex items-center gap-2 px-3.5 pt-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-[#ecebfb] text-[13px]">✉</span>
          <span className="text-[11px] font-semibold text-dim">{item.dir === "out" ? "до" : "від"}</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{item.peer}</span>
          {item.delivery ? (
            <span
              className={`shrink-0 text-[10.5px] font-semibold ${item.delivery === "ok" ? "text-ok" : "text-err"}`}
              title={item.msgId ? `msg_id: ${item.msgId}` : undefined}
            >
              {item.delivery === "ok" ? "✓ доставлено" : "✗ не доставлено"}
            </span>
          ) : null}
          {hhmm(item.ts) ? <span className="ml-auto shrink-0 text-[11px] text-dim">{hhmm(item.ts)}</span> : null}
        </div>
        <div className="px-3.5 pb-2.5 pt-1">
          {item.summary ? <div className="text-[13px] font-bold">{item.summary}</div> : null}
          {long ? (
            <details className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">
              <summary className="cursor-pointer list-none text-[12.5px] text-[#555]">
                {item.text.slice(0, 260).trimEnd()}… <span className="font-semibold text-accent">показати все</span>
              </summary>
              {item.text}
            </details>
          ) : (
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{item.text}</div>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "tnote") {
    return (
      <div className="my-1 ml-9 flex items-center gap-1.5 text-[11.5px] text-dim">
        <span aria-hidden>✉</span>
        {item.text}
      </div>
    );
  }
  if (item.kind === "think") {
    const long = item.text.length > 150;
    return (
      <details className="my-1 ml-9 text-[11.5px] italic text-dim">
        <summary className={`list-none truncate ${long ? "cursor-pointer" : ""}`} title="міркування агента">
          🤔 {item.text.slice(0, 150)}
          {long ? "…" : ""}
        </summary>
        {long ? <div className="whitespace-pre-wrap break-words pt-1 not-italic">{item.text}</div> : null}
      </details>
    );
  }
  if (item.kind === "svc") return <div className="my-1 break-words text-[11.5px] text-dim">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 break-words text-[12.5px] text-dim">{item.text}</div>;
  return <div className={`my-0.5 break-words text-[12.5px] ${item.err ? "text-err" : "text-[#555]"}`}>{item.text}</div>;
}
