import { cp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const nextBin = join(root, "node_modules", ".bin", "next");
const standaloneDir = join(root, ".next", "standalone");
const staticDir = join(root, ".next", "static");
const distDir = join(root, "dist");
const distStandaloneDir = join(distDir, "standalone");

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(nextBin, ["build", "--webpack"], {
      cwd: root,
      env: { ...process.env, LLV_STANDALONE: "1" },
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${nextBin}: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Standalone build failed after signal ${signal}.`
            : `Standalone build failed with exit code ${code}.`,
        ),
      );
    });
  });
}

async function findStandaloneServer(dir) {
  const directServer = join(dir, "server.js");
  if (existsSync(directServer)) {
    return dir;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }

    const found = await findStandaloneServer(join(dir, entry.name));
    if (found) {
      return found;
    }
  }

  return null;
}

async function main() {
  await runNextBuild();

  const appStandaloneDir = await findStandaloneServer(standaloneDir);
  if (!appStandaloneDir) {
    throw new Error("Standalone build did not produce .next/standalone/server.js.");
  }

  await rm(distDir, { recursive: true, force: true });
  await cp(standaloneDir, distStandaloneDir, { recursive: true });
  if (appStandaloneDir !== standaloneDir) {
    await cp(appStandaloneDir, distStandaloneDir, { recursive: true });
    await rm(join(distStandaloneDir, ".claude"), { recursive: true, force: true });
  }
  await cp(staticDir, join(distStandaloneDir, ".next", "static"), { recursive: true });

  if (!existsSync(join(distStandaloneDir, "server.js"))) {
    throw new Error("Prepack did not produce dist/standalone/server.js.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
