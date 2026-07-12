"use client";

import { Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

import { tr } from "./parse";

let activeStop: (() => void) | null = null;
let availabilityPromise: Promise<boolean> | null = null;

function ttsAvailable(): Promise<boolean> {
  availabilityPromise ??= fetch("/api/tts")
    .then((response) => response.json() as Promise<{ available?: unknown }>)
    .then((info) => info.available === true)
    .catch(() => false);
  return availabilityPromise;
}

function stopActive(): void {
  const stop = activeStop;
  activeStop = null;
  stop?.();
}

export function SpeakButton({ text }: { text: string }) {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const generation = useRef(0);
  const mounted = useRef(true);
  const ownedStop = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void ttsAvailable().then((value) => { if (current) setAvailable(value); });
    return () => {
      current = false;
      mounted.current = false;
      generation.current += 1;
      if (activeStop === ownedStop.current) stopActive();
    };
  }, []);

  if (!available || !text) return null;

  const start = async () => {
    stopActive();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      controller.abort();
      audio?.pause();
      if (url) URL.revokeObjectURL(url);
      if (activeStop === cleanup) activeStop = null;
      if (ownedStop.current === cleanup) ownedStop.current = null;
      if (mounted.current && generation.current === currentGeneration) setPhase("idle");
    };
    ownedStop.current = cleanup;
    activeStop = cleanup;
    setPhase("loading");

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, MAX_TTS_TEXT_LENGTH) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TTS request failed: ${response.status}`);
      const blob = await response.blob();
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setPhase("playing");
      await audio.play();
    } catch {
      cleanup();
    }
  };

  const toggle = () => {
    if (ownedStop.current) {
      ownedStop.current();
      return;
    }
    void start();
  };

  const active = phase !== "idle";
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-md p-1 text-dim opacity-0 transition-opacity hover:bg-chip hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60"
      aria-label={active ? tr("feed.stopSpeaking") : tr("feed.speak")}
      title={active ? tr("feed.stopSpeaking") : tr("feed.speak")}
    >
      {active ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
