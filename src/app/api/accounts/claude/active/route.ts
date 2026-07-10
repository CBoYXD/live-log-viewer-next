import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, UnknownClaudeAccountError, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { createMigrationIntent, previewMigration } from "@/lib/accounts/migration/coordinator";
import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown; requestId?: unknown }; try { body = await req.json() as { id?: unknown; mode?: unknown; requestId?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    if (body.mode === "preview") return NextResponse.json(await previewMigration("claude"));
    setActiveClaudeAccount(body.id);
    if (body.mode === "migrate") {
      const requestId: string = typeof body.requestId === "string" ? body.requestId.slice(0, 128) : crypto.randomUUID();
      return NextResponse.json(await createMigrationIntent("claude", body.id, "manual", requestId), { status: 202 });
    }
    agentRegistry().setEngineRouting("claude", body.id);
    return new NextResponse(null, { status: 204 });
  }
  catch (error) { const status = error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError ? 400 : 500; return NextResponse.json({ error: error instanceof Error ? error.message : "could not select Claude account" }, { status }); }
}
