import { after } from "next/server";

import { buildFilesResponse } from "./response";
import { cachedFileScan } from "./scanCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const revision = request.headers.get("x-llv-files-revision");
  const parsedRevision = revision !== null && /^\d+$/.test(revision) ? Number(revision) : undefined;
  const requireFresh = parsedRevision !== undefined && Number.isSafeInteger(parsedRevision);
  return buildFilesResponse(request, {
    listFilesWithProjectCatalog: async (selectedProject) => {
      const scan = await cachedFileScan(selectedProject, Date.now(), requireFresh);
      if (scan.refreshAfterResponse) after(scan.refreshAfterResponse);
      return scan.snapshot;
    },
  });
}
