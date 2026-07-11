export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { capability: "viewer-deployments", version: 1 },
    { headers: { "cache-control": "no-store" } },
  );
}
