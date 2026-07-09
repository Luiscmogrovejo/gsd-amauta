# Auditor Agent Format (shared, read-only) — the base auditor class

**Purpose:** the reusable spec every v3.6 domain-auditor executor (Phase 81/82: infra,
frontend, backend, mobile, api-connections, agentic-flow, harness-self, models, general)
reads before authoring an auditor. It is a `doc_ref`, not a runnable artifact. An auditor
is a **read-only reporter**: it scans the codebase, emits structured findings to the
`agent_findings` substrate via `POST /api/findings` (`finding_type='audit'`), and **never
patches or fixes** — remediation is the executor's job, gated through the Phase 79 router.

Two house rules from the DOMAIN-CHECKLISTS carry forward and shape everything below:

1. **Auditors scan and report — they never fix.** Output is structured findings, advisory
   to the operator. The same boundary as `gsd-security` / `gsd-reviewer`.
2. **Fail-toward-report, never fail-toward-silence.** A rule that cannot be decided
   statically degrades to a runtime probe or an explicit `[UNVERIFIABLE — manual review]`
   finding — never a silent pass.

The reference implementation of this format is `gsd-auditor-reference` (canonical
`get-shit-done/agents/gsd-auditor-reference/AGENT.yaml`, compiled `agents/gsd-auditor-reference.md`).
Copy it as the template; do not re-derive the shape.

---

## 1. The 10-section shape (agent-compiler contract)

Every auditor is authored as a **canonical** `get-shit-done/agents/<name>/AGENT.yaml` and
compiled to `agents/<name>.md` via `scripts/agent-compiler.cjs`. The compiler's
`listAgents()` **auto-discovers** any `get-shit-done/agents/gsd-*/` directory containing an
`AGENT.yaml` — **no `agent-compiler.cjs` edit is needed** to register a new auditor. (If a
compiler change appears necessary, that is a divergence: STOP and surface it.)

`validate()` enforces **exactly the 10 section keys**, in this order:

| # | Section key (AGENT.yaml) | Compiles to (`.md` heading) |
|---|--------------------------|-----------------------------|
| 1 | `role_and_identity` | Role & identity |
| 2 | `domain_knowledge` | Domain knowledge |
| 3 | `patterns_and_practices` | Behavioral rules |
| 4 | `workflow_and_process` | Tool access & guidance |
| 5 | `tools_and_resources` | Task management |
| 6 | `quality_gates` | Security rules |
| 7 | `output_format` | Preconditions & constraints |
| 8 | `error_handling` | Error handling |
| 9 | `examples` | Examples |
| 10 | `metadata` | version / trailing `<!-- CACHE_BREAKPOINT -->` |

And the **6 locked frontmatter fields** (nothing outside this set):

`name`, `description`, `tools`, `color`, `memory`, `skills`.

- `name` must match `^gsd-[a-z][a-z0-9-]{1,63}$` (e.g. `gsd-auditor-reference`).
- `memory: user`.
- `skills:` a single existing skill (e.g. `gsd-executor-backend-workflow`).
- The auditor stays **out** of `AGENTS_WITH_HOOKS` — read-only agents get no hooks block
  (exactly like `gsd-security` / `gsd-reviewer` / `gsd-qa`).

Registration is **additive**: drop the `AGENT.yaml`, compile, and commit the compiled `.md`.
The dynamically-enumerated byte-match test (`tests/agents-compile-claude-target-byte-match.test.cjs`)
self-updates and byte-verifies the new agent. Do **not** hand-edit the compiled `.md`; if the
byte-match diverges, fix the `AGENT.yaml`.

---

## 2. Read-only tool set (hard boundary)

Auditors declare **exactly**:

```yaml
tools: Read, Bash, Grep, Glob
```

and **MUST NOT list `Write` or `Edit`**. An auditor scans and reports — it never patches,
never fixes, never edits a file. This is the non-negotiable read-only boundary. Note: a
`Write`-bearing agent would still *compile*, so the no-`Write` rule is an **explicit**
source-analysis assertion in the tests, not an implied one.

Filing a finding does **not** require write capability: it is a `POST /api/findings`
(Bash/curl over HTTP), not a file edit. So a read-only auditor with no `Write` tool can
still emit findings — it just cannot change code. `memory: user`.

**Scan and report — never fix.** Remediation is the executor's job; the Phase 79 router
turns an auditor's finding into an operator-gated ticket. The auditor's only sink is the
substrate.

---

## 3. The locked-rules table schema

Each auditor's `domain_knowledge` section carries a markdown **locked-rules table** with
these exact columns:

```
| ID | Checkable assertion | Detect (static grep/AST | config inspection | runtime probe) | Severity (info|warning|error|critical) | Owns/Overlap |
```

- **ID** — a stable rule id (e.g. `INFRA-01`, `BACK-06`, `REF-01`).
- **Checkable assertion** — an objectively-verifiable statement, not a vibe.
- **Detect** — how the auditor mechanically checks it, in preference order: (1) static
  grep/AST on source, (2) config-file inspection (compose, workflows, `config.json`,
  manifests), (3) runtime probe (build/test/axe/byte-diff). Prefer static; label a
  probe-only rule so operators know it needs a live environment.
- **Severity** — one of `info | warning | error | critical`.
- **Owns/Overlap** — either `New` (a genuinely-unowned check this auditor owns) **or** a
  cross-link naming the existing agent that already owns it (see §6). A deferred check is a
  cross-link, cited — never re-scanned.

