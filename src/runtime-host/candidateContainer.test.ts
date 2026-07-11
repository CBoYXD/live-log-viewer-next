import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runtimeEventsEnabled, runtimeHostSocket } from "@/lib/runtime/flags";

import {
  obsoleteManagedViewerContainers,
  viewerCandidateDockerArgs,
  viewerCandidateTmuxEnvironment,
  viewerComposeServiceFromConfig,
  type ViewerComposeService,
} from "./candidateContainer";

const candidate = {
  revision: "a".repeat(40),
  image: `agent-log-viewer:deploy-${"a".repeat(40)}`,
  container: "llv-deploy-candidate",
  endpoint: "http://127.0.0.1:18001",
};

const composeService = {
  build: { context: "/source", dockerfile: "Dockerfile" },
  command: null,
  entrypoint: null,
  environment: {
    HOME: "/home/latand",
    HOSTNAME: "127.0.0.1",
    PORT: "8898",
    LLV_RUNTIME_EVENTS: "0",
    LLV_RUNTIME_HOST_SOCKET: "/compose/runtime.sock",
    LLV_LEGACY_TMUX_EXTERNAL: "0",
    TMUX_TMPDIR: "/tmp",
    LLV_DOCKER_NSENTER_SHIMS: "1",
    LLV_TRANSCRIBE_BACKEND: "chatgpt",
    HF_HOME: "/home/latand/.cache/huggingface",
    GIT_SSH_COMMAND: "ssh compose-config",
  },
  image: "agent-log-viewer:node22",
  labels: { "compose.viewer": "production" },
  network_mode: "host",
  pid: "host",
  privileged: true,
  restart: "unless-stopped",
  user: "1000:1000",
  volumes: [
    { type: "bind", source: "/home/latand", target: "/home/latand", bind: {} },
    { type: "bind", source: "/tmp/tmux-1000", target: "/tmp/tmux-1000", bind: {} },
  ],
  working_dir: "/app",
} satisfies ViewerComposeService;

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}

function environmentFromArgs(args: string[]): Record<string, string> {
  return Object.fromEntries(valuesAfter(args, "-e").map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

test("promoted candidate derives its runtime contract from Compose", () => {
  const args = viewerCandidateDockerArgs(candidate, composeService, {
    runtimeSocket: "/state/runtime-host.sock",
    legacyTmuxExternal: "1",
    tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  });
  const environment = environmentFromArgs(args);

  expect(runtimeEventsEnabled(environment as NodeJS.ProcessEnv)).toBe(true);
  expect(runtimeHostSocket(environment as NodeJS.ProcessEnv)).toBe("/state/runtime-host.sock");
  expect(environment.LLV_LEGACY_TMUX_EXTERNAL).toBe("1");
  expect(environment.TMUX_TMPDIR).toBe("/run/user/1000/agent-log-viewer");
  expect(environment.HF_HOME).toBe("/home/latand/.cache/huggingface");
  expect(environment.LLV_TRANSCRIBE_BACKEND).toBe("chatgpt");
  expect(environment.LLV_DOCKER_NSENTER_SHIMS).toBe("1");
  expect(environment.GIT_SSH_COMMAND).toBe("ssh compose-config");
  expect(valuesAfter(args, "--label")).toEqual([
    "compose.viewer=production",
    "dev.live-log-viewer.managed=1",
    `dev.live-log-viewer.revision=${candidate.revision}`,
  ]);
  expect(valuesAfter(args, "--mount")).toEqual([
    "type=bind,source=/home/latand,target=/home/latand",
    "type=bind,source=/tmp/tmux-1000,target=/tmp/tmux-1000",
  ]);
  expect(args[args.indexOf("--restart") + 1]).toBe("unless-stopped");
  expect(args[args.indexOf("--network") + 1]).toBe("host");
  expect(args[args.indexOf("--pid") + 1]).toBe("host");
  expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
  expect(args[args.indexOf("--workdir") + 1]).toBe("/app");
  expect(args).toContain("--privileged");
});

test("actual Viewer Compose keys remain covered by the candidate generator", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-compose-parity-"));
  const envFile = path.join(fixtureDir, "service.env");
  fs.writeFileSync(envFile, "");
  const config = Bun.spawnSync(["docker", "compose", "config", "--format", "json"], {
    cwd: process.cwd(),
    env: { ...process.env, LLV_ENV_FILE: envFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  expect(config.exitCode).toBe(0);
  const service = viewerComposeServiceFromConfig(config.stdout.toString());
  const args = viewerCandidateDockerArgs(candidate, service, {
    runtimeSocket: "/state/runtime-host.sock",
    legacyTmuxExternal: "1",
    tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  });
  const environment = environmentFromArgs(args);
  expect(Object.keys(environment).sort()).toEqual([
    ...new Set([...Object.keys(service.environment), "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET"]),
  ].sort());
  expect(valuesAfter(args, "--mount")).toHaveLength(service.volumes.length);
  expect(args[args.indexOf("--restart") + 1]).toBe(service.restart);
  expect(valuesAfter(args, "--label").map((label) => label.split("=", 1)[0]).sort()).toEqual([
    ...Object.keys(service.labels),
    "dev.live-log-viewer.managed",
    "dev.live-log-viewer.revision",
  ].sort());
});

test("candidate tmux environment follows the durable migration marker", () => {
  const checked: string[] = [];
  expect(viewerCandidateTmuxEnvironment("/state", "1000", (filename) => {
    checked.push(filename);
    return true;
  })).toEqual({ legacyTmuxExternal: "1", tmuxTmpdir: "/run/user/1000/agent-log-viewer" });
  expect(checked).toEqual(["/state/legacy-tmux-migration-complete"]);

  expect(viewerCandidateTmuxEnvironment("/state", "1000", () => false)).toEqual({
    legacyTmuxExternal: "0",
    tmuxTmpdir: "/tmp",
  });
});

test("container retention keeps the serving and immediate rollback releases", () => {
  expect(obsoleteManagedViewerContainers(
    ["viewer-current", "viewer-rollback", "viewer-old-a", "viewer-old-b"],
    ["viewer-current", "viewer-rollback"],
  )).toEqual(["viewer-old-a", "viewer-old-b"]);
});
