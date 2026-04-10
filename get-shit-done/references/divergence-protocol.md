version: "1.0.0"
reference_type: runtime-read
scope: executors (4) + gsd-validator
protocol_version: 1.0.0

# Divergence Protocol

> Runtime Read. All four gsd executors (`gsd-executor-backend`,
> `gsd-executor-frontend`, `gsd-executor-infra`, `gsd-executor-general`) and
> `gsd-validator` MUST Read this file at task start, before any file
> modification. The protocol is binary-trigger: any observed state that
> contradicts a task-brief assumption is a divergence, regardless of perceived
> severity. There is no thresholding, no "it's just a typo" carve-out, and no
> silent fix path.

This file is the behavioral half of the Phase 13 defense. `HARDEN-01` halts
the wave deterministically through manifest enforcement; `HARDEN-02` (this
document) tells the agent exactly what to do instead of silently "fixing" it.
Protocol version `1.0.0`. Field names are load-bearing — plan 13.1-05 asserts
filesystem effects against this schema, so do not rename fields without
updating the behavioral test.

---

## 1. When this applies

The trigger is binary.

Any time an agent observes state that contradicts an assumption stated in or
implied by its task brief (PLAN.md, files_expected, prereq outputs, sibling
task artifacts, environment state, tool output), that is a divergence. Examples
that all qualify:

- A file the plan says should exist is missing.
- A file the plan says should be empty has content.
- A prior task's output does not match what the plan promised.
- A test that was supposed to be passing is failing.
- The `files_expected:` manifest does not list a file you need to modify to
  complete your task.
- A configuration value is different from what the plan assumed.
- A function signature has changed since the plan was written.

There is no severity threshold. "It looks like a typo" is a divergence. "It's
a one-line fix" is a divergence. "It would take longer to file a report than
to fix it" is a divergence — and is specifically the rationalization the
`rationalization_check` field exists to catch. False-positive volume is
addressed by improving PLAN.md assumptions upstream, never by weakening the
protocol downstream.

---

## 2. Step 1 — Assumption check (before any modification)

Before you touch a single file, you MUST complete an assumption check and log
two ISO8601 timestamps:

- `assumption_check_completed_at` — when you finished verifying the brief's
  preconditions.
- `first_modification_at` — when you made the first write/edit.

The orchestrator audits the ordering of these two fields. If
`first_modification_at` is earlier than `assumption_check_completed_at`, or
if `assumption_check_completed_at` is missing entirely, that is an automatic
`gaps_found` floor for the phase verdict. Out-of-order = you started editing
before you finished looking, which is exactly the Phase 13 fingerprint.

Assumption-check activities include: reading each file the plan told you to
read, grepping for the symbols the plan said would exist, running the
commands the plan said should pass, and confirming the `files_expected:`
manifest covers every file you will actually touch.

---

## 3. Step 2 — On divergence, STOP and write a report

When you detect a divergence, the protocol is:

**Do NOT:**

- Do NOT "wrap up" by committing partial work.
- Do NOT revert the files you have already touched.
- Do NOT compensate for the divergence by doing extra undeclared work.
- Do NOT silently widen scope ("while I'm here…").
- Do NOT rename the problem ("this isn't really a divergence, it's just a…").
- Do NOT re-read the plan looking for a permission slip.

**Do:**

1. Stop immediately at the current instruction boundary.
2. Capture `work_in_progress_state` (see section 5) exactly as it stands.
3. Write a `divergence_report` JSON to the canonical path (see section 4).
4. Exit non-zero (conventional: exit `1`) with a stderr line pointing to the
   report path.
5. If the report write itself fails, exit `87` with the stderr fallback
   contract in section 7.

Return control to the orchestrator. The orchestrator owns the next decision.
You do not.

---

## 4. The `divergence_report` JSON schema

Report location contract (template — `<phase>` is runtime-substituted):

```
.planning/milestones/<phase>/divergence-reports/<task_id>-<timestamp>.json
```

The `<phase>` token is the milestone directory name; `<task_id>` is the
plan's task ID (e.g. `13.1-02-01`); `<timestamp>` is a UTC ISO8601 value safe
for filenames (colons replaced with hyphens).

Every mandatory field, in order:

```json
{
  "task_id": "13.1-XX-YY",
  "agent": "gsd-executor-<role>",
  "timestamp": "2026-04-10T14:32:05Z",
  "protocol_version": "1.0.0",
  "expected": "Verbatim or close paraphrase of the assumption from PLAN.md.",
  "found": "Concrete observation. No 'seems', 'looks like', 'probably'.",
  "divergence_type": "stale_prerequisite",
  "reconciliation_options": [
    {
      "label": "A",
      "action": "Concrete option A — a specific named action."
    },
    {
      "label": "B",
      "action": "Concrete option B — a specific named action."
    },
    {
      "label": "C",
      "action": "Concrete option C — a specific named action."
    },
    {
      "label": "D",
      "action": "Concrete option D — a specific named action."
    }
  ],
  "executor_recommendation": {
    "pick": "A",
    "rationale": "1-3 sentences, referencing the plan's goal, not convenience."
  },
  "rationalization_check": "I considered just fixing it because <reason>. I am not doing that because <protocol line>.",
  "assumption_check_completed_at": "2026-04-10T14:31:40Z",
  "first_modification_at": "2026-04-10T14:31:58Z",
  "work_in_progress_state": {
    "mid_execution": false,
    "files_modified_so_far": [],
    "files_created_so_far": [],
    "uncommitted_changes": false,
    "last_completed_step": "Assumption check",
    "next_planned_step": "Edit agents/gsd-executor-backend.md"
  }
}
```

