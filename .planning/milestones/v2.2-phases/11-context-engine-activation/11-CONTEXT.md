# Phase 11: E-Phase Research-Informed Execution Mandate - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Make executors (4 executor agents + debugger) retrieve and cite failure patterns, SKB best-practices, existing codebase style, and a security checklist BEFORE writing code. Produces a structured `PRE_EXECUTION_EVIDENCE:` block prepended to E-phase RPETD content that `gsd-validator` parses as a free-standing advisory check (not a numbered gate). Advisory (warn + log + task metadata note) in v2.6; becomes a hard gate in v2.7 after measuring compliance. Applies to code-modifying tasks only — docs/config tasks skip with `PRE_EXECUTION_EVIDENCE: skipped — non-code task`.

</domain>

<decisions>
## Implementation Decisions

### Evidence Block Format
- **Parallel to LEARNING block** — same indented-field parsing the operator already does. One parser pattern for both block types.
- **Prepended to E-phase content** — single `$CLI rpetd` call, no pipeline changes. Evidence block at TOP of E-phase content (contract, not suggestion). Validator greps E-phase and expects the block at the top.
- **4 subfields, format matched to data source:**
  - `failure_patterns`: count + top citations with `APPLIED_LEARNING: mem-XXXX — reason` refs. Cap ≤300 chars.
  - `best_practices`: same count+citation format as failure_patterns. SKB entries get no special treatment — already reviewed. Cap ≤300 chars.
  - `existing_style`: file paths + brief pattern summary + **deviation flag** if planned approach doesn't match existing style. Cap ≤200 chars.
  - `security_checklist`: 8 items, each marked `applied` (with note), `n/a` (risk doesn't exist for this task), or `skipped because <reason>` (risk exists but intentionally deferred). Uncapped (naturally bounded by 8 items at ~80 chars each).
- **All 4 subfields present** — any non-empty block passes advisory check. Warn on missing subfields but don't fail in v2.6. v2.7 can tighten to require all 4.
- **Kill switch behavior:** `GSD_E_MANDATE=off` emits `PRE_EXECUTION_EVIDENCE: skipped — mandate disabled (GSD_E_MANDATE=off)`. One line. Validator sees intentional skip, not forgotten block. Absent block = executor forgot, skipped block = mandate off.

### Canonical Evidence Block Example
```
PRE_EXECUTION_EVIDENCE:
  failure_patterns: 3 found, 2 applied. APPLIED_LEARNING: mem-a1b2 — PG timeout on bulk insert. APPLIED_LEARNING: mem-c3d4 — race condition in claim. 1 not applicable.
  best_practices: 2 found, 1 applied. APPLIED_LEARNING: mem-e5f6 — use FOR UPDATE on jsonb read-modify-write. 1 not applicable.
  existing_style: RLM 5 chunks from src/services/pg_store.py, src/daemon.py. Pattern: snake_case, try/except with logging, type hints on public methods. No deviation from plan.
  security_checklist:
    input_validation: applied — validates task_id format before PG query
    sql_injection: applied — parameterized queries throughout
    xss: n/a — no HTML output
    path_traversal: n/a — no file path from user input
    auth_check: applied — OIDC token verified in do_POST prologue
    secret_leak: applied — API keys from env vars, not hardcoded
    rate_limiting: skipped because — daemon already has global rate limiter
    error_info_leak: applied — generic 500 message, details to server log only
```

### Security Checklist
- **All 8 items always evaluated** with liberal `n/a` for irrelevant items. Simpler, catches cross-cutting risks.
- **Domain-grouped in reference file** with clear headers (Backend: items 1-5, Frontend: 1,3,6,8, Infra: 1,4,7, General: all). Executors evaluate their section + always-applicable items.
- **n/a vs skipped semantics:** n/a = "this risk category doesn't exist for this task" (CSS task + SQL injection = n/a). Skipped = "risk exists but intentionally deferred" with mandatory reason. Validator warns on `skipped` without reason, does NOT warn on `n/a`.
- **Cargo-cult detection:** Validator actively greps for single-word responses ("checked", "done", "yes", "ok", bare "n/a" on `applied` items) and warns. Advisory in v2.6, block in v2.7.
- **Dynamic parsing:** Validator reads checklist item names from the reference file at runtime. Don't hardcode item names in the validator — extensible without code changes.
- **8 items (v2.6):** input_validation, sql_injection, xss, path_traversal, auth_check, secret_leak, rate_limiting, error_info_leak. Future items added by editing the reference file + bump.

### Mandate Placement in Executor Flow
- **R-phase stays as-is** (broad exploration). Mandate adds NEW failure-specific and style-specific queries at E-phase start. Different intent: R = "what do I need to know?", pre-E = "what has gone wrong before and how does this codebase do it?"
- **Reference file Read at E-phase start** — not at RPETD start. `cli-variables.md` is Read at RPETD start (general tooling). `pre-execution-checklist.md` is specific to execution — don't load during R or P phases.
- **Agent file placement:** Inside the E section header: "Before writing code, Read pre-execution-checklist.md." Closest to the action, no new top-level section needed. ~20-25 lines added per executor (well within +25% prompt budget).
- **P-phase provides target files** — executor needs to know WHICH files it's about to modify for the `--path <target>` RLM query. Source: P-phase plan lists target files/dirs. If P-phase doesn't list them, executor infers from task metadata file patterns.

### Domain Inference
- **Executor reads target file extension** to determine domain tags for failure-pattern queries: `.py` → `python,backend`, `.tsx` → `typescript,frontend`, `.tf` → `terraform,infrastructure`, etc.
- **Mixed-file tasks:** Union of all domains. `python,backend,typescript,frontend`. Better to over-query than miss a relevant failure pattern.
- **No dependency on task metadata or creator input** — the executor already knows what files it's modifying from P-phase plan.

### RLM Query Scope
- **R-phase = broad** `$RLM query "{task_topic}" --dir src/ --top-k 5` (topic exploration).
- **Pre-E = targeted** `$RLM query "<title>" --path <specific files being modified> --top-k 5` (style check on exact files).
- **Multi-file tasks:** One query against the broadest common directory. If files span unrelated directories, pick the two most relevant dirs max. Per-file is too expensive.
- **Enrichment dedup window (300s):** No collision — dedup key is the full query string. `--tags "failure,backend"` differs from broad R-phase topic search. Confirmed: no issue.

### Empty Results Handling
- **Zero results is valid** — greenfield work, new domain. Log `failure_patterns: 0 results — greenfield, no prior context` and proceed.
- **RLM unavailable:** `existing_style: RLM unavailable, skipped` is valid but should log a warning. RLM down = degraded state, not a skip.
- **All-empty block is valid** — validator does NOT warn on all-zero results. Only warns on missing block entirely. Evidence proves queries ran, not that they found anything.
- **Non-code tasks skip entirely:** `PRE_EXECUTION_EVIDENCE: skipped — non-code task`. Same code-task filter as Gate 1 (branch evidence).

### Agent Scope
- **5 agents get the mandate:** executor-backend, executor-frontend, executor-infra, executor-general, AND debugger. Bug fixes are where failure patterns matter most.
- **Checker does NOT verify evidence** — that's the validator's job. Checker = pre-exec plan quality, validator = post-exec evidence quality. Keep the separation.
- **Operator does NOT parse evidence blocks** — operator handles LEARNING + APPLIED_LEARNING (Phase 10). Validator handles PRE_EXECUTION_EVIDENCE. Each parser owns its block type.
- **APPLIED_LEARNING citations in evidence** are automatically picked up by the operator's existing all-phase citation scanner (Phase 10). No operator changes needed.

### Validator Advisory Behavior
- **Not a numbered gate** in v2.6. Free-standing advisory check outside the gate system. Gets a gate number when promoted to hard gate in v2.7.
- **Advisory means:** Log `[ADVISORY] PRE_EXECUTION_EVIDENCE missing` in validation output + write note to task metadata (visible in `amauta show`). Validation still PASSES. Task proceeds.
- **Partial block:** Any non-empty block passes advisory. Warn on missing subfields but don't fail.
- **Skipped items:** Validator warns on `skipped` without reason. Does not warn on `n/a`.
- **Cargo-cult grep:** Validator actively detects single-word responses on `applied` items. Advisory warn in v2.6.
- **Kill switch integration:** `GSD_E_MANDATE=off` → validator sees `skipped — mandate disabled` block → no advisory warning. `GSD_E_MANDATE=advisory` → validator checks for block → warns if missing.

### Mandate as Execution Input
- **Failure patterns SHOULD influence the plan** — if `mem-a1b2` says "PG timeout on bulk insert," the executor adjusts approach to batch inserts. The mandate is not purely documentary — it changes behavior.
- **Evidence-to-learning pipeline** — if pre-E surfaces a failure pattern and executor avoids it, D-phase LEARNING block should reference it: `APPLIED_LEARNING: mem-a1b2 — avoided PG timeout by using batch inserts`. This closes the loop: failure → avoidance → documented learning. Explicit in the mandate instructions, not left to judgment.

### Token Efficiency
- **Evidence block cost:** ~200-400 chars per task. Hard caps on subfields (300+300+200+uncapped security) keep it bounded. Acceptable.
- **Query cost:** 3 new queries per task (failure patterns, best practices, style match). Results capped by `--top-k 5` on RLM, memory search returns top-N by default. No additional cap needed — the evidence block caps force conciseness in what gets logged.
- **Reference file size:** ~80-120 lines. Read into context at E-phase start. Acceptable — same order as cli-variables.md. No need to split.
- **Phase-specific enrichment reconciliation:** v2.5 established E=RLM-only reduction. The mandate IS the E-phase enrichment — it replaces the old implicit rule with an explicit, structured mandate. Memory queries in pre-E are the intentional exception: failure patterns and best practices are load-bearing for the mandate's value. The mandate subsumes the v2.5 E-phase enrichment rule.

### Kill Switch
- **`GSD_E_MANDATE=advisory`** (default in v2.6): Evidence block advisory only. Validator warns on missing, doesn't fail.
- **`GSD_E_MANDATE=off`**: Executors skip mandate entirely, emit one-line skipped block. Validator silent.
- **No per-item override** in v2.6. `advisory|off` is sufficient. Per-item granularity (e.g., `security-only`) deferred to v2.7 after observing usage patterns.

### Compliance Metric
- **Per-task binary:** Did this task have a non-empty `PRE_EXECUTION_EVIDENCE` block in E-phase content?
- **Measured by:** `gsd-tools audit-rpetd-intelligence` scanning completed tasks. No new PG column, no dashboard. CLI batch audit.
- **Target:** >80% compliance after 1 week of Phase 11 being live (EXEC-04).
- **Operator compliance summary:** Deferred — not in Phase 11 scope. The CLI audit tool is sufficient for v2.6. Operator auto-surfacing is a future enhancement.

### Test Strategy
- **Unit tests:** Validator evidence-block parser (CJS) — finds blocks, warns on missing, handles partial blocks, cargo-cult detection grep, kill switch behavior.
- **Reference file existence:** Verify `pre-execution-checklist.md` exists and contains expected sections.
- **Kill switch test:** `GSD_E_MANDATE=off` disables warning, `=advisory` enables it.
- **Integration test:** Executor task → E-phase has evidence block → validator advisory passes.
- **Backward compat:** Leave existing e2e tests as pre-Phase-11 format. Add NEW test fixtures that include evidence blocks. Don't retrofit old tests — they prove backward compat.
- **Prompt budget:** Verify each executor stays within +25% line count after mandate addition.

### Claude's Discretion
- Exact wording of advisory warning messages
- Query template phrasing in the reference file (as long as failure/best-practice/style/security structure is preserved)
- Evidence block parser implementation details in gsd-validator
- How to handle edge cases in domain inference for uncommon file extensions
- Ordering of security checklist items within domain groups in the reference file

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Research
- `.planning/REQUIREMENTS.md` — EXEC-01 through EXEC-08 detailed specifications (lines 52-64)
- `.planning/research/v2.6/PITFALLS.md` — E1 (executors skip mandate), E3 (security cargo-cult), E4 (memory noise), C1 (prompt explosion)
- `.planning/research/v2.6/SUMMARY.md` — Correction 3: E-phase mandate advisory in v2.6, hard gate in v2.7
- `.planning/research/v2.6/ARCHITECTURE.md` — Integration points, LOC budget, phase-specific enrichment reduction

### Executor Agents (all 5 get the mandate)
- `agents/gsd-executor-backend.md` — RPETD protocol, R/P/E/T/D sections, cli-variables.md Read (171 lines, +25% max = ~213)
- `agents/gsd-executor-frontend.md` — Same structure (144 lines, +25% max = ~180)
- `agents/gsd-executor-infra.md` — Same structure (148 lines, +25% max = ~185)
- `agents/gsd-executor-general.md` — Same structure (151 lines, +25% max = ~189)
- `agents/gsd-debugger.md` — Scientific method executor, same risk profile (156 lines, +25% max = ~195)

### Validator
- `agents/gsd-validator.md` — Gates 1-4, quality gates section (186 lines). PRE_EXECUTION_EVIDENCE is a free-standing advisory check, NOT a numbered gate in v2.6.

### Phase 10 Infrastructure (reused)
- `get-shit-done/references/cli-variables.md` — Runtime Read pattern (5 tool vars + 2 artifact paths)
- `get-shit-done/references/learning-format.md` — LEARNING block format (parallel format for evidence block)
- `get-shit-done/config/tag-rules.json` — Tag governance (failure pattern queries use `--tags`)
- `agents/gsd-operator.md` — APPLIED_LEARNING citation scanner (lines 382-395). Greps all RPETD phases — automatically picks up citations from evidence blocks in E-phase. No operator changes needed.

### Existing Reference Pattern
- `get-shit-done/references/` — 15 existing reference files. `pre-execution-checklist.md` follows this pattern.

### RLM & Memory
- `get-shit-done/bin/gsd-memory.cjs` — `search --source --tags` filters (EXEC-05), `increment-applied` (Phase 10)
- `get-shit-done/bin/gsd-rlm.cjs` — `query --path --top-k` for targeted style matching (EXEC-06)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gsd-validator.md` Gate 2 parser: Already parses LEARNING blocks with structured field detection (lines 97-131). Evidence block parser follows the same grep + field extraction pattern.
- `gsd-operator.md` APPLIED_LEARNING scanner (lines 382-395): Greps all RPETD phases for `APPLIED_LEARNING: mem-XXXX`. Citations in evidence blocks are picked up automatically — no changes needed.
- `get-shit-done/references/cli-variables.md`: Runtime Read pattern established in Phase 10. `pre-execution-checklist.md` follows identical pattern (Read at phase start, fallback comments).
- `gsd-memory.cjs search --source --tags`: Existing filters for failure-pattern queries (EXEC-05). Already supports `--source auto_learning,lesson-learned` and `--tags "failure,<domain>"`.
- `gsd-rlm.cjs query --path --top-k`: Existing RLM query for targeted style matching (EXEC-06).

### Established Patterns
- **Runtime Read for references:** 15 files in `get-shit-done/references/`. Phase 11 reference file follows this pattern.
- **External validation:** Agents produce, validator validates. Applied to evidence blocks — executors emit, validator parses.
- **Kill switch per phase:** `GSD_E_MANDATE=advisory|off` follows `GSD_D_STRUCTURED=false` pattern from Phase 10.
- **Indented-field block format:** LEARNING blocks use `LEARNING:\n  WHAT:\n  WHY:\n  WHEN:`. Evidence blocks use `PRE_EXECUTION_EVIDENCE:\n  failure_patterns:\n  best_practices:\n  existing_style:\n  security_checklist:`.
- **Code-task-only gate filter:** Gate 1 (branch evidence) already distinguishes code vs non-code tasks. Evidence mandate reuses same filter logic.
- **Phase-specific enrichment:** v2.5 established E=RLM-only. Phase 11 mandate subsumes this — mandate IS the E-phase enrichment with intentional memory query addition.

### Integration Points
- All 5 agent files (`executor-backend.md`, `executor-frontend.md`, `executor-infra.md`, `executor-general.md`, `debugger.md`): Add ~20-25 lines in E-section header for mandate instructions + evidence block format.
- `agents/gsd-validator.md`: Add advisory check section (~15-20 lines) parsing E-phase content for PRE_EXECUTION_EVIDENCE block. Dynamic checklist item parsing from reference file.
- New file: `get-shit-done/references/pre-execution-checklist.md` — 4 query templates, 8-item security checklist (domain-grouped), evidence block example, kill switch docs, non-code task skip instruction. ~80-120 lines.
- No operator changes — APPLIED_LEARNING citations already scanned across all phases.
- No new PG columns — compliance measured by CLI batch audit.
- No new migration — purely additive prompt engineering + reference file.

</code_context>

<specifics>
## Specific Ideas

- "The whole point is catching style mismatches BEFORE they happen" — deviation flag in existing_style is load-bearing, not decorative
- "Don't invent a second format" — evidence block uses same indented-field parsing as LEARNING block
- "R = exploration, pre-E = targeted risk/style check" — clear intent separation, not redundant queries
- "v2.5 proved that 'be concise' doesn't work" — hard caps on evidence subfields, not guidance
- "Bug fixes are where failure patterns matter MOST" — debugger agent included despite requirements saying "4 executors"
- "Don't inflate gate count with advisory checks" — evidence check has no gate number until v2.7 hard-gate promotion
- "Evidence proves queries ran, not that they found anything" — all-empty block is valid on greenfield projects
- "Failure patterns SHOULD influence the plan" — mandate is not documentary, it changes executor behavior
- "Closes the loop: failure → avoidance → documented learning" — APPLIED_LEARNING citations in evidence feed back through D-phase
- "Dynamic parse from reference file" — validator reads checklist items at runtime, extensible without code changes
- "Absent block = executor forgot, skipped block = mandate off" — semantic distinction via one-line skip marker
- "Each parser owns its block type" — operator owns LEARNING/APPLIED_LEARNING, validator owns PRE_EXECUTION_EVIDENCE

</specifics>

<deferred>
## Deferred Ideas

- **Per-item kill switch granularity** (e.g., `GSD_E_MANDATE=security-only`) — deferred to v2.7 after observing usage patterns. Advisory|off sufficient for v2.6.
- **Operator compliance summary** at phase exit (e.g., "8/10 tasks had evidence, 2 missing") — deferred. CLI batch audit via `gsd-tools audit-rpetd-intelligence` is sufficient for v2.6.
- **E-phase enrichment reduction reconciliation doc** — the mandate subsumes v2.5's E=RLM-only rule. A formal doc update can land in a tech-debt pass.
- **Per-file RLM style queries** for multi-file tasks — deferred due to token cost. Use broadest common directory instead.
- **Security checklist item expansion** (dependency audit, license check, etc.) — v2.7+. Reference file is dynamically parsed, so adding items is just a file edit.

</deferred>

---

*Phase: 11-context-engine-activation*
*Context gathered: 2026-04-09*
