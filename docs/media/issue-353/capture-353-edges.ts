/**
 * Focused #353 repair evidence: the StageEdgeControls "Connect" pickers in the
 * pipeline editor. Boots the pinned demo fixture runtime (same isolated home +
 * fixed clock as scripts/demo-capture.ts), injects two schema-v3 DRAFT pipelines
 * — a three-stage draft whose verify stage carries a self-targeting fail edge,
 * and a ONE-STAGE draft whose lone stage carries a self-targeting fail edge —
 * then drives local headless Chrome over CDP to open each draft's editor and
 * screenshot the edge controls at 1920×1080.
 *
 * This is the repair's proof that a legal self-targeting fail edge is
 * configurable (Finding 4), including on a one-stage pipeline where it is the
 * only cycle the graph can carry. The editor is a desktop board affordance
 * (useIsMobile gates the whole shelf/editor off below 768px), and its panel is
 * w-[min(320px,…)] wide, so these captures show the control at a sub-390px
 * width. The mobile pipeline board surface at 390px lives in
 * board-mobile-390.png.
 *
 *   bun docs/media/issue-353/capture-353-edges.ts
 *
 * (Set LLV_DEMO_TMUX_TMPDIR to a short path on deep checkouts, as with
 * scripts/demo-capture.ts.)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const { bootstrapDemoRuntime, renderFixtureTemplate, DEMO_FIXED_ISO } = await import(path.join(repoRoot, "scripts/demo-capture.ts"));

const PORT = 3042;
const OUT_DIR = path.join(repoRoot, "docs/media/issue-353");

type CdpResponse = { result?: { value?: unknown }; data?: string };
type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  close: () => void;
  logs: string[];
};

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new Error(`ws error: ${String(event)}`));
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
  const logs: string[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; method?: string; error?: { message: string }; result?: CdpResponse; params?: { type?: string; args?: Array<{ value?: unknown; description?: string }> } };
    if (message.method === "Runtime.consoleAPICalled") {
      logs.push(`console.${message.params?.type}: ${(message.params?.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ")}`);
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result ?? {});
    }
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
    logs,
  };
}

async function evalUntil(cdp: Cdp, expression: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value === true) return;
    if (Date.now() - start > timeoutMs) throw new Error(`condition timed out: ${expression.slice(0, 120)}`);
    await Bun.sleep(500);
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

const ROLE = { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null } as const;

function draft(id: string, task: string, home: string, stages: Array<{ id: string; prompt: string; next: string | null; onFail: { to: string; maxRounds: number } | null }>): unknown {
  const repoDir = path.join(home, "Projects/atlas");
  const repoName = path.basename(repoDir);
  return {
    id,
    task,
    project: "atlas",
    repoDir,
    worktreeDir: path.join(path.dirname(repoDir), `${repoName}-pipeline-${id}`),
    branch: `pipeline/${slugify(task)}-${id}`,
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    stages: stages.map((stage) => ({ id: stage.id, kind: "run", prompt: stage.prompt, next: stage.next, onFail: stage.onFail, effectiveRole: ROLE })),
    runs: stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: { stageId: stages[0]!.id, state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2100-01-02T09:00:00.000Z",
    closedAt: null,
    hiddenAt: null,
  };
}

const MULTI_ID = "a3530301";
const SOLO_ID = "a3530302";

function fixture(home: string): unknown {
  return {
    schemaVersion: 3,
    pipelines: [
      draft(MULTI_ID, "Editable graph edges", home, [
        { id: "plan", prompt: "{{task}}", next: "build", onFail: null },
        { id: "build", prompt: "{{prev.output}}", next: "verify", onFail: { to: "plan", maxRounds: 3 } },
        { id: "verify", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "verify", maxRounds: 2 } },
      ]),
      draft(SOLO_ID, "Lone implement stage", home, [
        { id: "implement", prompt: "{{task}}", next: null, onFail: { to: "implement", maxRounds: 2 } },
      ]),
    ],
  };
}

async function openEditorAndShoot(cdp: Cdp, pipelineId: string, name: string): Promise<void> {
  /* Close any open editor, then open this draft's editor from the shelf. */
  await cdp.send("Runtime.evaluate", { expression: `
    (() => {
      const item = document.querySelector('[data-pipeline-shelf-item="${pipelineId}"]');
      if (!item) return "no-shelf-item";
      const button = item.querySelector(':scope > button');
      if (!button) return "no-edit-button";
      button.click();
      return "clicked";
    })();
  `, returnByValue: true });
  /* Wait for the edge controls of this editor to mount, then bring them into view. */
  await evalUntil(cdp, `!!document.querySelector('[data-stage-edges]')`, 20_000);
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-stage-edges]')?.scrollIntoView({ block: "center" });` });
  await Bun.sleep(600);
  const png = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(String(png.data), "base64"));
  console.log(`captured ${name}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runtime = await bootstrapDemoRuntime(repoRoot, PORT);
  const chromeDir = fs.mkdtempSync("/tmp/chrome-353-edges-");
  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    await runtime.waitUntilReady();
    /* filterPipelinesForFileScan surfaces a member-less draft only when its
       repoDir exists on disk, so materialize the fixture project directory. */
    fs.mkdirSync(path.join(runtime.env.HOME!, "Projects/atlas"), { recursive: true });
    fs.writeFileSync(
      path.join(runtime.env.LLV_STATE_DIR!, "pipelines.json"),
      JSON.stringify(fixture(runtime.env.HOME!), null, 2) + "\n",
      "utf8",
    );
    void renderFixtureTemplate; // (kept for parity with the sibling capture harness)

    chrome = spawn("google-chrome-stable", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
      "--force-color-profile=srgb", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${chromeDir}`, "--remote-debugging-port=0", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const portFile = path.join(chromeDir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await Bun.sleep(200);
    const debugPort = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();

    const frames = [
      { suffix: "desktop", width: 1920, height: 1080, mobile: false },
    ];
    for (const frame of frames) {
      const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string; id: string };
      const cdp = await connect(created.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: frame.mobile });
      const fixedMs = Date.parse(DEMO_FIXED_ISO);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
        const NativeDate = Date;
        class CaptureDate extends NativeDate { constructor(...a){ super(...(a.length ? a : [${fixedMs}])); } static now(){ return ${fixedMs}; } }
        Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
        Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
        Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
        try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("llv_lang", "en"); localStorage.setItem("llvSound", "0"); } catch {}
      ` });
      await cdp.send("Page.navigate", { url: `http://172.17.0.1:${PORT}/` });
      await evalUntil(cdp, `document.readyState === "complete"`);
      await Bun.sleep(2000);
      await cdp.send("Runtime.evaluate", { expression: `location.hash = "#p=atlas";` });
      await Bun.sleep(1500);
      /* Select the scheme view, where the pipeline shelf lives on the board. */
      await cdp.send("Runtime.evaluate", { expression: `(Array.from(document.querySelectorAll('button[aria-label="scheme"]')).find((button) => button.getAttribute("aria-pressed") === "false"))?.click();` });
      await evalUntil(cdp, `!!document.querySelector('[data-pipeline-shelf-item="${MULTI_ID}"]')`, 90_000);
      await cdp.send("Runtime.evaluate", { expression: `
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; } nextjs-portal { display: none !important; }";
        document.head.appendChild(style);
      ` });
      await Bun.sleep(600);
      await openEditorAndShoot(cdp, MULTI_ID, `edges-${frame.suffix}.png`);
      await openEditorAndShoot(cdp, SOLO_ID, `edges-onestage-${frame.suffix}.png`);
      if (cdp.logs.length) console.log(`[${frame.suffix}] console:`, cdp.logs.slice(-5).join(" | "));
      cdp.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${created.id}`).catch(() => undefined);
    }
  } finally {
    chrome?.kill("SIGKILL");
    await runtime.shutdown();
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }
}

await main();
