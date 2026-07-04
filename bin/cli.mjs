#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectTailscale, getToken, readStatus, serve as serveTailscale, TailscaleError } from "./tailscale.mjs";

const DEFAULT_PORT = 8898;
const DEFAULT_HOSTNAME = "127.0.0.1";
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_INTERVAL_MS = 200;

const cliPath = fileURLToPath(import.meta.url);
const cliDir = dirname(cliPath);

function usage() {
  return `Використання: agent-log-viewer [опції]

Опції:
  -p, --port <n>       Порт для локального сервера (типово ${DEFAULT_PORT})
  -H, --hostname <h>   Адреса прив'язки (типово ${DEFAULT_HOSTNAME})
      --tailscale      Доступ через Tailscale
      --no-open        Не відкривати браузер
      --new-token      Створити новий ключ доступу
  -v, --version        Показати версію
  -h, --help           Показати довідку`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`Некоректний порт: ${value}`);
  }
  return port;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    fail(`Опція ${flag} потребує значення.`);
  }
  return value;
}

function parseArgs(args) {
  const options = {
    port: DEFAULT_PORT,
    hostname: DEFAULT_HOSTNAME,
    tailscale: false,
    noOpen: false,
    newToken: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-p" || arg === "--port") {
      const value = requireValue(args, index, arg);
      options.port = parsePort(value);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "-H" || arg === "--hostname") {
      options.hostname = requireValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--hostname=")) {
      const value = arg.slice("--hostname=".length);
      if (!value) {
        fail("Опція --hostname потребує значення.");
      }
      options.hostname = value;
    } else if (arg === "--tailscale") {
      options.tailscale = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--new-token") {
      options.newToken = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      fail(`Невідома опція: ${arg}`);
    }
  }

  return options;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function findPackageRoot(startDir) {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      fail("Не вдалося знайти package.json для agent-log-viewer.");
    }
    currentDir = parentDir;
  }
}

function readPackageJson(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail(
      error instanceof Error
        ? `Не вдалося прочитати package.json: ${error.message}`
        : "Не вдалося прочитати package.json.",
    );
  }
}

function resolveServer(packageRoot) {
  const publishedStandalone = join(packageRoot, "dist", "standalone", "server.js");
  if (existsSync(publishedStandalone)) {
    return {
      command: process.execPath,
      args: [publishedStandalone],
      cwd: join(packageRoot, "dist", "standalone"),
      label: "server.js",
    };
  }

  const repoStandalone = join(packageRoot, ".next", "standalone", "server.js");
  if (existsSync(repoStandalone)) {
    return {
      command: process.execPath,
      args: [repoStandalone],
      cwd: join(packageRoot, ".next", "standalone"),
      label: "server.js",
    };
  }

  const nextBin = join(packageRoot, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    fail("Не знайдено standalone server.js або локальний next.");
  }

  return {
    command: nextBin,
    args: ["start"],
    cwd: packageRoot,
    label: "next start",
  };
}

function buildChildEnv(options, runtime) {
  const env = {
    ...process.env,
    PORT: String(options.port),
    // zsh exports HOSTNAME with the machine name on this user's machine; setting it here keeps standalone bound to the requested address.
    HOSTNAME: options.hostname,
  };

  if (runtime.llvToken) {
    env.LLV_TOKEN = runtime.llvToken;
  }

  if (runtime.llvTsHost) {
    env.LLV_TS_HOST = runtime.llvTsHost;
  }

  if (runtime.tailnetUrl) {
    env.LLV_TS_URL = runtime.tailnetUrl;
  }

  return env;
}

function startServer(server, options, runtime, tailscaleProcessRef) {
  const child = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: buildChildEnv(options, runtime),
    stdio: ["ignore", "inherit", "pipe"],
  });

  const state = {
    sawAddressInUse: false,
    stopping: false,
  };

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (text.includes("EADDRINUSE")) {
      state.sawAddressInUse = true;
      console.error(`Порт ${options.port} зайнятий. Спробуйте: bunx agent-log-viewer --port ${options.port + 1}`);
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      return;
    }

    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    fail(`Не вдалося запустити сервер: ${error.message}`);
  });

  child.on("exit", async (code, signal) => {
    if (state.stopping) {
      return;
    }

    // The server dying on its own (crash, EADDRINUSE) still leaves `tailscale
    // serve` running as our child; stop it through the bounded path (SIGTERM,
    // 2s, SIGKILL) so an unexpected server exit does not orphan the tailnet
    // mapping even when serve ignores SIGTERM.
    if (tailscaleProcessRef?.current) {
      await stopChild(tailscaleProcessRef.current);
    }

    if (state.sawAddressInUse) {
      process.exit(1);
    }

    if (signal) {
      process.exit(0);
    }

    process.exit(code ?? 1);
  });

  return { child, state };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function probe(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => {
      resolve(false);
    });

    request.setTimeout(READINESS_INTERVAL_MS, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function portAlreadyResponds(port) {
  return probe(`http://127.0.0.1:${port}/api/files`);
}

async function waitForReadiness(port) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  const url = `http://127.0.0.1:${port}/api/files`;

  while (Date.now() < deadline) {
    if (await probe(url)) {
      return;
    }

    await wait(READINESS_INTERVAL_MS);
  }

  throw new Error(`Сервер не відповів за ${READINESS_TIMEOUT_MS / 1000} секунд.`);
}

