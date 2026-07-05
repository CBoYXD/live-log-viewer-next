import { NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import { loadFlows } from "@/lib/flows/store";
import { loadWorkflows } from "@/lib/workflows/store";
import type { FilesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FilesResponse>> {
  const files = await listFiles();
  return NextResponse.json({ files, flows: loadFlows(), workflows: loadWorkflows() });
}
