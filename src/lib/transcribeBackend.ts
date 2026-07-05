import fs from "node:fs";

import { configFilePath } from "@/lib/configDir";

export type TranscribeBackend = "local" | "chatgpt" | "elevenlabs";

/**
 * Which transcription path handles dictation. The default is the fully local
 * faster-whisper engine, which carries no third-party terms. The cloud paths
 * (ChatGPT, ElevenLabs Scribe) exist but stay off the UI: each turns on only
 * for whoever sets `LLV_TRANSCRIBE_BACKEND` or writes the backend name into
 * the override file, so it is opt-in per machine rather than a visible toggle.
 */
export function resolveTranscribeBackend(): TranscribeBackend {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  if (env === "chatgpt" || env === "local" || env === "elevenlabs") return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("transcribe-backend"), "utf8").trim().toLowerCase();
    if (fileValue === "chatgpt" || fileValue === "elevenlabs") return fileValue;
  } catch {
    /* no override file: stay on the local default */
  }
  return "local";
}

/** Read at request time so a key drop-in works without a server restart. */
export function readElevenLabsApiKey(): string | null {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("elevenlabs-api-key"), "utf8").trim();
    return fileValue || null;
  } catch {
    return null;
  }
}
