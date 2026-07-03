import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import type { ApiError, LogChunk } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chunked tail read; same contract as `/log` in the Python prototype. */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<LogChunk | ApiError>> {
  const path = req.nextUrl.searchParams.get("path") ?? "";
  let offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    stat = null;
  }
  if (!path || !stat?.isFile() || !pathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }

  const size = stat.size;
  if (offset > size) offset = 0;
  if (offset === 0 && size > MAX_CHUNK) offset = size - MAX_CHUNK;

  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(MAX_CHUNK, Math.max(0, size - offset)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return NextResponse.json({
      offset: offset + bytesRead,
      size,
      data: buf.subarray(0, bytesRead).toString("utf-8"),
    });
  } finally {
    await fh.close();
  }
}
