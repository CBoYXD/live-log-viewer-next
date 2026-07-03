import fs from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { numberValue, readJson } from "@/lib/scanner/json";
import { outputHolders, pidAlive } from "@/lib/scanner/process";
import { pathAllowed, ROOTS } from "@/lib/scanner/roots";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KillResponse {
  ok: true;
  pid: number;
}

function isUnder(pathname: string, root: string): boolean {
  const rel = path.relative(root, pathname);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readCmdline(pid: number): string {
  try {
    return fs.readFileSync(path.join("/proc", String(pid), "cmdline"), "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function pidStillHoldsPath(pid: number, pathname: string): boolean {
  let fds: fs.Dirent[];
  try {
    fds = fs.readdirSync(path.join("/proc", String(pid), "fd"), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      if (fs.readlinkSync(path.join("/proc", String(pid), "fd", fd.name)) === pathname) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function derivePid(pathname: string): number | null | "invalid" | "stale" {
  if (isUnder(pathname, ROOTS["codex-jobs"]) && pathname.endsWith(".log")) {
    const job = readJson(pathname.replace(/\.log$/, ".json"));
    const pid = numberValue(job?.pid);
    if (pid === null || !pidAlive(pid)) return null;
    return readCmdline(pid).includes("codex") ? pid : null;
  }
  if (isUnder(pathname, ROOTS["claude-tasks"]) && pathname.endsWith(".output")) {
    const pid = outputHolders(true).get(pathname) ?? null;
    if (pid === null || !pidAlive(pid)) return null;
    return pidStillHoldsPath(pid, pathname) ? pid : "stale";
  }
  return "invalid";
}

export async function POST(req: NextRequest): Promise<NextResponse<KillResponse | ApiError>> {
  let body: { path?: unknown; force?: unknown };
  try {
    body = (await req.json()) as { path?: unknown; force?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const pathname = typeof body.path === "string" ? body.path : "";
  if (!pathname || !pathAllowed(pathname)) {
    return NextResponse.json({ error: "шлях поза дозволеними коренями" }, { status: 400 });
  }

  const pid = derivePid(pathname);
  if (pid === "invalid") {
    return NextResponse.json({ error: "не процесний запис" }, { status: 400 });
  }
  if (pid === null || pid === "stale" || !pidAlive(pid)) {
    return NextResponse.json({ error: "процес вже не працює" }, { status: 409 });
  }

  try {
    process.kill(pid, body.force ? "SIGKILL" : "SIGTERM");
    return NextResponse.json({ ok: true, pid });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