**Fail-toward-report:** an undecidable rule degrades to a probe or an explicit
`[UNVERIFIABLE — manual review]` finding, never a silent pass.

---

## 4. Deterministic severity → finding-JSON output schema

Reuse `gsd-security`'s structured finding shape **verbatim** for the auditor's report file,
so the blackboard and operator tooling need no new shape:

```json
{
  "tool": "",
  "severity": "info | warning | error | critical",
  "category": "",
  "file": "",
  "line": 0,
  "message": "",
  "remediation": ""
}
```

**Deterministic verdict model** (mirror `gsd-reviewer`, never override with holistic
judgment):

- any `error`/`critical` finding → `request_changes`
- only `warning` findings (no errors) → `comment_only`
- no findings, or only `info` → `approve`

**Mapping report-JSON → blackboard emission fields** (see §5): `severity`→`severity`,
`file`→`file_path`, `message`→`content` (short summary), `remediation`→`suggested_fix`, the
offending snippet →`evidence`, the rule id →`rule_id`, the auditor domain →`domain`.

---

## 5. The `agent_findings` emission contract (AUDT-02)

Per finding, an auditor emits **one** `POST /api/findings` call. It files **findings, never
fixes** — metadata only, no patch. `finding_type` is `'audit'`. `task_id` is **not
required** (nullable — audits are standalone). The server computes `dedup_key =
rule_id:sha1(file_path)` and deduplicates open/ticketed findings, so a re-run does not
double-file.

Required by the daemon: `agent_name`, `finding_type`, `content`. Optional audit metadata:
`rule_id`, `domain`, `file_path`, `evidence`, `suggested_fix`, `severity`, `status`
(default `open`), `audit_run_id`.

Concrete curl shape (Bash — no `Write` needed):

```bash
curl -s -X POST "http://127.0.0.1:${AMAUTA_PORT:-18799}/api/findings" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "gsd-auditor-reference",
    "finding_type": "audit",
    "severity": "warning",
    "rule_id": "REF-01",
    "domain": "harness-self",
    "file_path": "agents/some-agent.md",
    "evidence": "tools: Read, Write  # claims read-only but lists Write",
    "suggested_fix": "Remove Write/Edit from a read-only reporter's tools list",
    "content": "read-only-claim vs Write-tool mismatch"
  }'
```

- Returns `201 {"id":...,"created":true}` on insert, or `200 {"deduped":true,"existing_id":...}`
  on a repeat with the same `rule_id`+`file_path`.
- The **SUBS-04 sweep** `GET /api/findings?status=open&type=audit` confirms it landed.
- Cleanup / close-loop is a **Phase 79** `PATCH /api/findings/<id>` `{"status":"cleared"}`.

**Auditors file findings, never fixes.** The `content` field is a short daemon-required
summary; the actionable detail rides `evidence` / `suggested_fix`. The auditor never writes
a patch.

---

## 6. The anti-duplication map (AUDT-03) — DEFER, don't re-scan

Every check an existing review agent already owns is a **cross-link** in the `Owns/Overlap`
column — cited, not re-implemented. A new auditor only implements genuinely-unowned checks.
This keeps the immune system additive and avoids the double-enforcement that makes findings
noisy.

| Domain of check | Owning agent | Auditor action |
|-----------------|--------------|----------------|
| secrets / dependency-CVEs / container-CVEs / parameterized-SQL / supply-chain | **defer to `gsd-security`** | cross-link only; confirm the scan ran, never re-scan |
| per-file dead code / god-class / duplication / style / naming / missing docs | **defer to `gsd-reviewer`** | cross-link; a general auditor does repo-wide unreferenced *files* only |
| coverage ratchet / mutation score / test-pyramid ratio | **defer to `gsd-qa`** | cross-link; harness-self only checks the ratchet FILE wasn't hand-lowered |
| API-design rules / design-level N+1 / ADRs / pagination-at-design | **defer to `gsd-architect`** | cross-link; a backend auditor does N+1 at CODE level (post-impl) — a different RPETD phase, complementary |

**The rule:** an owned check appears in `Owns/Overlap` as a DEFER cross-link naming the
owning agent; a new auditor claims `New` only for a check no existing agent covers. Every
`New` rule is a candidate requirement; every `Defer`/`Verifies`/`Overlaps` rule is a
cross-link, not a new implementation.

---

## Checklist for a new auditor (before you compile)

- [ ] `AGENT.yaml` has the 6 locked frontmatter fields, `memory: user`, and **exactly** the
      10 section keys.
- [ ] `tools: Read, Bash, Grep, Glob` — **no `Write`, no `Edit`.**
- [ ] `domain_knowledge` carries a locked-rules table with the `ID | Checkable assertion |
      Detect | Severity | Owns/Overlap` columns.
- [ ] Most rows DEFER (cross-link `gsd-security`/`gsd-reviewer`/`gsd-qa`/`gsd-architect`);
      only genuinely-unowned checks are `New`.
- [ ] `tools_and_resources` (Task management) carries the `POST /api/findings`
      `finding_type='audit'` emission recipe with metadata fields.
- [ ] Compiled `.md` produced by `scripts/agent-compiler.cjs` (never hand-edited) and
      committed; byte-match test green.
- [ ] The agent is NOT added to `AGENTS_WITH_HOOKS`; `scripts/agent-compiler.cjs` is untouched.

---

*Shared read-only auditor agent format for v3.6 "The Immune System" (AUDT-01 / AUDT-03).*
*Source of truth: `.planning/research/v3.6/AGENT-INVENTORY.md` §5 + `DOMAIN-CHECKLISTS.md`.*
