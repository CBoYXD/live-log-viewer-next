import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { readCodexAuth, type CodexAuth } from "@/lib/codexAuth";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/* Same backend the Codex Desktop composer dictation posts to. Cloudflare
   fingerprints the TLS client: node/undici fetch gets a 403 HTML challenge
   while curl passes, so the upstream call shells out to curl. The token goes
   in via a stdin config file, never on the argv. */
const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const UPSTREAM_TIMEOUT_S = 90;
const LANGUAGE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

interface TranscribeResponse {
  text: string;
}

interface UpstreamResult {
  status: number;
  body: string;
}

function callTranscribe(auth: CodexAuth, audioPath: string, mime: string, language: string): Promise<UpstreamResult> {
  const config = [
    `url = "${TRANSCRIBE_URL}"`,
    `request = "POST"`,
    "silent",
    `max-time = ${UPSTREAM_TIMEOUT_S}`,
    `header = "Authorization: Bearer ${auth.accessToken}"`,
    `header = "chatgpt-account-id: ${auth.accountId}"`,
    `header = "originator: codex_cli_rs"`,
    `header = "User-Agent: codex_cli_rs (live-log-viewer)"`,
    `form = "file=@${audioPath};type=${mime}"`,
    ...(language ? [`form = "language=${language}"`] : []),
    `write-out = "\\n%{http_code}"`,
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = execFile(
      "curl",
      ["--config", "-"],
      { maxBuffer: 4 * 1024 * 1024, timeout: (UPSTREAM_TIMEOUT_S + 5) * 1000 },
      (error, stdout) => {
        if (error && !stdout) {
          reject(new Error(error.message));
          return;
        }
        const cut = stdout.lastIndexOf("\n");
        const status = Number(stdout.slice(cut + 1).trim());
        resolve({ status: Number.isInteger(status) ? status : 0, body: stdout.slice(0, cut) });
      },
    );
    child.stdin?.end(config);
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<TranscribeResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "очікується multipart/form-data з полем file" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "нема аудіофайла в полі file" }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "аудіо завелике (ліміт 16 МБ)" }, { status: 413 });
  }
  const mime = file.type && file.type.startsWith("audio/") ? file.type.split(";")[0] : "audio/webm";
  if (file.type && !file.type.startsWith("audio/")) {
    return NextResponse.json({ error: "очікується аудіо" }, { status: 415 });
  }
  const rawLanguage = form.get("language");
  const language = typeof rawLanguage === "string" && LANGUAGE_RE.test(rawLanguage) ? rawLanguage : "";

  const auth = readCodexAuth();
  if (!auth) {
    return NextResponse.json(
      { error: "нема ChatGPT-токена Codex (~/.codex/auth.json) — залогінься в Codex" },
      { status: 503 },
    );
  }

  const tmpPath = path.join(os.tmpdir(), `viewer-dictation-${Date.now()}-${Math.floor(Math.random() * 1e6)}.webm`);
  let upstream: UpstreamResult;
  try {
    fs.writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));
    upstream = await callTranscribe(auth, tmpPath, mime, language);
  } catch (error) {
    return NextResponse.json(
      { error: `бекенд транскрипції не відповів (${error instanceof Error ? error.message : String(error)})` },
      { status: 502 },
    );
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  if (upstream.status === 401) {
    return NextResponse.json({ error: "ChatGPT-токен протух — відкрий Codex, щоб він оновив токен" }, { status: 502 });
  }
  if (upstream.status !== 200) {
    return NextResponse.json({ error: `бекенд транскрипції: HTTP ${upstream.status || "0 (мережа)"}` }, { status: 502 });
  }

  let text: string;
  try {
    const json = JSON.parse(upstream.body) as { text?: unknown };
    text = typeof json.text === "string" ? json.text : "";
  } catch {
    return NextResponse.json({ error: "бекенд повернув не-JSON відповідь" }, { status: 502 });
  }
  return NextResponse.json({ text });
}
