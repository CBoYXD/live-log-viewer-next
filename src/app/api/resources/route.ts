import { NextRequest, NextResponse } from "next/server";

import { readResources } from "@/lib/resources";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError, ResourcesPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** System memory + per-agent-session attribution: GET /api/resources.
    `?fresh=1` bypasses the short server cache — used right after a kill. */
export async function GET(req: NextRequest): Promise<NextResponse<ResourcesPayload | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json(await readResources(fresh));
}