### Field semantics

- **`task_id`** — matches the plan's task ID exactly.
- **`agent`** — the agent role name (e.g. `gsd-executor-general`).
- **`timestamp`** — ISO8601 UTC, when the report was written.
- **`protocol_version`** — matches the `version:` header of this file.
- **`expected`** — what the plan said (verbatim or tight paraphrase).
- **`found`** — a concrete observation. No hedging vocabulary. If you catch
  yourself writing "seems", "looks like", "probably", "I think", delete the
  sentence and write what you literally observed on disk or in tool output.
- **`divergence_type`** — enum, exactly one of:
  `stale_prerequisite | unexpected_file_state | scope_overflow | manifest_violation | other`.
  Pick the tightest fit. `other` requires a one-line justification embedded in
  `found`.
- **`reconciliation_options`** — array of concrete options A–D. Each option
  names a specific action. "Fix it" is not an action. "Update file X line Y
  to value Z and re-run task 13.1-0N" is an action.
- **`executor_recommendation`** — picks one of your own options and gives a
  1-3 sentence rationale grounded in the plan's goal, not in agent
  convenience ("this is faster" is not a rationale — it is the exact
  rationalization the next field catches).
- **`rationalization_check`** — **MANDATORY**. This is the most important
  field in the schema. It must be either:
  - the exact pattern
    `"I considered just fixing it because <reason>. I am not doing that because <protocol line>."`
    with the `<reason>` and `<protocol line>` placeholders filled in with
    real content, OR
  - the exact string `"N/A — no temptation present."`

  Omission, empty string, `null`, or a paraphrased variant is an automatic
  `gaps_found` floor for the phase verdict. The validator's pre-gate scan
  checks this field explicitly. The point of `rationalization_check` is to
  force you to name the temptation you resisted; that is what makes the
  Phase 13 "it was faster to just fix it" pattern visible on future audit.
- **`work_in_progress_state`** — see section 5. Required key even for
  divergences detected before any modification; in that case the value is
  `{"mid_execution": false}` with the remaining fields as empty defaults.

---

## 5. `work_in_progress_state` sub-schema

The required fields of `work_in_progress_state` — never omit any of them; use
empty values when there is nothing to report:

1. **`files_modified_so_far`** — array of file paths you have edited in this
   task run.
2. **`files_created_so_far`** — array of file paths you have newly created in
   this task run.
3. **`uncommitted_changes`** — boolean. True if the working tree contains
   any of your edits that are not yet committed.
4. **`last_completed_step`** — string. The last PLAN.md action you finished
   before detecting the divergence.
5. **`next_planned_step`** — string. The next PLAN.md action you were about
   to begin when you stopped.

Mid-execution divergences additionally set `"mid_execution": true` as a
sixth key for orchestrator routing.

NO cleanup, NO revert, NO wrap up. You freeze the tree as it is and hand it
over. The orchestrator decides whether to re-route (and therefore inherit
your partial work), re-plan, expand scope, or halt the phase.

---

## 6. Orchestrator decision tree — exactly 4 options

When the orchestrator receives a divergence report, it picks exactly one of
four options. There is no 5th. The orchestrator is forbidden from picking any
variant of proceed-without-action. If the orchestrator finds itself tempted
to do so, it files its own divergence report (agent:
`gsd-orchestrator`) and halts the phase.

