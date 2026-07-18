import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

export const SPAWN_NESTING_SCHEMA_VERSION = 1;

/** Conservative default (#393): operator roots at depth 0, their delegates at
    depth 1, and one more helper generation at depth 2. */
export const DEFAULT_MAX_AGENT_NESTING_DEPTH = 2;
export const MIN_AGENT_NESTING_DEPTH = 1;
export const MAX_AGENT_NESTING_DEPTH = 4;

export interface SpawnNestingPolicy {
  maxAgentNestingDepth: number;
}

interface SpawnNestingPolicyFile extends SpawnNestingPolicy {
  schemaVersion: typeof SPAWN_NESTING_SCHEMA_VERSION;
}

const policyFile = () => statePath("spawn-nesting.json");

export function validMaxAgentNestingDepth(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= MIN_AGENT_NESTING_DEPTH
    && (value as number) <= MAX_AGENT_NESTING_DEPTH;
}

/** Durable nesting ceiling. An absent or corrupt file degrades to the
    default so admission never fails open on depth or blocks on policy IO. */
export function loadSpawnNestingPolicy(): SpawnNestingPolicy {
  let text: string;
  try {
    text = fs.readFileSync(policyFile(), "utf8");
  } catch {
    return { maxAgentNestingDepth: DEFAULT_MAX_AGENT_NESTING_DEPTH };
  }
  try {
    const raw = JSON.parse(text) as Partial<SpawnNestingPolicyFile>;
    if (raw.schemaVersion === SPAWN_NESTING_SCHEMA_VERSION && validMaxAgentNestingDepth(raw.maxAgentNestingDepth)) {
      return { maxAgentNestingDepth: raw.maxAgentNestingDepth };
    }
  } catch { /* corrupt policy degrades to the default below */ }
  return { maxAgentNestingDepth: DEFAULT_MAX_AGENT_NESTING_DEPTH };
}

export function saveSpawnNestingPolicy(policy: SpawnNestingPolicy): void {
  if (!validMaxAgentNestingDepth(policy.maxAgentNestingDepth)) {
    throw new Error(`maxAgentNestingDepth must be an integer between ${MIN_AGENT_NESTING_DEPTH} and ${MAX_AGENT_NESTING_DEPTH}`);
  }
  const target = policyFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  const file: SpawnNestingPolicyFile = {
    schemaVersion: SPAWN_NESTING_SCHEMA_VERSION,
    maxAgentNestingDepth: policy.maxAgentNestingDepth,
  };
  fs.writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(temp, target);
}
