import fs from "node:fs";

export interface CanonicalMirrorOptions {
  deploymentDir: string;
  mirrorDir: string;
  remote: string;
}

export interface CanonicalMirrorDependencies {
  run(argv: string[]): Promise<string>;
}

async function isValidBareMirror(directory: string, run: CanonicalMirrorDependencies["run"]): Promise<boolean> {
  try {
    return (await run(["git", "--git-dir", directory, "rev-parse", "--is-bare-repository"])).trim() === "true";
  } catch {
    return false;
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function ensureCanonicalMirror(
  options: CanonicalMirrorOptions,
  dependencies: CanonicalMirrorDependencies,
): Promise<void> {
  fs.mkdirSync(options.deploymentDir, { recursive: true, mode: 0o700 });
  const incomingDir = `${options.mirrorDir}.incoming`;
  if (!await isValidBareMirror(options.mirrorDir, dependencies.run)) {
    fs.rmSync(options.mirrorDir, { recursive: true, force: true });
    fs.rmSync(incomingDir, { recursive: true, force: true });
    await dependencies.run(["git", "clone", "--mirror", options.remote, incomingDir]);
    if (!await isValidBareMirror(incomingDir, dependencies.run)) throw new Error("canonical mirror clone is invalid");
    fs.renameSync(incomingDir, options.mirrorDir);
    syncDirectory(options.deploymentDir);
  } else {
    fs.rmSync(incomingDir, { recursive: true, force: true });
  }
  await dependencies.run(["git", "--git-dir", options.mirrorDir, "remote", "set-url", "origin", options.remote]);
  await dependencies.run(["git", "--git-dir", options.mirrorDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
}