1. **re-route** — Dispatch to a different agent with the same brief. Used
   when the divergence is about capability mismatch ("executor-frontend
   cannot solve this; it is really a backend task"). The original task ID
   is kept; the agent field changes in the audit log.

2. **re-plan** — Send back to `gsd-planner` for a delta plan. The current
   task is abandoned; a new task with corrected assumptions replaces it.
   Used when the plan's preconditions were wrong, not just the executor
   assignment.

3. **expand scope** — Authorize an updated `files_expected:` block on the
   current task. This is the ONLY legitimate way to widen a task manifest
   mid-wave. The updated block is appended to the `orchestrator_response`
   object and the executor is re-dispatched with the widened manifest.

4. **halt phase** — Stop the wave entirely, write a halt record, and
   escalate to human review. Used for any `manifest_violation` divergence,
   or when multiple divergences in the same wave indicate a structural
   planning error.

There is no 5th option. The protocol explicitly forbids any decision whose
effect is "continue the task as if the divergence had not been observed,"
including variants phrased as "just this once," "the diff is trivial," or
"the report can be filed after." These are the exact rationalizations
`rationalization_check` exists to surface.

### `orchestrator_response` example

Appended to the same divergence report file (or written as a sibling file)
once the orchestrator decides:

```json
{
  "orchestrator_response": {
    "decision": "re-plan",
    "decided_at": "2026-04-10T14:45:00Z",
    "decided_by": "gsd-orchestrator",
    "notes": "Plan 13.1-02 assumed file X existed; it does not. Sending to gsd-planner for delta plan."
  }
}
```

---

## 7. Exit code 87 — report-write failure fallback

If the report write itself fails (disk full, permission denied, path
invalid), you cannot assume the orchestrator will see the report on disk. In
that case:

1. Exit with code **87** (exactly the digits `87`). This code means
   "divergence detected AND logged — but the write channel is broken."
2. Write a structured stderr block on the exact form:

   ```
   DIVERGENCE_REPORT_WRITE_FAILED
   task_id: <task_id>
   agent: <agent>
   reason: <filesystem error message>
   fallback_payload: <the JSON you tried to write, serialized to a single line>
   ```

3. Do not retry the write from inside the executor. The orchestrator's
   audit-log side task will repair the write channel and capture the payload
   from stderr.

The orchestrator treats exit `87` as "divergence detected AND logged" — a
successful report *plus* a side task to repair the write channel. Exit `87`
does NOT count as a failure for auto-escalation purposes (see section 11).

---

## 8. Multi-task simultaneous divergence

When multiple tasks in the same wave divergence concurrently:

- Each task writes its own report independently. No cross-task coordination.
- The orchestrator processes reports in task-ID lexicographic order
  (e.g. `13.1-02-01` before `13.1-02-02`).
- The wave HALTS — no further tasks dispatched — when any of the following
  conditions is met:
  - Any report has `divergence_type: "manifest_violation"`.
  - Any orchestrator_response has `decision: "halt phase"`.
  - Three or more divergence reports have been filed in the current wave
    (threshold configurable via orchestrator config; default `3`).

A halted wave produces a wave-halt record pointing at every unresolved
divergence report for the phase.

---

## 9. Validator variant

The validator (`gsd-validator`) follows the same protocol with two
modifications:

1. **Extra `divergence_type` value: `verdict_ambiguity`.** The validator
   uses this when the quality-gate evidence does not cleanly map to `pass`,
   `fail`, or `gaps_found` — the ambiguity is itself the divergence.
2. **Constrained `reconciliation_options` for `verdict_ambiguity`.** Only
   these three options are legal; the validator MUST NOT invent others:
   - `"treat as gaps_found"`
   - `"treat as fail"`
   - `"request human disambiguation"`

The validator NEVER picks a "fix it" option. Fixing is a re-plan task for
`gsd-planner`; the validator's job is to surface ambiguity, not to
disambiguate by action. Any validator run that emits a divergence report
with a reconciliation option outside the three above is itself a protocol
violation and lands as `gaps_found` floor.

---

## 10. Validator pre-gate scan

Before the validator evaluates any of its five quality gates, it performs a
pre-gate scan of `.planning/milestones/<phase>/divergence-reports/` and
lists every report that lacks an `orchestrator_response` field. Each
unresolved report is an automatic `gaps_found` floor — it is NOT advisory,
and it is NOT reducible by other gate evidence. The validator reports every
unresolved path in its verdict output so the orchestrator can chase them.

This is the enforcement loop that keeps divergences from being quietly
buried between phases.

---

## 11. No retroactive reports

A divergence report MUST be written before the task process exits. A
post-hoc surface — found later in git history, in a manifest-violation
artifact, in a gap analysis, or by the next wave's pre-gate scan — that was
NOT reported during execution produces phase verdict `fail`, not
`gaps_found`. Silent absorption is never recoverable.

"I noticed the issue and fixed it and then filed the report after the
commit" is a retroactive report. It counts as silent absorption. The
ordering is strict: detect → report → exit, with no intervening writes.

---

## 12. Audit log ownership

The **orchestrator** writes the audit-log entry that references the
divergence report. The executor does not. This preserves trust separation:
the agent that detected the divergence is not the same agent that records
that the divergence was detected. An executor that writes its own audit
entry is itself a protocol violation.

The executor's responsibilities end at: write the report, exit non-zero (or
`87`), emit the stderr pointer. Everything downstream belongs to the
orchestrator.

---

## 13. Auto-escalation separation

Divergences are a third category — neither pass nor fail. They do NOT count
toward the 3-consecutive-failure auto-escalation rule. Instead, the
orchestrator tracks `divergence_rate_per_phase` as an independent signal.
A spike in `divergence_rate_per_phase` points at a planning problem
(assumptions too optimistic, preconditions too loose), not at an executor
problem, and so routes to planner-process review rather than to human
escalation on the executor.

Summary of the three-category model:

- **pass / success** — task completed as briefed; no divergence.
- **fail** — task attempted and could not be completed for technical
  reasons; counts toward consecutive-failure escalation.
- **divergence** — state contradicted brief; task correctly stopped and
  reported; counts toward `divergence_rate_per_phase`, NOT toward the
  consecutive-failure counter.

The three categories are mutually exclusive per task run. A task that
detects a divergence and reports it cleanly is neither a pass nor a fail —
it is a divergence, full stop.

---

Protocol version: 1.0.0
