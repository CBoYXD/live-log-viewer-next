import { NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import type { FileEntry } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FileEntry[]>> {
  return NextResponse.json(await listFiles());
}
