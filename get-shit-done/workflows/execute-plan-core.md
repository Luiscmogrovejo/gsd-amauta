<purpose>
The compact execution contract handed to EVERY spawned executor. It holds only what an
executor needs on every single task. Everything situational is a path plus a trigger — read
it when the trigger fires, not before.

This file is the executor's half of `execute-plan.md`. The other half of that file is the
ORCHESTRATOR's: plan discovery, wave dispatch, and the `.planning/` state writes. Do not
read `execute-plan.md` as an executor — the steps in it that update STATE.md, ROADMAP.md and
REQUIREMENTS.md are not yours to run (see <not_yours> below).
</purpose>

<read_on_demand>
Read these ONLY when the trigger fires. Do not pre-load them.

| Path | Read when… |
|---|---|
| `~/.claude/get-shit-done/references/checkpoints.md` | your PLAN contains a `type="checkpoint:*"` task, or frontmatter has `autonomous: false`. Grep first: `grep -n 'type="checkpoint' <plan>` — no hit, no read. |
| `~/.claude/get-shit-done/references/tdd.md` | your PLAN's frontmatter is `type: tdd`, or a task carries `tdd="true"`. |
| `~/.claude/get-shit-done/templates/summary.md` | you have finished the tasks and are about to write SUMMARY.md. Not before. |
| `~/.claude/get-shit-done/references/divergence-protocol.md` | observed state contradicts the task brief, or a prerequisite is missing. |
| `~/.claude/get-shit-done/references/git-integration.md` | you need branch/commit conventions beyond <task_commit> below. |
| `~/.claude/get-shit-done/references/cli-variables.md` | start of RPETD — gives `$CLI/$RLM/$MEM/$RESEARCH/$TOOLS/$SHUNT` and the read-routing table. |

Your PLAN.md is the exception: read it **in full**, every time. It is your instructions.
</read_on_demand>

<not_yours>
`.planning/STATE.md`, `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` are
ORCHESTRATOR-OWNED. `manifest-check` hard-halts the whole wave with
`halt_orchestrator_owned` if your commits touch them — the halt ignores
`GSD_MANIFEST_CHECK=warn`, so there is no warn-only path out of it.

You therefore do **not** run `state advance-plan`, `state update-progress`,
`state add-decision`, `state add-blocker`, `state record-session`,
`roadmap update-plan-progress` or `requirements mark-complete`. Instead, put what the
orchestrator should record into your SUMMARY.md — `key-decisions`, `requirements-completed`
(copied verbatim from the PLAN frontmatter), and any blockers under `## Issues Encountered`.
The orchestrator reads your SUMMARY and applies the state changes itself.

`git add -f` is likewise forbidden to you, under any circumstance. A gitignored, untracked
`.planning/` path that your manifest declares is a divergence: file a divergence report and
return control. (`git add -u <path>` on an *already tracked* `.planning/` file declared in
`files_expected:` is fine and is not a privileged operation.)

You also cannot create or modify `AGENTS.md`. That is user-authored; writing it is a
`scope_expansion` divergence.
</not_yours>

<per_task>
For each task in the PLAN, in order:

1. **`<read_first>` gate (MANDATORY).** If the task lists `read_first` files, read every one
   before any edit. Not optional. Do not skip a file because you "already know" it.
2. **`<interfaces>` block.** If the PLAN carries one, those types and contracts are already
   extracted — use them, do NOT re-read the source files to rediscover them.
3. Execute: `type="auto"` → implement (TDD flow if `tdd="true"`). `type="checkpoint:*"` →
   STOP and return per <checkpoint_return>.
4. **`<acceptance_criteria>` gate (MANDATORY).** Before moving to the next task, verify EVERY
   criterion with a grep, a file read or a command. A failing criterion means fix the
   implementation now — never "will verify later".
5. Commit per <task_commit>.
6. Run the PLAN's `<verification>` block, then confirm `<success_criteria>`.
</per_task>

<deviation_rules>
You WILL discover unplanned work. Apply automatically and track every one for the SUMMARY.

| Rule | Trigger | Action | Permission |
|------|---------|--------|------------|
| **1: Bug** | Broken behavior, errors, wrong queries, type errors, security vulns, race conditions, leaks | Fix → test → verify → track `[Rule 1 - Bug]` | Auto |
| **2: Missing Critical** | Missing essentials: error handling, validation, auth, CSRF/CORS, rate limiting, indexes, logging | Add → test → verify → track `[Rule 2 - Missing Critical]` | Auto |
| **3: Blocking** | Prevents completion: missing deps, wrong types, broken imports, missing env/config/files, circular deps | Fix blocker → verify → track `[Rule 3 - Blocking]` | Auto |
| **4: Architectural** | Structural: new DB table, schema change, new service, switching libs, breaking API, new infra | STOP → surface the decision → track `[Rule 4 - Architectural]` | Ask |

