import { NextRequest, NextResponse } from "next/server";

import { knownLivePids, resolveTarget, saveInboxImage, sendText } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetResponse {
  target: string | null;
}

interface SendResponse {
  ok: true;
  target: string;
  imagePath?: string;
}

interface ImagePayload {
  base64?: unknown;
  mime?: unknown;
}

/** Resolves and revalidates a request pid against the scanner's live set. */
async function targetForKnownPid(pid: number): Promise<string | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

export async function GET(req: NextRequest): Promise<NextResponse<TargetResponse | ApiError>> {
  const pid = Number(req.nextUrl.searchParams.get("pid"));
  if (!Number.isInteger(pid) || pid <= 0) {
    return NextResponse.json({ error: "некоректний pid" }, { status: 400 });
  }
  const target = await targetForKnownPid(pid);
  if (target === "unknown") return NextResponse.json({ target: null });
  return NextResponse.json({ target });
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  let body: { pid?: unknown; text?: unknown; image?: unknown };
  try {
    body = (await req.json()) as { pid?: unknown; text?: unknown; image?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const pid = Number(body.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return NextResponse.json({ error: "некоректний pid" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const image = body.image && typeof body.image === "object" ? (body.image as ImagePayload) : null;
  const imageBase64 = image && typeof image.base64 === "string" ? image.base64 : "";
  const imageMime = image && typeof image.mime === "string" ? image.mime : "";
  if (!text.trim() && !imageBase64) {
    return NextResponse.json({ error: "порожнє повідомлення" }, { status: 400 });
  }

  const target = await targetForKnownPid(pid);
  if (target === "unknown") {
    return NextResponse.json({ error: "процес невідомий переглядачу" }, { status: 403 });
  }
  if (target === null) {
    return NextResponse.json({ error: "процес не у tmux-сесії" }, { status: 409 });
  }

  try {
    let imagePath: string | undefined;
    if (imageBase64) {
      imagePath = saveInboxImage(imageBase64, imageMime).path;
    }
    const payload = [text.trim(), imagePath].filter(Boolean).join(text.trim() && imagePath ? "\n" : "");
    await sendText(target, payload);
    return NextResponse.json({ ok: true, target, ...(imagePath ? { imagePath } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
