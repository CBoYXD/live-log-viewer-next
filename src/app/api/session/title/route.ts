import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isoNow } from "@/lib/tasks/helpers";
import {
  MAX_CUSTOM_TITLE,
  sanitizeCustomTitle,
  titleKeysForEntry,
  writeSessionTitle,
  type SessionTitleOverride,
} from "@/lib/session/titleStore";
import { propagateTitleToWindow, resolveTitleTarget } from "@/lib/session/titleTarget";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchTitleBody {
  path?: unknown;
  conversationId?: unknown;
  title?: unknown;
  baseRevision?: unknown;
  /** Live agent pid so the change propagates to the tmux window name. */
  pid?: unknown;
  /** Effective title to stamp on the tmux window — the custom title on a set,
      the derived title on a reset. Falls back to the stored title when absent. */
  windowName?: unknown;
}

type PatchTitleResponse =
  | { ok: true; override: SessionTitleOverride | null }
  | (ApiError & { conflict?: SessionTitleOverride | null });

export async function PATCH(req: NextRequest): Promise<NextResponse<PatchTitleResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchTitleBody;
  try {
    body = (await req.json()) as PatchTitleBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!(body.title === null || typeof body.title === "string")) {
    return NextResponse.json({ error: "title must be a string or null" }, { status: 400 });
  }
  if (typeof body.title === "string" && body.title.length > MAX_CUSTOM_TITLE * 4) {
    return NextResponse.json({ error: "title is too long" }, { status: 400 });
  }
  if (body.baseRevision !== undefined && (typeof body.baseRevision !== "number" || !Number.isInteger(body.baseRevision) || body.baseRevision < 0)) {
    return NextResponse.json({ error: "baseRevision must be a non-negative integer" }, { status: 400 });
  }

  const target = resolveTitleTarget(body);
  if (!target) return NextResponse.json({ error: "unknown or unsupported session" }, { status: 400 });

  const candidateKeys = titleKeysForEntry(target);
  const outcome = writeSessionTitle(candidateKeys, candidateKeys[0]!, body.title as string | null, body.baseRevision as number | undefined, isoNow());
  if (!outcome.ok) {
    // Structured 409: the editor adopts the current server record and retries.
    return NextResponse.json(
      { error: "revision conflict", conflict: outcome.conflict },
      { status: 409 },
    );
  }

  // Best-effort tmux window rename. Never let a tmux hiccup fail the durable
  // rename that already committed to disk. On a set the window name is the
  // server-sanitized title (never the raw client string); on a reset the client
  // supplies the derived title, which we still sanitize before it reaches tmux.
  const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
  if (pid !== null) {
    const windowName = outcome.override?.title
      ?? (typeof body.windowName === "string" ? sanitizeCustomTitle(body.windowName) : null);
    if (windowName) await propagateTitleToWindow(pid, windowName);
  }

  return NextResponse.json({ ok: true, override: outcome.override });
}
