import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import type { ApiError, LogChunk } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Chunked log reads. Two modes:
 *  - tail (default): `offset` continues a forward poll; the very first read
 *    of a large file jumps to the last MAX_CHUNK bytes;
 *  - history: `before` returns the chunk of bytes ENDING at that offset, so
 *    the client can walk backwards page by page to the file start.
 */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<LogChunk | ApiError>> {
  const path = req.nextUrl.searchParams.get("path") ?? "";

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

  const beforeParam = req.nextUrl.searchParams.get("before");
  if (beforeParam !== null) {
    let before = Number(beforeParam);
    if (!Number.isFinite(before) || before < 0) before = 0;
    if (before > size) before = size;
    const start = Math.max(0, before - MAX_CHUNK);
    const fh = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(before - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return NextResponse.json({
        offset: start,
        start,
        size,
        data: buf.subarray(0, bytesRead).toString("utf-8"),
      });
    } finally {
      await fh.close();
    }
  }

  let offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (offset > size) offset = 0;
  if (offset === 0 && size > MAX_CHUNK) offset = size - MAX_CHUNK;

  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(MAX_CHUNK, Math.max(0, size - offset)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return NextResponse.json({
      offset: offset + bytesRead,
      start: offset,
      size,
      data: buf.subarray(0, bytesRead).toString("utf-8"),
    });
  } finally {
    await fh.close();
  }
}
