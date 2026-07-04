import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import {
  collectImagePayloads,
  freshSpecFor,
  imagePayloadError,
  saveInboxImage,
  spawnAgentWithPrompt,
  type AgentEngine,
} from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;
const HEAD_BYTES = 8192;

interface SuggestResponse {
  dirs: string[];
}

interface SpawnResponse {
  ok: true;
  target: string;
}

/** Working directory from the head of a transcript, without reading the whole file. */
function headCwd(pathname: string): string | null {
  let head: string;
  try {
    const fd = fs.openSync(pathname, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  }
  for (const line of head.split("\n").slice(0, 20)) {
    try {
      const obj = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof obj.cwd === "string" ? obj.cwd : typeof obj.payload?.cwd === "string" ? obj.payload.cwd : null;
      if (cwd && fs.existsSync(cwd)) return cwd;
    } catch {
      /* partial or non-JSON head row */
    }
  }
  return null;
}

/** Recent real working directories to prefill the spawn dialog; the current
    project's transcripts rank first so its directory lands on top. */
export async function GET(req: NextRequest): Promise<NextResponse<SuggestResponse>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  const conversations = (await listFiles())
    .filter((entry) => entry.path.endsWith(".jsonl") && (entry.root === "claude-projects" || entry.root === "codex-sessions"))
    .filter((entry) => !entry.path.includes(path.sep + "subagents" + path.sep))
    .sort((a, b) => Number(b.project === project) - Number(a.project === project) || b.mtime - a.mtime)
    .slice(0, SUGGEST_SCAN_LIMIT);

  const dirs: string[] = [];
  for (const entry of conversations) {
    if (dirs.length >= SUGGEST_MAX) break;
    const cwd = headCwd(entry.path);
    if (cwd && !dirs.includes(cwd)) dirs.push(cwd);
  }
  if (!dirs.length) dirs.push(os.homedir());
  return NextResponse.json({ dirs });
}

export async function POST(req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown };
  try {
    body = (await req.json()) as { engine?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine має бути claude або codex" }, { status: 400 });

  const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!rawCwd) return NextResponse.json({ error: "потрібна робоча директорія" }, { status: 400 });
  const cwd = path.resolve(rawCwd === "~" || rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(1)) : rawCwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: `директорії не існує: ${cwd}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `не директорія: ${cwd}` }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const images = collectImagePayloads(body);
  const imageError = imagePayloadError(images);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }

  try {
    /* Pasted images land in the inbox and reach the fresh agent as file paths
       appended to its first prompt — the same contract the pane composer uses. */
    const imagePaths = images.map((image) => saveInboxImage(image.base64, image.mime).path);
    const payload = [prompt, ...imagePaths].filter(Boolean).join("\n");
    const pane = await spawnAgentWithPrompt(freshSpecFor(engine, cwd), payload);
    return NextResponse.json({ ok: true, target: pane.display });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
