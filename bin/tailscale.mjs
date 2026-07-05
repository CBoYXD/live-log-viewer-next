import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const OPERATOR_HINT =
  "Tailscale вимагає прав оператора. Виконайте один раз у своєму терміналі:\nsudo tailscale set --operator=$USER — і перезапустіть.";

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export class TailscaleError extends Error {}

async function hasCommand(name) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (await isExecutable(join(entry, name))) return true;
  }
  return false;
}

/**
 * One-time setup walkthrough shown when the tailscale binary is missing:
 * exact copy-pasteable commands for this machine's package manager instead
 * of a bare download link.
 */
export async function buildInstallHint() {
  const steps = [];
  if (process.platform === "darwin") {
    steps.push(
      "  1. Встановіть застосунок:   brew install --cask tailscale-app   (або з App Store)",
      "  2. Відкрийте Tailscale з Applications і увійдіть у свій акаунт.",
    );
  } else {
    if (await hasCommand("pacman")) {
      steps.push("  1. Встановіть:               sudo pacman -S tailscale");
    } else if (await hasCommand("apt-get")) {
      steps.push("  1. Встановіть:               curl -fsSL https://tailscale.com/install.sh | sh");
    } else if (await hasCommand("dnf")) {
      steps.push("  1. Встановіть:               curl -fsSL https://tailscale.com/install.sh | sh");
    } else {
      steps.push("  1. Встановіть:               https://tailscale.com/download");
    }
    steps.push(
      "  2. Запустіть службу:         sudo systemctl enable --now tailscaled",
      "  3. Увійдіть у акаунт:        sudo tailscale up   (відкриє браузер для входу)",
      "  4. Дозвольте serve без sudo: sudo tailscale set --operator=$USER",
    );
  }

  return [
    "Tailscale не знайдено. Це разове налаштування на ~2 хвилини:",
    "",
    ...steps,
    "",
    "Потім повторіть цю саму команду — viewer підніметься з QR для телефона.",
    "На телефоні: встановіть застосунок Tailscale і увійдіть тим самим акаунтом.",
    "Доступ матимуть лише ваші пристрої в tailnet — назовні нічого не відкривається.",
  ].join("\n");
}

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

  throw new TailscaleError(await buildInstallHint());
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
    throw new TailscaleError(
      [
        "Tailscale встановлено, але не запущено або потрібен вхід:",
        "",
        "  sudo tailscale up   (відкриє браузер для входу)",
        "",
        "Після входу повторіть цю саму команду.",
      ].join("\n"),
    );
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

  child.on("exit", (code) => {
    clearTimeout(startedTimer);
    if (state.stopping || state.operatorHintPrinted) {
      return;
    }

    if (state.started) {
      console.error("Попередження: tailscale serve зупинився, локальний сервер продовжує працювати.");
      return;
    }

    if (code !== 0) {
      console.error(
        "Не вдалося запустити tailscale serve (можливо, порт уже обслуговується іншим правилом). Перевірте `tailscale serve status`. Локальний сервер продовжує працювати.",
      );
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
  try {
    await writeToken(path, token);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TailscaleError(
      `Не вдалося записати ключ доступу у ${path} (${detail}). Перевірте права на директорію ${dirname(path)} і повторіть.`,
    );
  }
  return { token, path };
}
