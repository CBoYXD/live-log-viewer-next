/**
 * Issue #334 / #342 acceptance evidence: the compact terminal-retry surfaces
 * and the retired-placeholder launch-history strip. Regenerated with:
 *
 *   bun docs/acceptance/issue-334-342/capture.ts
 *
 * The run reuses the Stage A demo runtime (isolated fixture home + dev
 * server) and seeds, through the registry's own mutation API, three terminal
 * structured launch receipts: a recent failed launch (history row + the
 * pathless failed task assignment), a recent recovered launch (history row),
 * and a failed launch older than the 24 h retirement bound — which must be
 * absent everywhere. Each shot renders twice with an innerText equality gate
 * plus element-visibility assertions before publication. Chrome runs over raw
 * CDP — the pinned mcp/puppeteer container is not available on every host.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bootstrapDemoRuntime,
  DEMO_FIXED_ISO,
  demoPort,
  regenerateNextTypes,
} from "../../../scripts/demo-capture";
import { AgentRegistry } from "../../../src/lib/agent/registry";
import { emptyLaunchProfile } from "../../../src/lib/accounts/migration/contracts";

const DEFAULT_PORT = 3334;
const FAILED_ERROR = "structured spawn runtime snapshot has no session after 300000ms";
const FAILED_TITLE = "Atlas relaunch worker";
const RECOVERED_TITLE = "Atlas recovered import";
const RETIRED_TITLE = "Atlas retired launch";
const TASK_TITLE = "Rescue the flaky spawn";

type EvidenceShot = {
  id: string;
  output: string;
  viewport: { width: number; height: number; mobile: boolean };
};

const SHOTS: EvidenceShot[] = [
  { id: "terminal-retry-desktop", output: "terminal-retry-desktop-1440.png", viewport: { width: 1440, height: 900, mobile: false } },
  { id: "terminal-retry-mobile", output: "terminal-retry-mobile-390.png", viewport: { width: 390, height: 844, mobile: true } },
];

const FREEZE_STYLE = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    content-visibility: visible !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    will-change: auto !important;
  }
  html { scroll-behavior: auto !important; }
  body { cursor: default !important; }
  [data-capture-volatile="pid"] { display: none !important; }
  nextjs-portal { display: none !important; }
`;

function chromeExecutable(): string {
  const candidates = [process.env.LLV_EVIDENCE_CHROME, "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome executable found; set LLV_EVIDENCE_CHROME");
}

/** Minimal flat-session CDP client over the browser websocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {}

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener("message", (event) => client.dispatch(String(event.data)));
    ws.addEventListener("close", () => {
      for (const entry of client.pending.values()) entry.reject(new Error("CDP websocket closed"));
      client.pending.clear();
    });
    return client;
  }

  private dispatch(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(payload);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function launchChrome(userDataDir: string): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(chromeExecutable(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const deadline = setTimeout(() => reject(new Error(`Chrome never announced DevTools\n${buffered}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Chrome exited with ${code}\n${buffered}`));
    });
  });
  return { child, wsUrl };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
}

/** Seed the terminal launch receipts through the registry's own mutation API
    (the exact path the product takes), then pin their creation instants:
    two inside the strip window relative to the frozen page clock, and one
    genuinely past the 24 h retirement bound relative to the real server
    clock — that one must never be served again. */
