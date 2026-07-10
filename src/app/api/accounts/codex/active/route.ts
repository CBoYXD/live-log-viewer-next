import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, UnknownAccountError, setActiveCodexAccount } from "@/lib/accounts/codex";
import { createMigrationIntent, previewMigration } from "@/lib/accounts/migration/coordinator";
import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown; requestId?: unknown };
  try { body = await req.json() as { id?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    if (body.mode === "preview") return NextResponse.json(await previewMigration("codex"));
    setActiveCodexAccount(body.id);
    if (body.mode === "migrate") {
      const requestId: string = typeof body.requestId === "string" ? body.requestId.slice(0, 128) : crypto.randomUUID();
      const result = await createMigrationIntent("codex", body.id, "manual", requestId);
      return NextResponse.json(result, { status: 202 });
    }
    agentRegistry().setEngineRouting("codex", body.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof UnknownAccountError || error instanceof CorruptCodexAccountsError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not select account" }, { status });
  }
}
