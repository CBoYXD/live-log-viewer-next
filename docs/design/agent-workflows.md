# Agent workflows: task → staged implementers → review loop → PR

Status: **final, user-grilled 2026-07-05** (8 interview decisions W1–W8, plus
engine-derived decisions W9–W12). Companion design:
`docs/design/attention-queue.md` (the attention queue surfaces workflow agents
like any other conversation; no coupling between the two features).

## Problem

The flow engine (`src/lib/flows/*`) already runs the hardest part of the
loop: a long-lived implementer, a fresh reviewer per round, the
`REVIEW_READY:` marker protocol, verdict artifacts, automatic findings relay.
Starting real work is still manual orchestration: someone creates the
worktree, spawns the implementer with a hand-written prompt, then attaches a
flow — and the shape is fixed to exactly one implementer.

The feature: a **workflow** — a reusable named pipeline that takes a task
brief and runs end to end: provision a worktree → implement stages (each
owned by a chosen agent: «бекенд — Codex xhigh», «UI — Fable») → review loop
with a dedicated cheap fixer → finish with a PR (or auto-merge). Launched as
one action, composable from stages.

## What exists to build on (verified in code)

- `Flow` state machine with `tickFlows()` polling, headless/pane reviewers,
  round artifacts, findings relay (`src/lib/flows/engine.ts`, `exec.ts`).
- Role config `{engine, model, effort}` + presets
  (`~/.config/agent-log-viewer/state/review-loop-presets.json`, `store.ts`).
- Agent boot specs with model/effort/read-only options (`freshSpecFor` in
  `src/lib/agent/cli.ts`), pane spawn + verified prompt paste
  (`spawnAgentWithPrompt` in `src/lib/tmux.ts`), delivery ladder
  (`src/lib/delivery.ts`), handoff lineage for board parentage.
- Marker detection at the transcript tail (the `REVIEW_READY:` scanner path).

## Decisions

**W1 — Pipeline shape: an ordered stage list with a barrier after each
stage.** A stage is either `implement` or the closing `review-loop`; a
template composes any number of them linearly. *Why:* with one agent per
stage a DAG buys nothing and costs a scheduler; a single hardcoded shape
would kill the «складати з етапів» requirement. Linear covers every wanted
template today.

**W2 — One implementer per stage; parallel agents are out of v1.** The
«фронт + бек» template is two sequential stages, each with its own agent and
scope. *Why:* user decision — sequential is predictable, and two agents in
one worktree need ownership machinery that can wait until the linear version
proves itself.

**W3 — Worktree provisioning by the engine.** `git worktree add` at
`<repoDir>/../<repo>-wf-<id>`, branch `wf/<slug>`; the template carries an
optional `setup` command (e.g. `bun install`) that runs before the first
agent boots; a failing setup parks the workflow in `needs_decision`. The
engine never deletes a worktree — removal is always manual. *Why:* the
sibling-worktree pattern is how this machine already works (verified by hand
with the attention-queue run); an explicit setup step removes the «агент
5 хвилин зʼясовує, чому bun test падає» tax.

**W4 — Stage completion = `STAGE_DONE: <one-line note>` marker.** Same
tail-scanner discipline as `REVIEW_READY:`; the note travels to the next
stage's kickoff (the backend agent tells the UI agent where the contract
lives). Manual `advance` stays available as the override in manual mode.
*Why:* turn-state heuristics misfire exactly the way the activity scanner's
history shows («закінчив хід» ≠ «зробив роботу»); the marker is an explicit,
already-taught grammar.

**W5 — A dedicated fixer role: always Codex, reasoning effort `low`.**
Implement stages get whatever expensive brains the template names; when the
review stage starts, the engine spawns a **fresh codex-low session in the
worktree** and binds the Flow to it as the implementer. Its kickoff carries
the task brief, every stage's `STAGE_DONE` note, and the FIXED/REJECTED
protocol. Template field `fixer: RoleConfig` with the hard default
`{engine: "codex", model: null, effort: "low"}`. *Why:* user decision —
implementers must vary per template, the fixer must always be codex low:
cheap fast hands for applying findings, expensive models for building and
reviewing.

**W6 — Launch surface: a «+ Воркфлоу» draft card on the scheme +
`POST /api/workflows`.** The card is a sibling of «+ Агент»: template picker,
repo directory, task textarea. The API exists first-class so an orchestrator
agent can launch workflows too. On the board a workflow renders through
existing primitives: agent panes with lineage arrows, the flow strip on the
review stage. *Why:* the draft-card pattern (`DraftAgentPane`) already
exists; UI stays a thin wrapper over the API the engine needs anyway.

**W7 — Finish stage: always present, configurable action — `pr` (default)
or `merge`.** After the review flow reaches `approved`, the engine runs the
finish action: `pr` pushes `wf/<slug>` and runs `gh pr create` (body = task
brief + stage notes + rounds summary, ends with the repo's PR footer
convention); `merge` merges the branch into the repo's base branch locally,
without pushing. Failures (push rejected, `gh` missing/unauthenticated,
merge conflict) park the workflow in `needs_decision` with the error as
`stateDetail`. *Why:* user decision — «завжди в кінці PR», with auto-merge
as the selectable alternative for low-ceremony repos.

