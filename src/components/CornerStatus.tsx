"use client";

import { useEffect, useRef, useState } from "react";

import type { SwitchboardData } from "@/hooks/useSwitchboardData";

interface Props {
  data: SwitchboardData;
  onOpen: () => void;
}

/**
 * Collapsed pill in the corner so it stops covering feed content; the live
 * preview list appears on hover/focus only. Click opens the switchboard.
 */
export function CornerStatus({ data, onOpen }: Props) {
  const waitingCount = data.waiting.length;
  const prevWaiting = useRef(waitingCount);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (waitingCount > prevWaiting.current) {
      setPulse(true);
      const timer = window.setTimeout(() => setPulse(false), 900);
      prevWaiting.current = waitingCount;
      return () => window.clearTimeout(timer);
    }
    prevWaiting.current = waitingCount;
  }, [waitingCount]);

  return (
    <div className="group absolute bottom-3 right-3 z-20">
      {data.livePreview.length ? (
        <div className="pointer-events-none mb-1.5 hidden w-[300px] rounded-[8px] border border-line bg-panel/95 px-3 py-2 shadow-card backdrop-blur group-focus-within:block group-hover:block">
          {data.livePreview.map((item) => (
            <div key={item.file.path} className="flex min-w-0 gap-1.5 py-0.5 text-[10.5px]">
              <span className="min-w-0 flex-1 truncate font-semibold">{item.title}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{item.statusLine || "працює…"}</span>
            </div>
          ))}
        </div>
      ) : null}
      <button
        className={`ml-auto flex items-center gap-1.5 rounded-full border border-line bg-panel/95 px-2.5 py-1 text-[11.5px] font-bold shadow-card backdrop-blur transition-transform hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          pulse ? "scale-110 border-[#e0ae45]/70" : ""
        } motion-reduce:transition-none`}
        aria-label="Відкрити пульт агентів"
        onClick={onOpen}
      >
        <span className={`h-2 w-2 rounded-full ${data.working.length ? "animate-pulse bg-ok" : "bg-dim"}`} />
        <span>{data.working.length}</span>
        <span className={waitingCount ? "text-[#b8860b]" : "text-dim"}>· {waitingCount} чекають</span>
      </button>
    </div>
  );
}
