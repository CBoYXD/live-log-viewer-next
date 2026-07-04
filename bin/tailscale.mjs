import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const INSTALL_HINT = "Tailscale не знайдено. Встановіть: https://tailscale.com/download — і повторіть.";
export const OPERATOR_HINT =
  "Tailscale вимагає прав оператора. Виконайте один раз у своєму терміналі:\nsudo tailscale set --operator=$USER — і перезапустіть.";

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export class TailscaleError extends Error {}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectTailscale() {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, "tailscale");
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  if (existsSync(MACOS_TAILSCALE) && (await isExecutable(MACOS_TAILSCALE))) {
    return MACOS_TAILSCALE;
  }

  throw new TailscaleError(INSTALL_HINT);
}

function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new TailscaleError(stderr.trim() || `tailscale status завершився з кодом ${code ?? 1}`));
    });
  });
}

export async function readStatus(tailscalePath) {
  const output = await runJson(tailscalePath, ["status", "--json"]);
  let status;
  try {
    status = JSON.parse(output);
  } catch {
    throw new TailscaleError("Не вдалося прочитати статус Tailscale. Перевірте `tailscale status --json`.");
  }

  const backendState = typeof status.BackendState === "string" ? status.BackendState : "";
  if (backendState === "NeedsLogin" || backendState === "Stopped") {
    throw new TailscaleError("Tailscale не запущено або потрібен вхід. Виконайте `tailscale up` і повторіть.");
  }

  const rawDnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const dnsName = rawDnsName.replace(/\.$/, "");
  if (dnsName.length === 0) {
    throw new TailscaleError(
      "Tailscale не повернув DNSName. Увімкніть MagicDNS та HTTPS certificates у tailnet admin console і повторіть.",
    );
  }

  return { backendState, dnsName };
}

export function serve(tailscalePath, port) {
  const child = spawn(tailscalePath, ["serve", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const state = {
    stopping: false,
    operatorHintPrinted: false,
    started: false,
  };

  const startedTimer = setTimeout(() => {
    state.started = true;
  }, 500);

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (/operator|access denied|permission/i.test(text)) {
      state.operatorHintPrinted = true;
      console.error(OPERATOR_HINT);
      return;
    }

    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    console.error(`Не вдалося запустити tailscale serve: ${error.message}`);
  });

  child.on("exit", () => {
    clearTimeout(startedTimer);
    if (state.stopping || state.operatorHintPrinted) {
      return;
    }

    if (state.started) {
      console.error("Попередження: tailscale serve зупинився, локальний сервер продовжує працювати.");
    }
  });

  return { child, state };
}

function configRoot() {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function tokenPath() {
  return join(configRoot(), "agent-log-viewer", "token");
}

function generateToken() {
  return randomBytes(16).toString("hex");
}

async function writeToken(path, token) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function getToken({ rotate = false } = {}) {
  const path = tokenPath();

  if (!rotate) {
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (TOKEN_PATTERN.test(existing)) {
        await chmod(path, 0o600);
        return { token: existing, path };
      }
    } catch {
      // Regenerate unreadable or missing token files.
    }
  }

  const token = generateToken();
  await writeToken(path, token);
  return { token, path };
}