**W8 — Templates live in `~/.config/agent-log-viewer/state/workflow-templates.json`.**
Same pattern as flow presets: the picker lists them, editing happens in the
file (by hand or by an agent); a CRUD editor UI is deferred. *Why:* templates
change rarely; the daily surface is picker + task textarea. File schema below.

**W9 — The review stage is a normal `Flow`.** The workflow engine creates it
through the existing `createFlowFromRequest` path with `implementerPath` =
the fixer's transcript, `baseRef` = the workflow branch start (`baseMode:
"head"` resolved in the worktree at provisioning time — captured once and
stored on the workflow, so the flow reviews the whole workflow diff),
reviewer = the template's reviewer role, and the template's `roundLimit`
(default 5) and `reviewerMode` (default headless). The workflow watches the
flow's terminal state to advance. *Why:* zero duplication of the hardest
machinery; the Flow contract already expresses everything the review stage
needs.

**W10 — Failure semantics mirror flows.** Any stage error — worktree/setup
failure, agent pane died before `STAGE_DONE`, embedded flow landed in
`needs_decision`, round limit exhausted with `commented`, finish action
failed — parks the workflow in `needs_decision` with `stateDetail`. PATCH
actions: `pause`, `resume`, `advance` (skip to next stage / force-complete
current), `retry-stage`, `close`. Close also closes the embedded flow (which
stops a running reviewer) and leaves panes and the worktree in place for
inspection. Mode `auto`/`manual` mirrors flows: manual inserts a
confirmation gate at every stage boundary.

**W11 — Engine placement: `src/lib/workflows/*`.** `types.ts` (contract),
`store.ts` (`workflows.json` + templates, same atomic-write pattern),
`engine.ts` (`tickWorkflows(entries)` called beside `tickFlows()` on the same
poll), `provision.ts` (worktree/setup/finish git+gh actions, injectable exec
for tests), `prompts.ts` (stage/fixer kickoff builders). Pure logic split
from I/O the way `flows/*` already does it, so `bun test` covers the state
machine without tmux.

**W12 — Kickoff prompts are English, composed per stage.** Stage kickoff =
workflow task brief + this stage's `scope` + prior stages' `STAGE_DONE` notes
+ the `STAGE_DONE:` marker instruction (mirroring `kickoffPrompt()`'s
«never quote the marker» phrasing). Fixer kickoff additionally carries the
FIXED/REJECTED protocol. Verification duties (build/test green before the
marker) are stated in the stage kickoff, tailored by the template's optional
`verify` command hint.

## Model

```ts
// src/lib/workflows/types.ts
export type WorkflowStageKind = "implement" | "review-loop";

export type ImplementStage = {
  kind: "implement";
  agent: RoleConfig;          // engine/model/effort, e.g. claude "fable"
  scope: string;              // role brief: "UI/frontend", "backend/API"
};

export type ReviewStage = {
  kind: "review-loop";
  reviewer: RoleConfig;
  fixer: RoleConfig;          // default {engine:"codex", model:null, effort:"low"}
  roundLimit: number;         // default 5
  reviewerMode: "headless" | "pane"; // default "headless"
};

export type FinishAction = "pr" | "merge";

export type WorkflowTemplate = {
  name: string;
  stages: (ImplementStage | ReviewStage)[]; // implement+, then review-loop last
  finish: FinishAction;       // default "pr"
  setup?: string;             // e.g. "bun install"
  verify?: string;            // hint for stage kickoffs, e.g. "bun test && bun run build"
};

export type WorkflowState =
  | "provisioning" | "implementing" | "reviewing" | "finishing"
  | "approved" | "needs_decision" | "paused" | "closed";

export type WorkflowStageRun = {
  index: number;
  agentPath: string | null;   // transcript once known
  paneId: string | null;
  startedAt: string | null;
  doneAt: string | null;
  doneNote: string | null;    // text after STAGE_DONE:
};

export type Workflow = {
  id: string;                 // short uuid slice, like flows
  name: string;               // template name or "ad-hoc"
  task: string;               // user's brief
  repoDir: string;
  worktreeDir: string;
  branch: string;             // wf/<slug>
  baseBranch: string;         // repoDir's branch at provisioning (merge/PR target)
  baseRef: string;            // sha at branch start
  template: WorkflowTemplate; // frozen copy at launch
  stageRuns: WorkflowStageRun[];
  stageIndex: number;
  flowId: string | null;      // embedded review Flow
  fixerPath: string | null;
  state: WorkflowState;
  pausedState: WorkflowState | null;
  stateDetail: string | null;
  mode: "auto" | "manual";
  prUrl: string | null;       // finish=pr result
  createdAt: string;
  closedAt: string | null;
};
```

API: `GET /api/workflows` (workflows + templates), `POST /api/workflows`
(`{template | stages…, task, repoDir, mode}`), `PATCH /api/workflows/<id>`
(`{action: pause|resume|advance|retry-stage|close, note?}`). All behind the
same-origin gate like flows.

## Example template (the user's canonical one)

```json
{
  "name": "fullstack",
  "setup": "bun install",
  "verify": "bun test && bun run build",
  "finish": "pr",
  "stages": [
    { "kind": "implement",
      "agent": { "engine": "codex", "model": null, "effort": "high" },
      "scope": "Backend/API: server logic, data layer, API routes. Leave UI components alone." },
    { "kind": "implement",
      "agent": { "engine": "claude", "model": "fable", "effort": null },
      "scope": "UI/frontend: components, hooks, styling, i18n labels. Build on the backend contract from the previous stage." },
    { "kind": "review-loop",
      "reviewer": { "engine": "codex", "model": null, "effort": "xhigh" },
      "fixer": { "engine": "codex", "model": null, "effort": "low" },
      "roundLimit": 5, "reviewerMode": "headless" }
  ]
}
```

## Lifecycle walkthrough

1. `POST /api/workflows` → `provisioning`: worktree add, `setup` runs,
   `baseRef`/`baseBranch` captured.
2. `implementing`, stage 0: spawn the stage agent in the worktree
   (`freshSpecFor` with the role's model/effort), paste kickoff, record
   lineage (parent = the workflow's creating conversation when known).
   Tail-scan for `STAGE_DONE:` → barrier → next stage; each later stage's
   kickoff includes prior notes.
3. After the last implement stage: spawn the fixer (codex low), wait for its
   transcript in the scanner, create the embedded Flow (W9) → `reviewing`.
   The flow runs its own rounds; the workflow just watches.
4. Flow `approved` → `finishing`: push + `gh pr create` (or local merge) →
   `approved` with `prUrl`.
5. Any failure at any step → `needs_decision` + `stateDetail`; PATCH actions
   per W10.

## Implementation plan (implementer in a separate git worktree)

Dependency note: the flows module currently has uncommitted WIP in the main
checkout (`flows/commands.ts`, `engine.ts`, `exec.ts`, `store.ts`,
`types.ts`, i18n). Branch the feature worktree only after that WIP lands, so
the workflow engine builds on the real flow contract.

1. **`src/lib/workflows/types.ts` + `store.ts` + tests** — the contract
   above; `workflows.json`/`workflow-templates.json` load/save with the
   atomic-write and globalThis-cache patterns from `flows/store.ts`. Tests:
   template validation (implement+ then one review-loop last; fixer default
   injection), round-trip persistence, frozen-template copy on launch.
2. **`provision.ts` + tests** — worktree add, setup exec, finish actions
   (push+`gh pr create`, local merge) over an injectable exec port (the
   `flows/exec.ts` testing pattern). Tests: command composition, error →
   `needs_decision` mapping, merge-conflict surfacing; no real git in unit
   tests, plus one integration test against a throwaway repo fixture.
3. **`prompts.ts` + tests** — stage kickoff (task + scope + prior notes +
   `STAGE_DONE:` instruction + verify hint), fixer kickoff (adds
   FIXED/REJECTED). Tests: note threading, marker-quoting rule preserved.
4. **`engine.ts` + tests** — `tickWorkflows(entries)`: state transitions per
   the walkthrough, `STAGE_DONE` tail detection (reuse the marker scanner),
   embedded-flow creation and terminal-state watching, pause/advance/
   retry-stage/close reducers. Tests: full happy path over fake entries and
   a stubbed flow layer; every `needs_decision` branch.
5. **API routes** — `src/app/api/workflows/route.ts` + `[id]/route.ts`,
   same-origin gated, thin adapters over commands (mirror
   `api/flows`).
6. **UI** — «+ Воркфлоу» draft card beside «+ Агент» (template picker, repo
   dir with the spawn-suggest endpoint, task textarea); workflow strip over
   the group (stage chips with state, `needs_decision` banner, PATCH
   buttons); uk+en i18n labels.
7. **Verification** — `bun test`, `bun run build`; live run: launch the
   `fullstack` template on a toy task in a scratch repo, watch stages hand
   off, review rounds run, PR appears; kill an agent mid-stage and confirm
   `needs_decision` + `retry-stage` recovers.

## Out of scope (v1)

- Parallel implementers inside one stage (W2) and merge stages across
  worktrees.
- DAG topologies; >1 review-loop stage per workflow.
- Template CRUD editor UI (file-edited per W8).
- Auto-merge to remote / pushing the base branch; `merge` acts locally only.
- Cost tracking, cron-triggered workflows, cross-repo workflows.
- Workflow-level notifications beyond what flows/attention surfaces already
  provide (the fixer's questions and the strip's `needs_decision` ride the
  existing machinery).