**Priority:** Rule 4 (STOP) > Rules 1-3 (auto) > unsure → Rule 4.
**Heuristic:** affects correctness/security/completion? → R1-3. Maybe? → R4.
**Edge cases:** missing validation → R2 | null crash → R1 | new table → R4 | new column → R1/2.

Per deviation in the SUMMARY: **[Rule N - Category] Title** — found during Task X | issue |
fix | files modified | verification | commit hash. None? Write
`## Deviations from Plan\n\nNone - plan executed exactly as written.`
</deviation_rules>

<authentication_gates>
An auth error is NOT a failure — it is an expected interaction point.
Indicators: "Not authenticated", "Unauthorized", 401/403, "Please run {tool} login", "Set {ENV_VAR}".

STOP the task, raise a `checkpoint:human-action` with the exact auth steps, wait, verify the
credential works, retry the task, continue. Document it in the SUMMARY under
`## Authentication Gates` — normal flow, not a deviation.
</authentication_gates>

<task_commit>
Commit immediately after each task passes verification.

1. `git status --short`
2. Stage individually — **never** `git add .` or `git add -A`.
3. Message: `{type}({phase}-{plan}): {description}` where type is one of
   `feat | fix | test | refactor | perf | docs | style | chore`.
   The `({phase}-{plan})` scope is load-bearing: the orchestrator finds *your* commits
   with `git log --grep="{phase}-{plan}"` to run the per-task manifest check. A commit
   without it is invisible to that check and will be read as a missing file.
4. Record the hash: `TASK_COMMIT=$(git rev-parse --short HEAD)`.

**Pre-commit hooks:** if a hook blocks the commit, read the error, fix the issue, `git add`
the fix, retry. Budget 1-2 cycles. Do NOT use `--no-verify`.
</task_commit>

<verification_failure>
If a task's verification fails: check `workflow.node_repair` (default on) via
`$TOOLS config-get workflow.node_repair`. If on, invoke
`~/.claude/get-shit-done/workflows/node-repair.md` with the failed task, the expected vs
actual result, adjacent task names, and `workflow.node_repair_budget` (default 2).
If off, or repair returns ESCALATE: STOP and report expected vs actual plus what was tried.
Never mark a failing task done.
</verification_failure>

<checkpoint_return>
Spawned via Task and hit a checkpoint? You cannot talk to the user. Return:
1) completed-tasks table (hashes + files), 2) the current task and what blocks it,
3) the checkpoint details for the user, 4) what you are awaiting.
The orchestrator presents it and spawns a FRESH continuation with your state. You will not
be resumed.
</checkpoint_return>

<summary>
Write `{phase}-{plan}-SUMMARY.md` into the plan's directory using
`~/.claude/get-shit-done/templates/summary.md` (read it now, at summary time).

Frontmatter must carry: phase, plan, subsystem, tags | requires/provides/affects |
tech-stack.added/patterns | key-files.created/modified | key-decisions |
requirements-completed (**copy the `requirements` array from the PLAN frontmatter
verbatim**) | duration, completed.

The one-liner is substantive: "JWT auth with refresh rotation using jose", not
"Authentication implemented".

Self-check before returning: every `key-files.created` path exists on disk
(`[ -f ]`), and `git log --oneline --all --grep="{phase}-{plan}"` returns ≥1 commit.
Append `## Self-Check: PASSED` or `## Self-Check: FAILED`.
</summary>

<bounded_return>
Your return value goes straight into the orchestrator's context. Keep it under ~1500
characters and strictly to this shape:

```
PLAN: {phase}-{plan} — {plan name}
STATUS: complete | checkpoint | failed
SUMMARY: {absolute path to SUMMARY.md}
TASKS: {n}/{total} committed
COMMITS: {short hashes, comma-separated}
STATE_FOR_ORCHESTRATOR: {one line per decision/blocker/requirement the orchestrator must
  record in STATE/ROADMAP/REQUIREMENTS — or "none"}
ISSUES: {one line, or "none"}
```

Do NOT paste file contents, diffs, test transcripts or the SUMMARY body into the return.
The orchestrator reads the SUMMARY from the path you give it. The same rule applies to
`$CLI rpetd --content`: it is hard-capped (default 4000 chars) and will exit non-zero on a
transcript — log the command, the verdict and the counts, and leave long output in a file.
</bounded_return>
