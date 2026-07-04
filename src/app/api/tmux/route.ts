import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import {
  inboxImageExt,
  MAX_INBOX_IMAGE_BYTES,
  knownLivePids,
  liveResumePane,
  resolveTarget,
  resumeSpecFor,
  saveInboxImage,
  sendText,
  sendToResumedAgent,
} from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetResponse {
  target: string | null;
}

interface SendResponse {
  ok: true;
  target: string;
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
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
  const pidRaw = req.nextUrl.searchParams.get("pid");
  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const pid = Number(pidRaw);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }
  if (hasPid) {
    const target = await targetForKnownPid(pid);
    if (target !== "unknown" && target !== null) return NextResponse.json({ target });
  }
  /* A finished conversation has no pid, but its resume window may still run. */
  if (filePath && pathAllowed(filePath)) {
    const pane = await liveResumePane(filePath);
    if (pane) return NextResponse.json({ target: pane.display });
  }
  return NextResponse.json({ target: null });
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; text?: unknown; image?: unknown; images?: unknown };
  try {
    body = (await req.json()) as { pid?: unknown; path?: unknown; text?: unknown; image?: unknown; images?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const pid = Number(body.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const filePath = typeof body.path === "string" ? body.path : "";
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  /* Accept an images array; the legacy single `image` field folds in for
     older clients. */
  const rawImages = Array.isArray(body.images)
    ? body.images
    : body.image && typeof body.image === "object"
      ? [body.image]
      : [];
  const images = rawImages
    .filter((entry): entry is ImagePayload => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      base64: typeof entry.base64 === "string" ? entry.base64 : "",
      mime: typeof entry.mime === "string" ? entry.mime : "",
    }))
    .filter((entry) => entry.base64);
  if (!text.trim() && !images.length) {
    return NextResponse.json({ error: "порожнє повідомлення" }, { status: 400 });
  }
  for (const image of images) {
    if (inboxImageExt(image.mime) === null) {
      return NextResponse.json({ error: "непідтримуваний тип зображення" }, { status: 415 });
    }
    // base64 inflates the payload 4:3; checking the encoded length rejects an
    // oversized body before it is ever decoded into a Buffer.
    if (image.base64.length > (MAX_INBOX_IMAGE_BYTES * 4) / 3 + 4) {
      return NextResponse.json({ error: "зображення завелике (ліміт 10 МБ)" }, { status: 413 });
    }
  }

  let target: string | null = null;
  if (hasPid) {
    const resolved = await targetForKnownPid(pid);
    if (resolved === "unknown" && !filePath) {
      return NextResponse.json({ error: "процес невідомий переглядачу" }, { status: 403 });
    }
    target = resolved === "unknown" ? null : resolved;
  }

  try {
    const imagePaths = images.map((image) => saveInboxImage(image.base64, image.mime).path);
    const payload = [text.trim(), ...imagePaths].filter(Boolean).join("\n");
    const imageField = imagePaths.length ? { imagePaths } : {};

    if (target !== null) {
      await sendText(target, payload);
      return NextResponse.json({ ok: true, target, ...imageField });
    }

    /* No live pane: reopen the conversation as a fresh agent window in the
       user's current tmux session and type the prompt there. */
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "процес не у tmux-сесії" }, { status: 409 });
    }
    const all = await listFiles();
    const entry = all.find((item) => item.path === filePath);
    if (!entry) {
      return NextResponse.json({ error: "файл невідомий переглядачу" }, { status: 403 });
    }
    const spec = resumeSpecFor(entry.root, entry.path);
    if (spec) {
      const sent = await sendToResumedAgent(entry.path, spec, payload);
      return NextResponse.json({ ok: true, target: sent.target, spawned: sent.spawned, ...imageField });
    }

    /* Subagents and other child records have no resumable session of their
       own: the message relays through the root conversation — into its live
       pane when it runs, through a resume window otherwise. */
    const byPath = new Map(all.map((item) => [item.path, item]));
    const seen = new Set<string>();
    let root = entry;
    while (root.parent && byPath.has(root.parent) && !seen.has(root.path)) {
      seen.add(root.path);
      root = byPath.get(root.parent)!;
    }
    if (root.path === entry.path) {
      return NextResponse.json({ error: "цю розмову неможливо відновити" }, { status: 409 });
    }
    const relayText = `Повідомлення від користувача для твоєї гілки «${entry.title.slice(0, 100)}» — передай або обробʼи сам:\n${payload}`;
    if (root.pid !== null) {
      const rootTarget = await resolveTarget(root.pid);
      if (rootTarget !== null) {
        await sendText(rootTarget, relayText);
        return NextResponse.json({ ok: true, target: rootTarget, ...imageField });
      }
    }
    const rootSpec = resumeSpecFor(root.root, root.path);
    if (!rootSpec) {
      return NextResponse.json({ error: "коренева сесія недоступна для повідомлення" }, { status: 409 });
    }
    const sent = await sendToResumedAgent(root.path, rootSpec, relayText);
    return NextResponse.json({ ok: true, target: sent.target, spawned: sent.spawned, ...imageField });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
