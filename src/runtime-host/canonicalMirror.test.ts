import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCanonicalMirror } from "./canonicalMirror";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("restart replaces an interrupted initial clone with a validated mirror", async () => {
  const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-canonical-mirror-"));
  sandboxes.push(deploymentDir);
  const mirrorDir = path.join(deploymentDir, "canonical.git");
  const incomingDir = `${mirrorDir}.incoming`;
  const validMirrors = new Set<string>();
  const calls: string[][] = [];
  let cloneAttempts = 0;
  const run = async (argv: string[]): Promise<string> => {
    calls.push(argv);
    if (argv[0] === "git" && argv[1] === "clone") {
      cloneAttempts += 1;
      const destination = argv.at(-1)!;
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, cloneAttempts === 1 ? "partial" : "HEAD"), "fixture");
      if (cloneAttempts === 1) throw new Error("clone interrupted");
      validMirrors.add(destination);
      return "";
    }
    if (argv.includes("rev-parse")) {
      const gitDir = argv[argv.indexOf("--git-dir") + 1]!;
      if (!validMirrors.has(gitDir)) throw new Error("invalid bare repository");
      return "true";
    }
    return "";
  };

  await expect(ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run })).rejects.toThrow("clone interrupted");
  expect(fs.existsSync(mirrorDir)).toBe(false);
  expect(fs.existsSync(path.join(incomingDir, "partial"))).toBe(true);

  await ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run });

  expect(cloneAttempts).toBe(2);
  expect(fs.existsSync(path.join(mirrorDir, "HEAD"))).toBe(true);
  expect(fs.existsSync(incomingDir)).toBe(false);
  expect(calls.some((argv) => argv.includes("set-url"))).toBe(true);
  expect(calls.some((argv) => argv.includes("fetch"))).toBe(true);
});