function seedSpawnEvidence(stateDir: string): { failedLaunchId: string; failedConversationId: string } {
  const registryFile = path.join(stateDir, "agent-registry.json");
  const registry = new AgentRegistry(registryFile);
  const begin = (title: string, attempt: string, digest: string) => {
    const begun = registry.beginSpawnRequest({
      engine: "claude",
      cwd: "/demo/Projects/atlas",
      transport: "structured",
      accountId: "default",
      clientAttemptId: attempt,
      requestDigest: digest.repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: "/demo/Projects/atlas", title }),
    });
    if (begun.kind !== "created") throw new Error(`expected structured launch creation for ${title}`);
    return begun.receipt;
  };
  const failed = begin(FAILED_TITLE, "evidence_334_failed_a1", "a");
  registry.failStructuredSpawn(failed.launchId, FAILED_ERROR);
  const recovered = begin(RECOVERED_TITLE, "evidence_334_recovered_a1", "b");
  const settled = registry.settleSpawn(recovered.launchId, {
    key: { engine: "claude", sessionId: "99999999-9999-4999-8999-999999999334" },
    artifactPath: "/demo/Projects/atlas/ghost-99999999-9999-4999-8999-999999999334.jsonl",
    cwd: "/demo/Projects/atlas",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/demo/Projects/atlas", title: RECOVERED_TITLE }),
    status: "dead",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("expected recovered settlement");
  const retired = begin(RETIRED_TITLE, "evidence_342_retired_a1", "c");
  registry.failStructuredSpawn(retired.launchId, "structured spawn interrupted before identity staging");

  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    receipts: Record<string, { createdAt: string }>;
  };
  raw.receipts[failed.launchId]!.createdAt = "2100-01-02T10:00:00.000Z";
  raw.receipts[recovered.launchId]!.createdAt = "2100-01-02T09:30:00.000Z";
  /* Far in the real past: age exceeds PLACEHOLDER_RETIREMENT_MS on the live
     server clock, so the projection must retire this receipt entirely. */
  raw.receipts[retired.launchId]!.createdAt = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(registryFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { failedLaunchId: failed.launchId, failedConversationId: failed.conversationId };
}

/** Append the pathless failed assignment task (#334) to the fixture board. */
function seedFailedAssignmentTask(stateDir: string, launchId: string, conversationId: string): void {
  const tasksFile = path.join(stateDir, "tasks.json");
  const state = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks: unknown[] };
  state.tasks.push({
    id: "task-evidence-334",
    project: "atlas",
    status: "assigned",
    text: `${TASK_TITLE}\nRelaunch the structured worker after the runtime socket outage.`,
    placement: "pinned",
    pos: { x: 760, y: 330 },
    assignments: [{
      launchId,
      clientAttemptId: "evidence_334_failed_a1",
      path: null,
      conversationId,
      panePid: null,
      state: "failed",
      error: FAILED_ERROR,
      at: "2100-01-02T11:40:00.000Z",
      accountId: "default",
      engine: "claude",
    }],
    createdAt: "2100-01-02T11:35:00.000Z",
    updatedAt: "2100-01-02T11:40:00.000Z",
  });
  fs.writeFileSync(tasksFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** One poll step toward the surface under capture. Idempotent. */
function openExpression(shot: EvidenceShot): string {
  if (!shot.viewport.mobile) {
    return `(() => {
      const strip = document.querySelector('[data-testid="launch-history"]');
      if (!strip) return "no-strip";
      const header = strip.querySelector("button");
      if (!(header instanceof HTMLElement)) return "no-strip-header";
      if (header.getAttribute("aria-expanded") !== "true") { header.click(); return "expanded-strip"; }
      if (!document.querySelector('[data-scheme-task="task-evidence-334"]')) return "no-task-card";
      return "open";
    })()`;
  }
  return `(() => {
    if (document.querySelector("[data-task-sheet-retry]")) return "open";
    const row = Array.from(document.querySelectorAll("button"))
      .find((entry) => (entry.textContent || "").includes(${JSON.stringify(TASK_TITLE)}));
    if (row instanceof HTMLElement) { row.click(); return "clicked-task-row"; }
    const toggle = document.querySelector('button[aria-label="Toggle the task panel"]');
    if (!(toggle instanceof HTMLElement)) return "no-panel-toggle";
    toggle.click();
    return "clicked-panel-toggle";
  })()`;
}

/** Acceptance gates, evaluated in-page. Returns failure strings. */
function inspectExpression(shot: EvidenceShot): string {
  if (!shot.viewport.mobile) {
    return `(() => {
      const problems = [];
      const card = document.querySelector('[data-scheme-task="task-evidence-334"]');
      if (!card) return ["task card is missing"];
      const retry = card.querySelector("[data-task-retry-launch]");
      if (!retry) {
        problems.push("task card retry launch control is missing");
      } else {
        /* The scheme camera scales world content; require presence and a
           sane on-screen footprint rather than the unscaled 28px hit size. */
        const box = retry.getBoundingClientRect();
        if (box.width < 6 || box.height < 6) problems.push("retry control is " + box.width.toFixed(1) + "x" + box.height.toFixed(1));
        if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) problems.push("retry control leaves the viewport");
      }
      const chip = retry ? retry.closest("span") : null;
      if (chip && !(chip.getAttribute("title") || "").includes("no session after")) {
        problems.push("failed chip title lost the exact error");
      }
      if (card.querySelector(".animate-spin")) problems.push("failed assignment still renders a spinner");
      const strip = document.querySelector('[data-testid="launch-history"]');
      if (!strip) return problems.concat(["launch history strip is missing"]);
      const rows = strip.querySelectorAll("li");
      if (rows.length !== 2) problems.push("launch history has " + rows.length + " rows, expected 2");
      const text = strip.innerText || "";
      for (const needle of ["Launch history", ${JSON.stringify(FAILED_TITLE)}, ${JSON.stringify(RECOVERED_TITLE)}, "failed", "recovered", "Retry"]) {
        if (!text.includes(needle)) problems.push("missing strip text " + JSON.stringify(needle));
      }
      if ((document.body.innerText || "").includes(${JSON.stringify(RETIRED_TITLE)})) {
        problems.push("retired launch is still projected");
      }
      return problems;
    })()`;
  }
  return `(() => {
    const problems = [];
    const retry = document.querySelector("[data-task-sheet-retry]");
    if (!retry) return ["sheet retry control is missing"];
    if ((retry.textContent || "").trim() !== "retry launch") {
      problems.push("retry control reads " + JSON.stringify((retry.textContent || "").trim()));
    }
    const row = retry.closest("div");
    if (!row || !(row.innerText || "").includes("delivery failed")) {
      problems.push("pathless failed row lost its terminal label");
    }
    if (row && row.querySelector(".animate-spin")) problems.push("failed row still renders a spinner");
    const box = retry.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) problems.push("retry control is " + box.width.toFixed(1) + "x" + box.height.toFixed(1));
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) problems.push("retry control leaves the viewport");
    if ((document.body.innerText || "").includes(${JSON.stringify(RETIRED_TITLE)})) {
      problems.push("retired launch is still projected");
    }
    return problems;
  })()`;
}

async function renderShot(
  cdp: Cdp,
  baseUrl: string,
  shot: EvidenceShot,
  capturePng: boolean,
): Promise<{ text: string; png: Buffer | null }> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: shot.viewport.width,
      height: shot.viewport.height,
      deviceScaleFactor: 1,
      mobile: shot.viewport.mobile,
    }, sessionId);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }, sessionId);
    const fixedMs = Date.parse(DEMO_FIXED_ISO);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const captureTime = ${fixedMs};
        const NativeDate = Date;
        class CaptureDate extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [captureTime])); }
          static now() { return captureTime; }
        }
        Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
        Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
        Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
        try {
          localStorage.clear();
          sessionStorage.clear();
          localStorage.setItem("llv_lang", "en");
          localStorage.setItem("llvSound", "0");
        } catch {}
      })();`,
    }, sessionId);
    await cdp.send("Page.navigate", { url: `${baseUrl}/#p=atlas` }, sessionId);

    const deadline = Date.now() + 90_000;
    let last = "";
    for (;;) {
      last = await evaluate<string>(cdp, sessionId, `(() => {
        if (document.readyState !== "complete") return "document " + document.readyState;
        if (document.fonts && document.fonts.status !== "loaded") return "fonts " + document.fonts.status;
        return ${openExpression(shot)};
      })()`);
      if (last === "open") break;
      if (Date.now() > deadline) {
        const text = await evaluate<string>(cdp, sessionId, "document.body ? document.body.innerText : \"(no body)\"");
        throw new Error(`${shot.id} never reached the surface: ${last}\nRendered text:\n${text}`);
      }
      await Bun.sleep(250);
    }

    await evaluate(cdp, sessionId, `(() => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(FREEZE_STYLE)};
      document.head.append(style);
    })()`);
    await evaluate(cdp, sessionId, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

    const gateDeadline = Date.now() + 30_000;
    for (;;) {
      const problems = await evaluate<string[]>(cdp, sessionId, inspectExpression(shot));
      if (!problems.length) break;
      if (Date.now() > gateDeadline) {
        if (process.env.LLV_EVIDENCE_DEBUG) {
          const debugShot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
          fs.writeFileSync(path.join(os.tmpdir(), `llv334-debug-${shot.id}.png`), Buffer.from(debugShot.data, "base64"));
        }
        throw new Error(`${shot.id} element gates failed:\n${problems.join("\n")}`);
      }
      await Bun.sleep(250);
    }

    const text = await evaluate<string>(cdp, sessionId, "document.body.innerText");
    let png: Buffer | null = null;
    if (capturePng) {
      const shotResult = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
      png = Buffer.from(shotResult.data, "base64");
    }
    return { text, png };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const outputDir = import.meta.dir;
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, DEFAULT_PORT, "LLV_EVIDENCE_PORT");
  const ghost = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500) }).catch(() => null);
  if (ghost) throw new Error(`something already listens on port ${port} — stop it or set LLV_EVIDENCE_PORT`);
  const tmuxDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "llv334-tmux-"));
  process.env.LLV_DEMO_TMUX_TMPDIR = tmuxDir;
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const tsconfigBefore = fs.readFileSync(tsconfigPath, "utf8");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  const { env, root, serverLogs, shutdown } = runtime;

  const { failedLaunchId, failedConversationId } = seedSpawnEvidence(env.LLV_STATE_DIR!);
  seedFailedAssignmentTask(env.LLV_STATE_DIR!, failedLaunchId, failedConversationId);

  process.once("SIGINT", () => { void shutdown(); process.exitCode = 130; });
  process.once("SIGTERM", () => { void shutdown(); process.exitCode = 143; });

  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    await runtime.waitUntilReady();
    const launched = await launchChrome(path.join(root, "chrome-profile"));
    chrome = launched.child;
    cdp = await Cdp.connect(launched.wsUrl);
    const baseUrl = `http://172.17.0.1:${port}`;
    for (const shot of SHOTS) {
      const first = await renderShot(cdp, baseUrl, shot, true);
      const second = await renderShot(cdp, baseUrl, shot, false);
      if (normalizeText(first.text) !== normalizeText(second.text)) {
        throw new Error(`${shot.id} changed between deterministic passes`);
      }
      const output = path.join(outputDir, shot.output);
      fs.writeFileSync(output, first.png!);
      process.stdout.write(`${shot.output} ${first.png!.length} bytes\n`);
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverLogs()}`);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) chrome.kill("SIGKILL");
    await shutdown();
    fs.writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
    fs.rmSync(tmuxDir, { recursive: true, force: true });
  }
  await regenerateNextTypes(repoRoot, env);
  fs.writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
}

if (import.meta.main) await main();
