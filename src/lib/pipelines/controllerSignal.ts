type PipelineTick = () => Promise<void>;

interface PipelineSignalState {
  tick: PipelineTick | null;
  scheduled: boolean;
}

const signalHost = globalThis as typeof globalThis & {
  __llvPipelineSignal?: PipelineSignalState;
};

const signal = signalHost.__llvPipelineSignal ??= { tick: null, scheduled: false };

export function registerPipelineTick(tick: PipelineTick): () => void {
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = null;
  };
}

export function requestPipelineTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch(() => {
      console.error("[pipeline controller] requested tick failed");
    });
  });
}
