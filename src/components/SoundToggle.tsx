"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

import { chime, setSoundEnabled, soundEnabled } from "@/lib/chime";

/** Header switch for the finish-chimes; turning it on plays a preview note. */
export function SoundToggle() {
  const [on, setOn] = useState(true);
  /* localStorage is client-only: read after mount to keep hydration clean. */
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOn(soundEnabled()), []);
  const toggle = () => {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    if (next) chime("returned", 0);
  };
  return (
    <button
      className="ml-auto inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-line bg-panel text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title={on ? "Звукові сповіщення увімкнено" : "Звукові сповіщення вимкнено"}
      aria-label={on ? "Вимкнути звукові сповіщення" : "Увімкнути звукові сповіщення"}
      aria-pressed={on}
      onClick={toggle}
    >
      {on ? <Volume2 className="h-3.5 w-3.5" aria-hidden /> : <VolumeX className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
