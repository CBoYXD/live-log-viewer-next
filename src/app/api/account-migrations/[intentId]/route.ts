import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ intentId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (body.action !== "stop") return NextResponse.json({ error: "unsupported migration action" }, { status: 400 });
  const { intentId } = await params;
  try { return NextResponse.json(agentRegistry().setMigrationIntentState(intentId, "stopped")); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "migration action failed" }, { status: 404 }); }
}
