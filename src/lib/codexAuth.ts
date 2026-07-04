import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

/**
 * ChatGPT credentials of the locally logged-in Codex CLI/Desktop. The viewer
 * reuses them to call the same backend the desktop dictation uses; the token
 * never leaves the server process and is never sent to the browser.
 */
export function readCodexAuth(): CodexAuth | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const accessToken = typeof raw.tokens?.access_token === "string" ? raw.tokens.access_token : "";
    const accountId = typeof raw.tokens?.account_id === "string" ? raw.tokens.account_id : "";
    return accessToken && accountId ? { accessToken, accountId } : null;
  } catch {
    return null;
  }
}
