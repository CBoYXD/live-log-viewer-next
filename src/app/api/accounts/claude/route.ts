import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, InvalidClaudeAccountLabelError, createManagedClaudeAccount } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { label?: unknown }; try { body = await req.json() as { label?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
  if (!claudeLoginSupervisor.canStart()) return NextResponse.json({ error: "Claude login is disabled until LLV_ENABLE_CLAUDE_LOGIN=1 and LLV_CLAUDE_LOGIN_POLICY_ACCEPTED=1 are set" }, { status: 503 });
  try {
    const account = createManagedClaudeAccount(body.label);
    const login = claudeLoginSupervisor.start(account.id);
    return NextResponse.json({ account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent }, login }, { status: 202 });
  } catch (error) {
    const status = error instanceof InvalidClaudeAccountLabelError || error instanceof CorruptClaudeAccountsError ? 400 : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not create Claude account" }, { status });
  }
}
