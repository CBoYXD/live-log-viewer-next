import { NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { loadFlows } from "@/lib/flows/store";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import type { FilesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FilesResponse>> {
  const files = await listFiles();
  const tasks = loadTasks();
  const reconciled = reconcileTasks(files, tasks, {
    pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
    panePidAlive: pidAlive,
  });
  if (reconciled.dirty) saveTasks(reconciled.tasks);
  return NextResponse.json({ files, flows: loadFlows(), tasks: reconciled.tasks });
}
