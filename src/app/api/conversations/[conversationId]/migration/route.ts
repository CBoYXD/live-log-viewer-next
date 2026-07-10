import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const { conversationId } = await params;
  if (!conversationId.startsWith("conversation_")) return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
  if (body.action === "rollback") {
    try { return NextResponse.json(agentRegistry().setConversationMigration(conversationId as ViewerConversationId, null)); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "conversation is unknown" }, { status: 404 }); }
  }
  if (body.action === "retry") {
    try { return NextResponse.json(await advanceConversationMigration(conversationId as ViewerConversationId)); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "migration retry failed" }, { status: 409 }); }
  }
  return NextResponse.json({ error: "unsupported conversation migration action" }, { status: 400 });
}
