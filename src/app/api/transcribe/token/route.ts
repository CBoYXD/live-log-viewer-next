import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readElevenLabsApiKey, resolveTranscribeBackend } from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Single-use token for the browser's realtime Scribe WebSocket. The client
   asks for one on every dictation start; a non-200 answer just means "no live
   mode here" and the client falls back to record-then-transcribe, so this
   route never needs to be soft about failures. */
const TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

export async function POST(req: NextRequest): Promise<NextResponse<{ token: string } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  if (resolveTranscribeBackend() !== "elevenlabs") {
    return NextResponse.json({ error: "live transcription is only available with the elevenlabs backend" }, { status: 409 });
  }
  const apiKey = readElevenLabsApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "missing ElevenLabs key (~/.config/agent-log-viewer/elevenlabs-api-key or ELEVENLABS_API_KEY)" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `ElevenLabs token: HTTP ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as { token?: unknown };
    if (typeof json.token !== "string" || !json.token) {
      return NextResponse.json({ error: "ElevenLabs token: response had no token" }, { status: 502 });
    }
    return NextResponse.json({ token: json.token });
  } catch (error) {
    return NextResponse.json(
      { error: `ElevenLabs token: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}
