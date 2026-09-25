# QA Checklist (T-Phase Mandate)

**Purpose:** Before verifying task delivery, run pre-T queries and produce structured QA blocks in T-phase content.

**Kill switch:** `GSD_T_SPEC_INHERIT=false` disables spec inheritance walk. Edge-case/regression/adversarial blocks are baked into agent prompts -- no separate switch.

**Non-code tasks:** emit `QA_REPORT: non-code task -- standard review only`

---

## Section 1: Delivery Verification (absorbed from post_check_mode)

1. **Success criteria met** -- Check each criterion against actual output
2. **Tests pass** -- Verify test output is real, not fabricated
3. **RPETD complete** -- All 5 phases logged with meaningful content
4. **No regressions** -- Compare against STATE.md baseline (see Section 4)
5. **Conventions followed** -- Code matches project style
6. **LEARNING captured** -- D-phase includes a LEARNING block

---

## Section 2: Pre-T Memory & RLM Queries

Before generating edge cases, query memory and RLM:

### Memory query (testing learnings):
```bash
$MEM search "<task topic>" --source auto_learning,lesson-learned --tags "testing,<domain>" 2>/dev/null || true
```

Domain inference: `.py` -> `python` | `.ts`/`.js`/`.cjs` -> `typescript` | `.sql` -> `sql` | `.yaml`/`.yml` -> `infrastructure`

### RLM test pattern query:
```bash
$RLM query "test <domain>" --path tests/ --top-k 3 --compact 2>/dev/null || true
```

Use findings to inform edge-case generation style and assertion patterns.

---

## Section 3: Edge-Case Generation (EDGE_CASES block)

Generate 2+ edge cases per criterion (both TASK_CRITERIA and INHERITED_CRITERIA).

### Domain-specific templates:

**Database/SQL code:** SQL injection via parameterized query bypass, null column values, constraint violations, connection pool exhaustion, transaction rollback on partial failure, deadlock scenarios.

**Network/API code:** Connection timeout, DNS resolution failure, HTTP 429 rate limiting, malformed JSON response, empty response body, concurrent request race conditions, header injection.

**File/Path code:** Path traversal (../), symlink following, permission denied, file-not-found, zero-byte file, filename with special characters, disk full.

**Auth/Session code:** Expired token, revoked token, missing auth header, privilege escalation, session fixation, concurrent login, CSRF token mismatch.

**Concurrent code:** Race conditions (TOCTOU), deadlocks, starvation, lost updates, phantom reads, double-submit.

### Non-testable criteria:
`edge_cases: n/a -- non-testable criterion` (e.g., "documentation updated")

### Block format:
```
EDGE_CASES:
  criterion_1: "SC-01: <criterion text>"
    edge_1: <specific edge case> -> expect <expected behavior>
    edge_2: <specific edge case> -> expect <expected behavior>
  criterion_2: "SC-02: <criterion text>"
    edge_1: <specific edge case> -> expect <expected behavior>
    edge_2: <specific edge case> -> expect <expected behavior>
```

**Cap:** <=400 chars total. Minimum 2 edge cases per criterion.

---

## Section 4: Regression Sweep (REGRESSION block)

Compare test results against known-good baseline from STATE.md.

**Per-task targeted:** Infer test files from `git diff --name-only` + glob for `*test*` in same directory.
**Phase-end full suite:** `npm test && pytest` at phase completion.

### Block format:
```
REGRESSION: after: <N> pass / <M> fail. Baseline: <B_pass> pass / <B_fail> fail. Delta: +<D> new tests, <F> new failures. Regression: none|CHECK.
```

**Cap:** <=100 chars (one-line summary).

---

## Section 5: Adversarial Testing (ADVERSARIAL block)

Only for tasks with `security_sensitive: true` metadata (set by operator at claim time based on `security_patterns` in agent-capabilities.json).

### Required adversarial checks:
- **Path traversal:** `../` sequences in file path inputs
- **Injection:** SQL injection, XSS, command injection in user inputs
- **Auth bypass:** Missing/invalid/expired authentication tokens
- **Privilege escalation:** Accessing resources above user's permission level
- **Secret exposure:** API keys, tokens, passwords in logs/responses/errors

### Block format:
```
ADVERSARIAL:
  path_traversal: pass|fail|n/a -- <brief note>
  injection: pass|fail|n/a -- <brief note>
  auth_bypass: pass|fail|n/a -- <brief note>
  privilege_escalation: pass|fail|n/a -- <brief note>
  secret_exposure: pass|fail|n/a -- <brief note>
```

**Non-security tasks:** `ADVERSARIAL: n/a -- no security-sensitive files`
**Cap:** <=200 chars (3-5 checks with pass/fail).

---

## Section 6: RED-GREEN Back-Testing (bug-type tasks only)

**MANDATORY for BG-XXXX tasks.** Not for regular tasks or stories.

### Detection:
- Canonical: task `type` field == `"bug"`
- Fallback: ID starts with `BG-`
- NO title heuristics

### Required commits:
1. **RED commit** = test that FAILS, proving bug exists. Message: `test(red): reproduce BG-XXXX -- <bug description>`
2. **GREEN commit** = fix making red test pass. Message: `fix(green): resolve BG-XXXX -- <fix description>`

### Verification:
```bash
git log --oneline --grep="BG-XXXX" --reverse
```

RED commit must appear BEFORE GREEN commit (chronological).

### Non-reproducible bugs:
Use `--force-reason "non-reproducible: <explanation>"` on `amauta validate`. Validator sees `forced:true` and skips RED commit check.

---

## Section 7: QA_REPORT Summary

One-line summary generated after all checks:

```
QA_REPORT: <N>/<M> criteria verified, <E> edge cases, regression: clean|CHECK, adversarial: <A>/<B> passed|n/a
```

**Cap:** ~100 chars.

---

## T-Phase Token Budget

Total T-phase cap: ~1000 chars. Breakdown:
- EDGE_CASES: <=400 chars
- REGRESSION: <=100 chars
- ADVERSARIAL: <=200 chars
- QA_REPORT: ~100 chars