function localUrl(options) {
  const host = options.hostname === "::1" ? "[::1]" : options.hostname;
  return `http://${host}:${options.port}/`;
}

function printBanner(version, options) {
  console.log(`  ✳ Live Log Viewer v${version}`);
  console.log(`  Відкрито:  ${localUrl(options)}`);
  console.log("  Читає логи з ~/.claude/projects, ~/.codex/sessions.");
  console.log("  Ctrl+C — зупинити.  --tailscale — доступ з телефона.");
}

async function printTailscaleBanner(runtime) {
  if (!runtime.tailnetUrl) {
    return;
  }

  console.log(`  Tailnet:   ${runtime.tailnetUrl}`);
  const qrcodeModule = await import("qrcode-terminal");
  const qrcode = qrcodeModule.default ?? qrcodeModule;
  await new Promise((resolve) => {
    qrcode.generate(runtime.tailnetUrl, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });
  console.log("  Посилання містить ключ доступу — не пересилайте його стороннім.");
  console.log("  Після першого відкриття ключ зберігається у cookie на 30 днів.");
}

function openBrowser(url) {
  const opener =
    process.platform === "linux" ? "xdg-open" : process.platform === "darwin" ? "open" : null;

  if (!opener) {
    return;
  }

  const child = spawn(opener, [url], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

async function stopChild(processHandle) {
  const { child, state } = processHandle;
  state.stopping = true;

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
}

async function stopAll(serverProcess, tailscaleProcess) {
  await Promise.all([
    serverProcess ? stopChild(serverProcess) : Promise.resolve(),
    tailscaleProcess ? stopChild(tailscaleProcess) : Promise.resolve(),
  ]);
}

function installSignalHandlers(serverProcess, tailscaleProcessRef) {
  const shutdown = async () => {
    await stopAll(serverProcess, tailscaleProcessRef.current);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function prepareRuntime(options) {
  const runtime = {
    llvToken: undefined,
    llvTsHost: undefined,
    tailnetUrl: undefined,
    tailscalePath: undefined,
  };

  const nonLoopbackBind = !isLoopbackHostname(options.hostname);
  if (nonLoopbackBind) {
    console.error("Увага: нелокальна адреса відкриває viewer для мережі, тому режим ключа доступу увімкнено примусово.");
  }

  if (options.tailscale) {
    const tailscalePath = await detectTailscale();
    const status = await readStatus(tailscalePath);
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
    runtime.llvTsHost = status.dnsName;
    runtime.tailnetUrl = `https://${status.dnsName}/?k=${token}`;
    runtime.tailscalePath = tailscalePath;
    options.hostname = DEFAULT_HOSTNAME;
    return runtime;
  }

  if (nonLoopbackBind) {
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
  }

  return runtime;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = findPackageRoot(cliDir);
  const packageJson = readPackageJson(packageRoot);
  const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(version);
    return;
  }

  let runtime;
  try {
    runtime = await prepareRuntime(options);
  } catch (error) {
    if (error instanceof TailscaleError) {
      fail(error.message);
    }
    throw error;
  }

  if (await portAlreadyResponds(options.port)) {
    console.error(`Порт ${options.port} зайнятий. Спробуйте: bunx agent-log-viewer --port ${options.port + 1}`);
    process.exit(1);
  }

  const server = resolveServer(packageRoot);
  const tailscaleProcessRef = { current: null };
  const serverProcess = startServer(server, options, runtime, tailscaleProcessRef);
  installSignalHandlers(serverProcess, tailscaleProcessRef);

  if (options.tailscale && runtime.tailscalePath) {
    tailscaleProcessRef.current = serveTailscale(runtime.tailscalePath, options.port);
  }

  try {
    await waitForReadiness(options.port);
  } catch (error) {
    await stopAll(serverProcess, tailscaleProcessRef.current);
    fail(error instanceof Error ? error.message : "Сервер не готовий.");
  }

  if (
    serverProcess.state.sawAddressInUse ||
    serverProcess.child.exitCode !== null ||
    serverProcess.child.signalCode !== null
  ) {
    process.exit(serverProcess.state.sawAddressInUse ? 1 : (serverProcess.child.exitCode ?? 1));
  }

  printBanner(version, options);
  if (options.tailscale) {
    await printTailscaleBanner(runtime);
  }

  if (!options.noOpen && process.stdout.isTTY) {
    openBrowser(localUrl(options));
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
