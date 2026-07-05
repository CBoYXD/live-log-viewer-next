import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";
import { patchWorkflow } from "@/lib/workflows/engine";
import type { PatchWorkflowRequest, Workflow } from "@/lib/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkflowRouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(
  req: NextRequest,
  ctx: WorkflowRouteContext,
): Promise<NextResponse<{ ok: true; workflow: Workflow } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchWorkflowRequest;
  try {
    body = (await req.json()) as PatchWorkflowRequest;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  const actions = new Set(["pause", "resume", "advance", "retry-stage", "close"]);
  if (!actions.has(body.action)) {
    return NextResponse.json({ error: "невідома дія" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await patchWorkflow(id, body);
  if (!result.workflow) {
    return NextResponse.json({ error: result.error ?? "не вдалося змінити воркфлоу" }, { status: result.status ?? 400 });
  }
  return NextResponse.json({ ok: true, workflow: result.workflow });
}
