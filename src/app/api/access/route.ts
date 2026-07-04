import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccessResponse {
  /** Tailnet URL with the `?k=` access token, or null when --tailscale wasn't used. */
  tailnetUrl: string | null;
}

// The proxy already gates every request (including this one) behind the same
// token, so any caller that reaches this handler is already authorized to see
// it. Guarded with rejectCrossOrigin anyway as defense in depth against DNS
// rebinding, since this route is the one place that hands back the secret URL.
export async function GET(req: NextRequest): Promise<NextResponse<AccessResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const tailnetUrl = process.env.LLV_TS_URL;
  return NextResponse.json({ tailnetUrl: tailnetUrl && tailnetUrl.length > 0 ? tailnetUrl : null });
}
