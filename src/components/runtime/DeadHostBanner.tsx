"use client";

import { useState } from "react";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Loader2, Play, SquareTerminal } from "@/components/icons";
import { AttachTerminalDialog } from "@/components/AttachTerminalDialog";
import { useLocale, type TFunction } from "@/lib/i18n";
import { fmtAge } from "@/components/utils";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { SNAPSHOT_URL } from "@/hooks/runtimeBus";

/** The host axis is dead (or fell unhosted after a crash) — the banner owns
    recovery, so the stale permission cards and the composer stand down (§5). */
export function isDeadHostSession(rv: RuntimeSessionView | null): boolean {
  if (!rv || rv.legacy) return false;
  return rv.session.host === "dead" || rv.session.host === "unhosted";
}

export interface DeadHostBannerViewProps {
  t: TFunction;
  sinceLabel: string;
  onRespawn: () => void;
  onAttach: () => void;
  onRecheck: () => void;
  respawnBusy?: boolean;
  recheckBusy?: boolean;
}

/**
 * One pane-level banner shown whenever the runtime host died (issue #247 item
 * 1). Replaces the stale-card / badge-spam experience with a single clear
 * statement of what died and when, plus the three recovery affordances. Pure so
 * the actions and tone are DOM-tested; sits in the `MigrationRibbon` slot family
 * between the header and the feed.
 */
export function DeadHostBannerView({
  t,
  sinceLabel,
  onRespawn,
  onAttach,
  onRecheck,
  respawnBusy = false,
  recheckBusy = false,
}: DeadHostBannerViewProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-dead-host-banner
      className="flex shrink-0 flex-col gap-1.5 border-b border-danger/45 bg-danger-soft px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-label font-bold text-danger">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("deadHost.title", { since: sinceLabel })}</span>
      </div>
      <p className="text-caption font-semibold text-secondary">{t("deadHost.body")}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onRespawn}
          disabled={respawnBusy}
          className="inline-flex min-h-11 items-center gap-1 rounded-control border border-accent bg-accent px-2.5 text-label font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-60 sm:min-h-8"
        >
          {respawnBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          {t("deadHost.respawn")}
        </button>
        <button
          type="button"
          onClick={onAttach}
          className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-canvas px-2.5 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-8"
        >
          <SquareTerminal className="h-3.5 w-3.5" aria-hidden /> {t("deadHost.attach")}
        </button>
        <button
          type="button"
          onClick={onRecheck}
          disabled={recheckBusy}
          className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-canvas px-2.5 text-label font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 sm:min-h-8"
        >
          {recheckBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
          {t("deadHost.recheck")}
        </button>
      </div>
    </div>
  );
}

/** Container wiring the dead-host recovery actions for a conversation. */
export function DeadHostBanner({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const [attachOpen, setAttachOpen] = useState(false);
  const [respawnBusy, setRespawnBusy] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);

  const respawn = async () => {
    if (respawnBusy) return;
    setRespawnBusy(true);
    try {
      await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", path: file.path }),
      });
    } catch {
      /* the resume boots asynchronously; the recovering axis clears the banner */
    } finally {
      setRespawnBusy(false);
    }
  };

  const recheck = async () => {
    if (recheckBusy) return;
    setRecheckBusy(true);
    try {
      // Force a fresh runtime snapshot; a recovered host flips the axis and the
      // bus's own projection clears this banner.
      await fetch(SNAPSHOT_URL, { headers: { "Cache-Control": "no-store" } });
    } catch {
      /* offline — the bus keeps retrying on its own cadence */
    } finally {
      setRecheckBusy(false);
    }
  };

  return (
    <>
      <DeadHostBannerView
        t={t}
        sinceLabel={fmtAge(file.mtime)}
        onRespawn={() => void respawn()}
        onAttach={() => setAttachOpen(true)}
        onRecheck={() => void recheck()}
        respawnBusy={respawnBusy}
        recheckBusy={recheckBusy}
      />
      {attachOpen ? <AttachTerminalDialog file={file} onClose={() => setAttachOpen(false)} /> : null}
    </>
  );
}
