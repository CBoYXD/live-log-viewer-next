import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** App dir that matches the npm package name; new installs land here. */
const APP_DIR = "agent-log-viewer";
/** Former app dir, still honored as a fallback so existing setups keep working. */
const LEGACY_APP_DIR = "live-log-viewer";

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

/**
 * Resolve a config file under the app dir at call time: the agent-log-viewer
 * copy wins, and the legacy live-log-viewer copy is returned only when it is
 * the one that exists. Callers read the returned path and treat a missing file
 * as "no override", so falling through to the (possibly absent) new path is safe.
 */
export function configFilePath(name: string): string {
  return resolveWithFallback(configRoot(), name);
}

/**
 * Resolve a cache entry (file or dir) under the app dir with the same
 * agent-log-viewer-first, legacy-fallback logic as {@link configFilePath}.
 */
export function cacheEntryPath(name: string): string {
  return resolveWithFallback(cacheRoot(), name);
}

function resolveWithFallback(root: string, name: string): string {
  const preferred = path.join(root, APP_DIR, name);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, LEGACY_APP_DIR, name);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}
