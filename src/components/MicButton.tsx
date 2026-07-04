"use client";

import { Loader2, Mic, X } from "@/components/icons";
import { fmtElapsed, METER_HEIGHT, METER_WIDTH, type UseDictationResult } from "@/hooks/useDictation";

export interface MicButtonViewProps extends UseDictationResult {
  onText: (text: string) => void;
  /** Extra external busy flag (e.g. a caller mid stop-and-send) that blocks
      starting a new recording on top of the hook's own "busy" phase. */
  busy?: boolean;
}

/**
 * Presentational dictation control driven by a `useDictation` instance handed
 * down by the caller, so a composer that orchestrates its own send button
 * around the same recording (see TmuxComposer) shares one hook instance.
 */
export function MicButtonView({ phase, elapsed, canvasRef, start, stop, discard, onText, busy = false }: MicButtonViewProps) {
  const handleMain = () => {
    if (busy) return;
    if (phase === "idle") void start();
    else if (phase === "rec") {
      void stop().then((text) => {
        if (text) onText(text);
      });
    }
  };

  if (phase === "rec") {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Зупинити запис і розпізнати"
          onClick={handleMain}
          className="flex items-center gap-1.5 rounded-[8px] border border-err/50 bg-[#fff2f2] px-2 py-2 text-[11px] font-bold text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/40"
        >
          <canvas ref={canvasRef} width={METER_WIDTH} height={METER_HEIGHT} className="h-4 w-14" aria-hidden />
          {fmtElapsed(elapsed)}
        </button>
        <button
          type="button"
          aria-label="Скасувати запис"
          onClick={discard}
          className="inline-flex items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={phase === "busy" ? "Розпізнаю…" : "Надиктувати"}
      title={phase === "busy" ? "розпізнаю…" : "надиктувати (до 2 хв)"}
      disabled={phase === "busy" || busy}
      onClick={handleMain}
      className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
    >
      {phase === "busy" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
    </button>
  );
}
