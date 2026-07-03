# Enforcement Hooks — Operator Guide

Phase 67 registers the first **blocking-capable** Claude Code hooks in this
repo: project `.claude/settings.json` wires four gate scripts under
`hooks/` into the `PreToolUse`, `Stop`, `PreCompact`, and `SessionStart`
lifecycle events. This document covers what each gate checks, the
enforcement modes, the warn-to-block rollout procedure, the fail-open
guarantees, the runtime file inventory, and the divergence-report
resolved-signal convention the gates and this phase's audit trail rely on.

## 1. The four gates

- **`hooks/gsd-claim-gate.cjs` (HOOK-02, claim gate).** Runs first on every
  `Edit|Write|MultiEdit|NotebookEdit`. A write to a *code* file (extension in
  a locked allow-list; planning paperwork, docs, and config are exempt) with
  no fresh claimed-task marker in `data/hook-active-tasks.json` is a
  violation — deny in block mode, warn otherwise. The reason names the exact
  claim command (`node get-shit-done/bin/amauta.cjs claim <TK-ID> --agent
  <agent>`) so the message is self-service.

- **`hooks/gsd-manifest-gate.cjs` (HOOK-01, manifest gate).** Runs second,
  after the claim gate has established that a task is active. A write
  outside the union of the active claimed task(s)' `files_expected`
  manifest, the global allowlist, and (for orchestrator-owned paths, only
  when an executor-agent claim is active) the orchestrator-owned invariant
  is a manifest violation — deny in block mode, warn otherwise. The deny
  reason quotes the exact manifest union and points at
  `get-shit-done/references/divergence-protocol.md`, since a manifest
  denial is exactly the trigger condition that protocol defines.

- **`hooks/gsd-stop-gate.cjs` (HOOK-03, stop/completion gate).** Runs on
  `Stop`. Blocks turn-end (block mode only) while any actively claimed task
  lacks T-phase evidence in `data/tasks.json`, or has an unresolved
  divergence report sitting in its own phase's `divergence-reports/`
  directory. Bounded to 3 consecutive blocks per session (tracked in
  `data/hook-stop-counter.json`), then allows with a loud warning —
  comfortably ahead of Claude Code's own 8-block hard cap, so no deadlock is
  possible.

- **`hooks/gsd-session-handoff.cjs` (HOOK-04, handoff ledger).** One script
  switched on `hook_event_name`. On `PreCompact` (both `auto` and `manual`
  triggers) it writes `data/handoff-ledger.json` — current phase, next
  action, active claimed tasks, open divergences, and the first 20 touched
  files from `git status --porcelain`. On `SessionStart` (`startup`,
  `resume`, `compact`) it rehydrates a ledger no older than 7 days as
  `additionalContext`, so pause/resume never depends on a manual step. This
  script never emits a deny or block shape, under any mode.

## 2. `GSD_HOOKS_ENFORCE` modes

| Mode | Behavior | Where it's set |
|------|----------|----------------|
| `off` | Every gate exits 0 immediately, before any stdin read or filesystem access. Zero side effects — the hard kill switch. | Operator env override, e.g. `GSD_HOOKS_ENFORCE=off` prefixed on a session. |
| `warn` (**DEFAULT**) | Violations produce a `systemMessage` (visible to the operator) but never deny a tool call or block a Stop. This is the mode committed in `.claude/settings.json`'s `env` block today. | `.claude/settings.json` → `env.GSD_HOOKS_ENFORCE` |
| `block` | Manifest/claim violations deny the `PreToolUse` call (`permissionDecision: deny`); Stop violations block turn-end (`decision: block`) up to the 3-block bounded-retry ceiling. | Operator-flipped `.claude/settings.json` value, or a scoped test env (never exported to a live session — see `tests/67-04-selftest.test.cjs`). |

`resolveMode()` in `hooks/lib/hook-common.cjs` treats `GSD_HOOKS_ENFORCE`
as `off`/`block` pass-through and **everything else** (unset, empty, typos)
as `warn` — the fail-toward-less-enforcement default is structural, not
convention.

## 3. Operator warn-to-block flip procedure (and rollback)

The registered default is `warn`. Flipping to `block` is a deliberate,
one-line operator action — never an automatic side effect of a phase
landing:

1. Confirm `node tests/67-04-selftest.test.cjs` exits 0 on the current
   `HEAD` (the full plan→execute→close cycle in an isolated env, proving
   the gates behave correctly before touching the live session).
2. Edit `.claude/settings.json`, changing `"GSD_HOOKS_ENFORCE": "warn"` to
   `"GSD_HOOKS_ENFORCE": "block"`.
