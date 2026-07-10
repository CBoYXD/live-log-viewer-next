import { expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";

import { NextRequest } from "next/server";

const pipeline = { id: "pipeline-1" };
mock.module("@/lib/pipelines/engine", () => ({
  getPipelines: () => ({ pipelines: [pipeline] }),
  createPipelineFromRequest: () => ({ pipeline }),
  patchPipeline: async () => ({ pipeline }),
}));

const { GET, POST } = await import("./route");

test("pipeline collection route mirrors flow GET and POST shapes", async () => {
  expect(await (await GET()).json()).toEqual({ pipelines: [pipeline] });
  const repoDir = fs.mkdtempSync(`${os.tmpdir()}/llv-pipeline-route-`);
  try {
    const request = new NextRequest("http://127.0.0.1/api/pipelines", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ task: "ship", repoDir, stages: [] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, pipeline });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("pipeline POST rejects malformed JSON", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: { host: "127.0.0.1" }, body: "{" }));
  expect(response.status).toBe(400);
});
