import { NextResponse } from "next/server";
import path from "node:path";

import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { deviceAuthChallenge } from "@/lib/accounts/deviceAuth";
import { activeClaudeAccountId, claudeAccountsMutationLocked, listClaudeAccounts } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { paneInfo, paneScreen } from "@/lib/tmux";
import { agentRegistry } from "@/lib/agent/registry";
import { evaluateAutoBalance } from "@/lib/accounts/migration/autoBalance";
import { fetchClaudeLimits, readCodexLimits } from "@/lib/limits";

async function tickAutoBalance(): Promise<void> {
  const registry = agentRegistry();
  const now = Date.now();
  if (registry.autoBalancePolicy("claude").enabled) {
    const observations = await Promise.all(listClaudeAccounts().filter((account) => account.authPresent).map(async (account) => {
      const read = await fetchClaudeLimits(path.join(account.home, ".credentials.json"));
      return { engine: "claude" as const, accountId: account.id, authenticated: account.authPresent, limits: read.data, provenance: { source: read.source, reason: read.reason, staleSince: null }, observedAt: now };
    }));
    evaluateAutoBalance("claude", activeClaudeAccountId(), observations, now, registry);
  }
  if (registry.autoBalancePolicy("codex").enabled) {
    const observations = await Promise.all(listCodexAccounts().filter((account) => account.authPresent).map(async (account) => {
      const read = await readCodexLimits({ account });
      return { engine: "codex" as const, accountId: account.id, authenticated: account.authPresent, limits: read.data, provenance: { source: read.source, reason: read.reason, staleSince: null }, observedAt: now };
    }));
    evaluateAutoBalance("codex", activeCodexAccountId(), observations, now, registry);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await tickAutoBalance();
  // When the registry is degraded it still reads as default-only-plus-valid, but any
  // write throws CorruptCodexAccountsError. Skip the best-effort stale-pane cleanup in
  // that state so the read path stays a 200 and the corrupt bytes are left untouched.
  const mutationLocked = codexAccountsMutationLocked();
  const login = new Map<string, Awaited<ReturnType<ReturnType<typeof managedCodexRuntime>["loginSnapshot"]>>>();
  const listed = listCodexAccounts();
  for (const account of listed) {
    if (account.kind === "managed") {
      // Managed logins have no tmux owner. Clear a pre-migration pane record
      // without probing tmux so every managed route stays app-server-only.
      if (account.loginPane && !mutationLocked) setCodexAccountLoginPane(account.id, null);
      login.set(account.id, await managedCodexRuntime().loginSnapshot(account));
      continue;
    }
    if (!account.loginPane) {
      login.set(account.id, { state: account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null });
      continue;
    }
    // Compatibility adapter for device-login panes created before the
    // app-server migration. Newly managed accounts never enter this branch.
    const pane = account.loginPane ? await paneInfo(account.loginPane.paneId) : null;
    const status = codexLoginPaneStatus(account.authPresent, account.loginPane, pane);
    if (status.clear && !mutationLocked) setCodexAccountLoginPane(account.id, null);
    const deviceAuth = status.state === "pending" && pane && account.loginPane ? deviceAuthChallenge(await paneScreen(account.loginPane.paneId)) : null;
    login.set(account.id, { state: status.state, attemptState: null, deviceAuth });
  }
  const accounts = listed.map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    loginPending: login.get(account.id)?.state === "pending",
    loginState: login.get(account.id)?.state ?? "idle",
    attemptState: login.get(account.id)?.attemptState ?? null,
    deviceAuth: login.get(account.id)?.deviceAuth ?? null,
  }));
  const claudeAccounts = listClaudeAccounts().map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    auth: { state: account.authPresent ? "authenticated" : "signed_out", method: null, email: null, plan: null, checkedAt: null },
    limits: { state: "unavailable", session: null, weekly: null, checkedAt: null },
    login: claudeLoginSupervisor.forAccount(account.id),
  }));
  const registry = agentRegistry();
  const snapshot = registry.snapshot();
  const migration = (engine: "claude" | "codex") => Object.values(snapshot.migrationIntents).find((intent) => intent.engine === engine && intent.state === "draining") ?? null;
  return NextResponse.json({
    codex: { active: activeCodexAccountId(), accounts, migration: migration("codex"), autoBalance: registry.autoBalancePolicy("codex") },
    // A corrupt Claude registry keeps the compatible Codex response available and
    // reduces Claude to immutable legacy Main until an operator repairs it.
    claude: { active: activeClaudeAccountId(), accounts: claudeAccounts, mutationLocked: claudeAccountsMutationLocked(), migration: migration("claude"), autoBalance: registry.autoBalancePolicy("claude") },
    migration: { codex: migration("codex"), claude: migration("claude") },
    autoBalance: { codex: registry.autoBalancePolicy("codex"), claude: registry.autoBalancePolicy("claude") },
  });
}