3. Start a new session (or `/compact`) so the updated registration is
   re-read.
4. **Rollback** is the same one-line edit in reverse: set the value back to
   `"warn"` (or `"off"` for a full kill-switch escape) and start a new
   session. No other state needs to be touched — the gates read
   `GSD_HOOKS_ENFORCE` fresh on every invocation, so rollback takes effect
   immediately on the next tool call.

## 4. Fail-open guarantees

Every gate is built on the shared `runGate()` entrypoint in
`hooks/lib/hook-common.cjs`, which enforces fail-open on every failure
path:

- The daemon is **never** called synchronously from a gate — all state
  reads are local files (`data/hook-active-tasks.json`,
  `data/tasks.json`, `get-shit-done/config/hook-allowlists.json`). A slow
  or unreachable daemon can never brick a tool call.
- A corrupt or missing allowlists artifact, a corrupt or missing claim
  marker, a corrupt `data/tasks.json`, an unparseable/timed-out stdin
  payload, or a thrown handler all resolve to an `allow()` (or `warn()`)
  response — never a crash, never a deny built on absent data.
  `gsd-manifest-gate.cjs` and `gsd-claim-gate.cjs` both document this as
  their fail-open branch explicitly.
- The Stop gate's bounded-retry escape (3 consecutive blocks, tracked per
  `session_id` in `data/hook-stop-counter.json`) is evaluated **before**
  any violation-conditional branch, so no violation state can suppress the
  fail-open exit — deadlock is structurally impossible, well ahead of
  Claude Code's own 8-block hard cap.
- `denyPreToolUse()` and `blockStop()` are themselves structurally
  warn-first: each re-checks `resolveMode()` independently and degrades to
  `warn()` with the identical reason text unless the mode is exactly
  `block`. A bug in any individual gate's calling code cannot produce a
  deny/block shape outside explicit block mode.

## 5. Runtime file inventory (`data/`, gitignored)

- `data/hook-active-tasks.json` — the claim marker map (TK-id → `{agent,
  claimed_at, files_expected, phase, plan_task_id, plan_id}`), written by
  `amauta claim` and pruned by `amauta status`/close. TTL-filtered on read
  (24h default) by `get-shit-done/bin/lib/hook-state.cjs`.
- `data/hook-stop-counter.json` — the Stop gate's session-keyed bounded-retry
  counter, 48h-pruned on read.
- `data/handoff-ledger.json` — the PreCompact/SessionStart handoff payload
  written by `gsd-session-handoff.cjs`.

The **generated** artifact `get-shit-done/config/hook-allowlists.json` is
versioned (not gitignored) and is the single source for
`global_allowlist`, `orchestrator_owned`, and the TOOL-01 capability
catalog exemptions the manifest gate consumes — hooks never hand-copy
these lists. Regenerate it with the `gsd-tools.cjs` `hook-config` verbs:
`node get-shit-done/bin/gsd-tools.cjs hook-config emit` (rewrite the
artifact from the current single-sourced definitions) and
`node get-shit-done/bin/gsd-tools.cjs hook-config check` (verify the
committed artifact is not stale relative to its source). A test-only
override seam, `GSD_HOOK_ALLOWLISTS_PATH`, lets `tests/67-04-selftest.test.cjs`
and its Wave-2 siblings point gates at a fixture copy without touching the
real artifact.

## 6. Divergence-report resolved-signal convention

The Stop gate and the handoff ledger both scan
`.planning/phases/<phase>-*/divergence-reports/*.json` for unresolved
reports belonging to an actively claimed task. A report is **resolved**
when it carries either of two top-level keys:

- **`orchestrator_response`** — the **canonical** signal. Every real
  resolved divergence report across phases 60–66 carries this key (per
  `get-shit-done/references/divergence-protocol.md` §6, the orchestrator
  appends its decision object here).
- **`resolution`** — an accepted **alias**, checked independently. No
  report on disk uses it today, but the gates treat it identically to
  `orchestrator_response` so future tooling can adopt either name without
  a gate code change.

Presence of *either* key marks the report resolved; a report with neither
key, whose `task_id` is itself in the active claim marker, is a genuine
Stop-blocking violation. A report whose `task_id` is **not** in the active
marker (a historic, completed-phase report) is inert — it can never
false-block a different session's turn.

## 7. Kill-switch rollback (quick reference)

If a gate misbehaves in a live session at any point — warn or block mode —
the immediate escape is:

```
GSD_HOOKS_ENFORCE=off
```

set for the session (or in `.claude/settings.json`'s `env` block for every
session). `runGate()` checks this as its literal first statement, before
any stdin read or filesystem access, so the kill switch has zero side
effects and takes effect on the very next tool call.
