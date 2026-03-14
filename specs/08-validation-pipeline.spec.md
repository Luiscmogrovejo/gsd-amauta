# SPEC-08: Validation Pipeline Deep-Dive

**Version:** 1.0  
**Status:** Active  
**Owner:** gsd-validator  
**Tests:** `tests/validation-gates.test.cjs`, `tests/e2e-advanced.test.cjs`, `tests/comprehensive-e2e.test.cjs`

---

## Purpose

Specifies the full multi-gate validation pipeline that enforces quality standards before any task transitions to `done`. The validation system is externally operated (validator agent ≠ executor agent) and enforces four mandatory gates for code tasks.

---

## SPEC-08-VAL-1: Validation State Machine

### Task Status Lifecycle (Code Tasks)
```
pending → in-progress → validation → done
                    ↗              ↘
              (re-claim)        (gate fail → pending)
```

### State Transitions
| Transition | Command | Guard |
|------------|---------|-------|
| `pending → in-progress` | `amauta claim <id> --agent <agent>` | deps_met check |
| `in-progress → validation` | `amauta status <id> validation` | BRANCH_EVIDENCE + TEST_EVIDENCE gates |
| `validation → done` | `amauta validate <id> --pass` | LEARNING_BLOCK + PR_URL gates |
| `validation → pending` | `amauta validate <id> --fail` | Always succeeds (intentional failure) |
| `any → done` | `amauta status <id> done` | **BLOCKED for code tasks** — must go through validation |

**Key invariant:** Code tasks CANNOT skip validation. Direct `status done` is blocked for code-lane tasks.

---

## SPEC-08-VAL-2: Four Validation Gates

### Gate 1: BRANCH_EVIDENCE
**When checked:** `amauta status <id> validation` (transition guard)  
**Checked by:** `_has_branch_evidence(e_phase)`  
**Pattern:** `git checkout -b | branch[:=] | (feat|fix|chore|hotfix|refactor|release)/`  
**Pass:** E-phase contains a recognizable branch pattern  
**Fail:** No branch pattern in E-phase  
**Bypass:** `no-gitflow` tag or non-code lane task

### Gate 2: LEARNING_BLOCK
**When checked:** `amauta validate <id> --pass`  
**Checked by:** `_has_explicit_learning_written(item)` + `_has_learning_persisted(item)`  
**Pattern:** `LEARNING:` keyword anywhere in RPETD phases or notes  
**Pass:** Agent wrote LEARNING in at least one phase AND it's persisted to PG memory  
**Fail:** No LEARNING block or not persisted  
**Degraded mode:** If PG unavailable, falls back to `_has_explicit_learning_written` only

### Gate 3: TEST_EVIDENCE
**When checked:** `amauta status <id> validation` (transition guard)  
**Checked by:** `_has_test_evidence(t_phase)`  
**Patterns (any of):**
- `exit 0`, `exit code 0`, `exit=0`
- `N tests passed`, `0 failed`, `all tests passed`
- `build pass`, `build successful`
- `go test ... ok`, `cargo test ... ok`
- `tsc --noEmit`
- `checks green`, `ci checks: success`
- `[COMPLETED]`, `criteria met`
- Substantial T-phase content (>100 chars) as proxy
**Fail trigger:** `ENOENT`, `permission denied`, `command not found` in T-phase

### Gate 4: PR_URL
**When checked:** `amauta validate <id> --pass`  
**Checked by:** `_extract_pr_url(item)` + `_has_merge_evidence(item)`  
**Pattern:** `https://github.com/<org>/<repo>/pull/<n>` in D-phase or notes  
**Pass:** PR URL found AND merge evidence present  
**Bypass:** `no-gitflow` tag, `infra` lane, `PR_URL: no-pr-needed` marker

---

## SPEC-08-VAL-3: Non-Code Task Exemptions

Tasks assigned to non-code agents (`gsd-researcher`, `gsd-planner`, `gsd-roadmapper`, `gsd-validator`) or with `no-gitflow` / `lane:non-code` tags are exempt from:
- Gate 1 (BRANCH_EVIDENCE)
- Gate 4 (PR_URL)

They must still satisfy:
- Gate 2 (LEARNING_BLOCK) — learning is always required
- Gate 3 (TEST_EVIDENCE) — adapted for non-code verification (artifact existence, verification output)

---

## SPEC-08-VAL-4: Gate Cooldown

After a `GATE_FAIL` note is appended to a task, a **20-minute cooldown** (`AMAUTA_GATE_COOLDOWN_MINUTES`, default 20) prevents the same gate from being immediately retried. This prevents agents from spinning on validation without actually fixing the underlying issue.

**Cooldown check:** `_in_gate_cooldown(item)` via `_gate_fail_age_seconds(item)`

---

## SPEC-08-VAL-5: Force Override

`amauta validate <id> --pass --force` bypasses all gate checks. Used when:
- Infrastructure limitations prevent normal gate satisfaction (e.g., offline CI)
- Operator has manually verified all gates
- Non-standard workflow (no git repo)

All force-overrides are logged to `gsd_task_validations` with `forced=true`.

---

## SPEC-08-VAL-6: Audit Trail

Every validation attempt (pass or fail) is recorded in:
1. **`gsd_task_validations` table** — validator_id, status, evidence, rejection_reason
2. **`gsd_agent_performance` table** — agent_id, task_id, outcome, gate_failed, duration_minutes
3. **`amauta_memory`** — auto-written learning via `_auto_write_learning()`
4. **`gsd_shared_kb`** — patterns promoted via `_skb_promote()` on validation pass

---

## SPEC-08-VAL-7: Auto-Atomization on Fail

When `amauta validate <id> --fail --subtasks "fix A|fix B"`:
1. Task is returned to `pending`
2. Subtasks are created as child items (story under epic, task under story)
3. Each subtask inherits agent, tags, and priority from parent
4. Parent is auto-deferred until all subtasks complete

**Hierarchy constraint:** Tasks can only atomize into child tasks of compatible types (epic → story/task, story → task).

---

## SPEC-08-VAL-8: Gate Failure Reporting

On failure, the system:
1. Appends `GATE_FAIL: <GATE_NAME>` note with timestamp
2. Calls `_record_agent_performance(agent_id, task_id, outcome='fail', gate_failed=<gate>)`
3. Prints actionable fix instructions specific to the failed gate
4. Triggers cooldown window to prevent spin loops

---

## SPEC-08-VAL-9: Quality Gates Reference Implementation

The validation system is implemented across three Python functions:

| Function | Location | Purpose |
|----------|----------|---------|
| `cmd_status()` | `amauta.py:2529` | Guards `validation` transition with Gates 1+3 |
| `cmd_validate()` | `amauta.py:3099` | Handles pass/fail with Gates 2+4 |
| `_needs_gitflow_gate()` | `amauta.py:2018` | Determines if code gates apply |

---

## Acceptance Tests

All tests in `tests/validation-gates.test.cjs` and `tests/e2e-advanced.test.cjs` (Section 4) must pass.

**Critical scenarios:**
- VAL-T1: Pass with all 4 gates satisfied → status=done
- VAL-T2: Fail with missing LEARNING → status=pending + GATE_FAIL note
- VAL-T3: Non-code task passes without branch/PR → status=done
- VAL-T4: Force override bypasses all gates
- VAL-T5: Infra task with no-gitflow skips PR gate
- VAL-T6: Cooldown blocks immediate retry after GATE_FAIL
