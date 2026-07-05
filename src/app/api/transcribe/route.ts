import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { readCodexAuth, type CodexAuth } from "@/lib/codexAuth";
import { cacheEntryPath } from "@/lib/configDir";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readElevenLabsApiKey, resolveTranscribeBackend } from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/* ChatGPT-backend path (opt-in only). Same endpoint the Codex Desktop composer
   dictation posts to. Cloudflare fingerprints the TLS client: node/undici fetch
   gets a 403 HTML challenge while curl passes, so the upstream call shells out
   to curl. The token goes in via a stdin config file, never on the argv. */
const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const UPSTREAM_TIMEOUT_S = 90;
const LANGUAGE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/* Local faster-whisper path (default). Model and device are overridable per
   machine; CPU int8 keeps it dependency-free where there is no CUDA setup. */
const WHISPER_MODEL = process.env.LLV_WHISPER_MODEL || "small";
const WHISPER_DEVICE = process.env.LLV_WHISPER_DEVICE || "cpu";
const WHISPER_TIMEOUT_MS = 120_000;

interface TranscribeResponse {
  text: string;
}

interface UpstreamResult {
  status: number;
  body: string;
}

/* Resolved per request so a venv created after the server started is picked up,
   and the legacy cache dir is honored when only the old venv exists. */
function whisperVenv(): string {
  return process.env.LLV_WHISPER_VENV || cacheEntryPath("whisper-venv");
}

function localTranscribe(audioPath: string, language: string): Promise<TranscribeResponse> {
  const python = path.join(whisperVenv(), "bin", "python");
  const script = path.join(process.cwd(), "scripts", "whisper_transcribe.py");
  return new Promise((resolve, reject) => {
    execFile(
      python,
      [script, audioPath, WHISPER_MODEL, WHISPER_DEVICE, language],
      { maxBuffer: 4 * 1024 * 1024, timeout: WHISPER_TIMEOUT_MS },
      (error, stdout) => {
        if (error && !stdout) {
          const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? " (запусти scripts/setup-whisper.sh)" : "";
          reject(new Error(error.message + hint));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { text?: unknown; error?: unknown };
          if (typeof parsed.error === "string") {
            reject(new Error(parsed.error));
            return;
          }
          resolve({ text: typeof parsed.text === "string" ? parsed.text : "" });
        } catch {
          reject(new Error("локальний STT повернув некоректний вивід"));
        }
      },
    );
  });
}

/* ElevenLabs Scribe batch STT. The realtime scribe_v2 model is WebSocket-only;
   for the record-then-transcribe flow the batch endpoint takes the webm as-is. */
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_MODEL = process.env.LLV_ELEVENLABS_STT_MODEL || "scribe_v1";

async function elevenLabsTranscribe(apiKey: string, file: File, language: string): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append("model_id", ELEVENLABS_MODEL);
  form.append("file", file, "dictation.webm");
  if (language) form.append("language_code", language);
  const res = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_S * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { text?: unknown };
  return { text: typeof json.text === "string" ? json.text : "" };
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
  const backend = resolveTranscribeBackend();

  if (backend === "elevenlabs") {
    const apiKey = readElevenLabsApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: "нема ключа ElevenLabs (~/.config/agent-log-viewer/elevenlabs-api-key або ELEVENLABS_API_KEY)" },
        { status: 503 },
      );
    }
    try {
      return NextResponse.json(await elevenLabsTranscribe(apiKey, file, language));
    } catch (error) {
      return NextResponse.json(
        { error: `ElevenLabs STT: ${error instanceof Error ? error.message : String(error)}` },
        { status: 502 },
      );
    }
  }

  const tmpPath = path.join(os.tmpdir(), `viewer-dictation-${Date.now()}-${Math.floor(Math.random() * 1e6)}.webm`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));

    if (backend === "local") {
      const result = await localTranscribe(tmpPath, language);
      return NextResponse.json(result);
    }

    const auth = readCodexAuth();
    if (!auth) {
      return NextResponse.json(
        { error: "нема ChatGPT-токена Codex (~/.codex/auth.json) — залогінься в Codex" },
        { status: 503 },
      );
    }
    const upstream = await callTranscribe(auth, tmpPath, mime, language);
    if (upstream.status === 401) {
      return NextResponse.json({ error: "ChatGPT-токен протух — відкрий Codex, щоб він оновив токен" }, { status: 502 });
    }
    if (upstream.status !== 200) {
      return NextResponse.json({ error: `бекенд транскрипції: HTTP ${upstream.status || "0 (мережа)"}` }, { status: 502 });
    }
    const json = JSON.parse(upstream.body) as { text?: unknown };
    return NextResponse.json({ text: typeof json.text === "string" ? json.text : "" });
  } catch (error) {
    const label = backend === "local" ? "локальний STT" : "бекенд транскрипції";
    return NextResponse.json(
      { error: `${label}: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}
