# Pre-Execution Checklist (E-Phase Mandate)

**Purpose:** Before writing code, run these queries and evaluate the security checklist. Produce a `PRE_EXECUTION_EVIDENCE:` block as the FIRST content in E-phase.

**Kill switch:** `GSD_E_MANDATE=advisory` (default) | `GSD_E_MANDATE=off` (skip entirely)

**Non-code tasks:** emit `PRE_EXECUTION_EVIDENCE: skipped -- non-code task`

**Kill switch off:** emit `PRE_EXECUTION_EVIDENCE: skipped -- mandate disabled (GSD_E_MANDATE=off)`

---

## Step 1: Failure Pattern Query

```bash
$MEM search "<symptom or task topic>" --source auto_learning,lesson-learned --tags "failure,<domain>" 2>/dev/null || true
```

Domain from target file extensions: `.py` -> `python,backend` | `.ts`/`.tsx`/`.js`/`.jsx` -> `typescript,frontend` (or `backend` for Node.js) | `.tf`/`.yaml`/`.yml` -> `terraform,infrastructure` | `.sh` -> `shell,infrastructure` | `.sql` -> `sql,backend` | Mixed: union all domains.

Log: `failure_patterns: N found, M applied. APPLIED_LEARNING: mem-XXXX -- reason.` Cap: <=300 chars.
Empty: `failure_patterns: 0 results -- greenfield, no prior context`

---

## Step 2: Best Practices Query

```bash
$MEM skb-search "<topic>" --limit 5 2>/dev/null || true
```

Log: `best_practices: N found, M applied. APPLIED_LEARNING: mem-XXXX -- reason.` Cap: <=300 chars.
Empty: `best_practices: 0 results`

---

## Step 3: Style Match Query

```bash
$RLM query "<task title>" --path <target file or dir> --top-k 5 --compact
```

Source: P-phase plan lists target files/dirs. Multi-file: broadest common directory, max 2 dirs. Cap: <=200 chars.
Log: `existing_style: RLM N chunks from <files>. Pattern: <brief>. No deviation from plan.`
Deviation flag: append `DEVIATION: <what differs>.` | Unavailable: `existing_style: RLM unavailable, skipped`

---

## Step 4: Security Checklist (8 items)

Evaluate ALL 8 items for every code task. Mark each: `applied` (MUST include specific action/test), `n/a` (risk does not exist for this task), or `skipped because <reason>` (risk exists but deferred — MUST include reason). Single-word responses (`checked`, `done`, `yes`, `ok`) are cargo-cult and trigger advisory warnings.

- `input_validation` — All domains. Validate format/type/length of external inputs before processing.
- `sql_injection` — Backend. Use parameterized queries; never interpolate user input into SQL strings.
- `xss` — Frontend, Backend (output). Escape/sanitize user-controlled content before rendering in HTML.
- `path_traversal` — Backend, Infra. Validate file paths; reject `../` sequences; use allowlists.
- `auth_check` — All domains. Verify authentication/authorization before accessing protected resources.
- `secret_leak` — All domains. API keys from env vars, not hardcoded; no secrets in logs or errors.
- `rate_limiting` — Backend, Infra. Protect endpoints from abuse; verify rate limiter is active.
- `error_info_leak` — All domains. Generic error messages to clients; internal details to server logs only.

**Semantics:** `n/a` = risk category literally does not apply. `skipped because <reason>` = risk exists but intentionally deferred.

---

## PRE_EXECUTION_EVIDENCE Block (canonical format)

**This block MUST be the FIRST content in your E-phase `--content` argument.**

```
PRE_EXECUTION_EVIDENCE:
  failure_patterns: 3 found, 2 applied. APPLIED_LEARNING: mem-a1b2 -- PG timeout on bulk insert. APPLIED_LEARNING: mem-c3d4 -- race condition in claim. 1 not applicable.
  best_practices: 2 found, 1 applied. APPLIED_LEARNING: mem-e5f6 -- use FOR UPDATE on jsonb read-modify-write. 1 not applicable.
  existing_style: RLM 5 chunks from src/services/pg_store.py, src/daemon.py. Pattern: snake_case, try/except with logging, type hints on public methods. No deviation from plan.
  security_checklist:
    input_validation: applied -- validates task_id format before PG query
    sql_injection: applied -- parameterized queries throughout
    xss: n/a -- no HTML output
    path_traversal: n/a -- no file path from user input
    auth_check: applied -- OIDC token verified in do_POST prologue
    secret_leak: applied -- API keys from env vars, not hardcoded
    rate_limiting: skipped because -- daemon already has global rate limiter
    error_info_leak: applied -- generic 500 message, details to server log only
```

---

## D-Phase APPLIED_LEARNING Requirement (EXEC-08)

In your D-phase, cite `APPLIED_LEARNING: mem-XXXX -- <reason>` for any failure pattern or best practice applied from pre-execution queries. If none applied: `no applicable prior learnings for this task`.

---

## Kill Switch

- `GSD_E_MANDATE=advisory` — default. Validator warns on missing block but does not fail validation.
- `GSD_E_MANDATE=off` — mandate disabled. Emit one-line skip marker. Validator silent.
- Absent block = executor forgot. Skipped block = mandate intentionally disabled.
