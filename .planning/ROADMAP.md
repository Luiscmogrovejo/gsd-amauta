# Roadmap: GSD-Amauta v2.6 "Sight Beyond Sight"

**Milestone:** v2.6 — Sight Beyond Sight (RPETD Intelligence Upgrade)
**Starting phase number:** 9 (previous milestone v2.5 ended at phase 8)
**Phases:** 7 (Phase 9..15)
**Requirements:** 46 total (v2.6 scope)
**Granularity:** coarse (per config.json)
**Research inputs:**
- `.planning/research/v2.6/STACK.md`
- `.planning/research/v2.6/FEATURES.md`
- `.planning/research/v2.6/ARCHITECTURE.md`
- `.planning/research/v2.6/PITFALLS.md`
- `.planning/research/v2.6/SUMMARY.md` (5 course corrections)
- `~/.claude/plans/reactive-watching-fountain.md` (original approved plan)

**Core value:** Every RPETD phase must *see* what the other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats.

**Ship order is LOCKED** by research (SUMMARY.md Correction 1). Tech-debt first → D-phase (unlocks tag schema) → E-phase (pre-exec mandate) → T-phase + R-phase (parallel) → P-phase (highest blast radius, last) → Dogfood (terminal).

---

## Hard Constraints (apply to every phase)

1. **Prompt-size budget (context rot defense):** NEW agent definitions must be ≤ 200 lines. Existing agents may grow by max +25%. `gsd-roadmapper.md` is grandfathered at 685 lines but MUST NOT grow. Enforced per phase at plan review.
2. **Kill switch per phase:** Every upgrade ships with an env var kill switch so it can be disabled without code revert. Documented in each phase detail.
3. **Pitfall citations:** Every phase must reference at least one PITFALLS.md entry it prevents and the prevention mechanism.
4. **Green test gate:** `npm test && pytest` must pass with 0 new failures before the phase is marked complete.
5. **Phase 10 quarantine:** Phase 10 (D-learning) ships with a 2-week additive/reversible quarantine before Phase 11 work starts.
6. **External validation principle (v2.5 AGT-05):** Evidence blocks must be inspected by `gsd-validator` or a deterministic check — never the executor itself.

---

## Phases

- [x] **Phase 9: Tech-Debt Sweep** — Green baseline (`npm test && pytest` = 0 failures) before any v2.6 mandate lands — DONE (all 6 TECH + 4 GAP plans complete)
- [x] **Phase 10: D-Phase Structured Learning + CLI Dedup** — WHAT/WHY/WHEN/TAGS format, `gsd-memory learn --structured`, cli-variables.md reference, 2-week quarantine — DONE (9 plans, 62 new tests, LEARN-01..07 complete)
- [x] **Phase 11: E-Phase Research-Informed Execution Mandate** — Pre-exec checklist reference, `PRE_EXECUTION_EVIDENCE` block, security checklist, advisory validation in v2.6 (Plan 11-01 DONE) (completed 2026-04-10)
- [x] **Phase 12: T-Phase QA Department + Spec Inheritance** — `_inherit_parent_spec()` helper, parent G/W/T verification, edge cases, regression sweep, RED-GREEN back-testing — DONE (4 plans, QA-01..08 complete)
- [x] **Phase 13: R-Phase Creative Research (Narrowed)** — Task-type gated creative variants, `gsd-research --creative` flag, conservative default for implementation tasks — DONE (3 plans, CREATIVE-01..05 complete) 2026-04-10
- [x] **Phase 13.1: Orchestrator Hardening & Divergence Protocol** — Deterministic manifest check + behavioral divergence protocol + agent .md updates + validator `--gaps-found` verdict + synthetic divergence test — DONE (5 plans, HARDEN-01..05 complete, 3 dogfood moments captured, validator `--pass`) 2026-04-10
- [ ] **Phase 14: P-Phase Task-Management Integration** — Structured XML plan blocks, `gsd-tools plan-to-tasks`, auto-agent-assign, dep-linking, 10-task cap
- [ ] **Phase 15: End-to-End Dogfood Verification** — `audit-rpetd-intelligence`, `verify-v26.sh`, 6/6 phases green observational report

---

## Phase Details

### Phase 9: Tech-Debt Sweep

**Goal:** Get `npm test && pytest` to 0 failures before any v2.6 mandate lands, so flake counts don't compound as new mandates add I/O per test.

**Depends on:** Nothing (first v2.6 phase; blocks all downstream work)

**Requirements:** TECH-01, TECH-02, TECH-03, TECH-04, TECH-05, TECH-06

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Fix `oidc_enabled`/`oidc_issuer` regex helper in `tests/test_daemon_integration.py` | TECH-01 |
| 2 | Fix mock StopIteration (fixture exhaustion) in `tests/test_enrichment_memory.py` (3 tests) | TECH-02 |
| 3 | Fix `tests/test_gates.py::test_exactly_5_gates_returned` gate-count assertion drift | TECH-03 |
| 4 | Fix `tests/test_pg_integration.py::TestRetentionMovesOldEntries` retention cleanup flake | TECH-04 | DONE (09-04) |
| 5 | Fix 15s timeout flakes in `tests/e2e-lifecycle.test.cjs` claim/RPETD R-P-E-T phases (daemon-busy race) | TECH-05 | DONE (09-05) |
| 6 | Fix `tests/gsd-amauta.test.cjs::12. task status after validate` (status stuck at "pending") | TECH-06 | DONE (09-05) |

**Success Criteria (what must be TRUE for users):**
1. `pytest` runs to completion with 0 failures on a clean checkout.
2. `npm test` runs to completion with 0 failures on a clean checkout.
3. `tests/e2e-lifecycle.test.cjs` claim/RPETD phases complete inside the 15s timeout budget across 5 consecutive local runs.
4. `amauta validate --pass` transitions task state to `validated` (not stuck at `pending`) verifiable via `amauta show TK-XXXX`.
5. Baseline CI pass rate matches or beats v2.5 final (79%+ gates) as reported by `verify-v26.sh` pre-merge check.

**Kill switch:** N/A (pure tech-debt cleanup, no new feature to disable).

**Pitfalls Prevented:**
- **C4 — Test Flakiness Amplification** (PITFALLS.md): "Adding more mandates on top of a flaky base amplifies flakes." Prevention: fix the flaky base before any v2.6 mandate adds I/O per test.
- **T8 — Edge cases collide with existing test flakes**: prevented by fixing baseline before T-phase mandates land.

**Rollback Plan:** Each test fix is an independent commit; revert individual commits if a fix introduces regressions. Baseline reverts to v2.5-final (6 pytest + 34 CJS known failures) which is the known-good state.

**Plans:**
- [x] 09-01: TECH-01 — Fix `_extract_health_fields` regex (oidc_enabled/oidc_issuer)
- [x] 09-02: TECH-02 — Sync E/T-phase enrichment tests to TOK-02 behavior (commit e64c6fe)
- [x] 09-03: TECH-03 — Fix gate count assertion (5→7)
- [x] 09-04: TECH-04 — Fix retention mock (PropertyMock [5,3]→[5,3,2])
- [x] 09-05: TECH-05 — Fix e2e-lifecycle 15s timeout flakes (b371477)
- [x] ~~09-06: TECH-06~~ — (virtual ref, bundled in 09-05 as commit 2f8ab46)
- [x] 09-06: GAP — Fix comprehensive-e2e.test.cjs (4 failures: substance gates + migration count + README routes) DONE (440115c)
- [x] 09-07: GAP — Fix e2e-advanced.test.cjs (3 failures: substance gate fixtures) DONE (b64b93a)
- [x] 09-08: GAP — Fix complex-integration.test.cjs (7 failures: substance gates + amauta_memory ref) (1eee7e4)
- [x] 09-09: GAP — Fix perplexity-config + auto-learning + e2e-lifecycle (3 failures: search windows + rate limit) DONE (31680cc)

---

### Phase 10: D-Phase Structured Learning + CLI Dedup

**Goal:** Ship WHAT/WHY/WHEN/TAGS structured learning format as a HUMAN-REVIEW and SKB-promotion layer (NOT a retrieval optimizer — free-text + embeddings still wins recall). Pair with `cli-variables.md` shared reference to dedupe boilerplate across all 11 agents. Must land first because every downstream phase reads from its tag schema.

**Depends on:** Phase 9 (needs green baseline)

**Requirements:** LEARN-01, LEARN-02, LEARN-03, LEARN-04, LEARN-05, LEARN-06, LEARN-07

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `get-shit-done/references/learning-format.md` with WHAT/WHY/WHEN/TAGS template + per-agent examples | LEARN-01 |
| 2 | `gsd-memory.cjs learn --structured` flag parses fields into existing `tags jsonb` column (NO new PG column) | LEARN-02 |
| 3 | `gsd-memory.cjs search --category --tags` text filters + verified GIN index on `tags jsonb` | LEARN-03 |
| 4 | Tag-inflation defense: ≤5 tags per learning, reject tags-only matches to generic set | LEARN-04 |
| 5 | Echo-chamber defense: `applied_count` column + `APPLIED_LEARNING:` citation tracker + SKB manual review gate >10 | LEARN-05 |
| 6 | All 11 agents updated to emit structured LEARNING blocks per template | LEARN-06 |
| 7 | `get-shit-done/references/cli-variables.md` shared CLI var declarations referenced via runtime Read (NOT `@` include) | LEARN-07 |

**Success Criteria (what must be TRUE for users):**
1. An operator can run `gsd-memory learn --structured --what "..." --why "..." --when "..." --tags "postgresql,threading"` and see the record in `gsd_memory` with tags stored in the `tags jsonb` column.
2. `gsd-memory search --tags postgresql --category pattern` returns matching learnings in < 50ms (measured by GIN index query plan).
3. An operator reviewing recent learnings via `gsd-memory search` sees structured WHAT/WHY/WHEN/TAGS fields in the output for every learning emitted after Phase 10 lands (legacy free-text still searchable).
4. Attempting to store a learning with only generic tags (`best-practice`, `lesson`, etc.) is rejected with a guidance message; attempts with > 5 tags are auto-trimmed to 5 by tier ranking with a warning (per plan 10-03 spec).
5. `gsd-memory skb candidates` excludes any learning with `applied_count > 10` until manually reviewed, visible via the `needs_review` field in the output.
6. Every agent in `agents/*.md` references `cli-variables.md` via runtime Read at start of RPETD protocol; `CLI=`/`RLM=`/`MEM=`/`RESEARCH=` variables no longer duplicated inline across agent files.

**Kill switch:** `GSD_D_STRUCTURED=false` — disables structured learning parser; `gsd-memory learn --structured` falls back to free-text storage; `--category`/`--tags` filters return all rows.

**Pitfalls Prevented:**
- **D1 — Cargo-cult template-filling** (PITFALLS.md): prevented by `applied_count` echo-chamber defense and manual SKB review gate.
- **D2 — Tag inflation** (`best-practice,general,lesson` everywhere): prevented by 5-tag cap + banned-generic-tags rejection.
- **D5 — Feedback-loop instability**: prevented by 2-week quarantine window before Phase 11 ships — learnings are additive/reversible during quarantine.
- **AF3 — "Structured formats make retrieval better"**: accepted for human review, rejected for retrieval; format lives inside existing `tags jsonb`, free-text + embeddings remain primary retrieval path.

**Rollback Plan:** Set `GSD_D_STRUCTURED=false`. Structured-format reference files (`learning-format.md`, `cli-variables.md`) stay on disk as inert references. Agent file changes are small per-file diffs (runtime Read line + LEARNING block template) — reverted via single commit. `tags jsonb` GIN index stays (harmless). No schema migration to undo.

**Plans:**
9/9 plans complete
- [x] 10-02: Migration 008 — `applied_count` column + DOWN (LEARN-05) — wave 1 — DONE 2026-04-09 (6307d93 + 72ff620)
- [x] 10-03: gsd-memory.cjs core — `parse-learning` + `learn --structured` + `normalizeTags` from tag-rules.json + distill guard (LEARN-02, LEARN-04) — wave 2 — DONE 2026-04-09 (b5e06de + 1eac6ab + 31088df)
- [x] 10-04: pg_store.py + daemon API — tag validation + structured metadata + `/api/memory/:id/increment-applied` + `/api/memory/skb-candidates` + search `--tags`/`--category` (LEARN-02, LEARN-03, LEARN-04, LEARN-05) — wave 2 — DONE 2026-04-09 (ec22631 + ab713bc + 05ebb2f + 90e4aa5)
- [x] 10-05: gsd-memory.cjs SKB commands — `skb candidates`, `skb-promote --reviewed`, `skb-remove`, `increment-applied`, search `--tags`/`--category` + structured card display (LEARN-03, LEARN-05) — wave 2 — DONE 2026-04-09 (7f515ca + 41139b7 + 6ee63ee + 1fac128); also added do_PATCH + do_DELETE daemon HTTP verbs + GET/PATCH /api/memory/mem- + GET/DELETE /api/skb/skb- routes + pg_store memory_get_by_id/memory_patch_metadata/skb_get_by_id/skb_delete
- [x] 10-06: gsd-operator.md + gsd-validator.md — structured LEARNING detection + APPLIED_LEARNING citation scanner + Gate 2 dual-format acceptance (LEARN-02, LEARN-05, LEARN-06) — wave 3 — DONE 2026-04-09 (2264177 gsd-memory-learn-blocks.sh helper + dca5ada operator D-phase structured storage + 0d9d997 operator APPLIED_LEARNING scanner + 8ec1284 validator Gate 2 dual-format)
- [x] 10-07: CLI variables dedup — cli-variables.md Read across 11 agents + 6 workflows (LEARN-07) — wave 3 — **SEPARATE COMMIT 1 of 2** — DONE 2026-04-09 (923510e refs(LEARN-07) dedup across 11 agents + 6 workflows)
- [x] 10-08: LEARNING block template across 11 agents with per-agent examples (LEARN-06) — wave 3 — **SEPARATE COMMIT 2 of 2** — DONE 2026-04-09 (01d05f8 refs(LEARN-06) structured LEARNING block template across 11 agents)
- [x] 10-09: Tests (unit + integration + regression) + README documentation (LEARN-01..LEARN-07) — wave 4 — DONE 2026-04-09 (232799b..8cf2d20: 4 CJS test files + 2 pytest files + README Phase 10 section + daemon query-param fix)

---

### Phase 11: E-Phase Research-Informed Execution Mandate

**Goal:** Make executors retrieve and cite failure patterns, SKB best-practices, existing style, and a security checklist BEFORE writing code. Produces a structured `PRE_EXECUTION_EVIDENCE:` block inside E-phase RPETD content that `gsd-validator` parses. Advisory (warn + log) in v2.6; becomes a hard gate in v2.7 after measuring compliance.

**Depends on:** Phase 10 (uses tag schema for failure-pattern queries; reuses runtime Read pattern from `cli-variables.md`)

**Requirements:** EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, EXEC-07, EXEC-08

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `get-shit-done/references/pre-execution-checklist.md` with 4 query templates + 8-item security checklist | EXEC-01 |
| 2 | All 4 executor agents gain 3-line `<pre_execution_mandate>` runtime Read block | EXEC-02 |
| 3 | E-phase RPETD content includes structured `PRE_EXECUTION_EVIDENCE:` block (4 subfields) | EXEC-03 |
| 4 | `gsd-validator` parses evidence block; logs advisory WARNING if missing/empty (no hard fail in v2.6) | EXEC-04 |
| 5 | `gsd-memory search --source auto_learning,lesson-learned --tags "failure,<domain>"` wired into executor pre-code flow | EXEC-05 |
| 6 | `gsd-rlm query "<title>" --path <dir> --top-k 5` wired into executor pre-code flow for style matching | EXEC-06 |
| 7 | Security checklist items each marked `applied` (note), `n/a` (reason), or `skipped because <reason>` | EXEC-07 |
| 8 | Executor D-phase learning cites `APPLIED_LEARNING:` OR explicitly notes "no applicable prior learnings" | EXEC-08 |

**Success Criteria (what must be TRUE for users):**
1. On any executor task, E-phase RPETD content contains a non-empty `PRE_EXECUTION_EVIDENCE:` block with the 4 subfields populated (verifiable via `amauta show TK-XXXX | grep PRE_EXECUTION_EVIDENCE`).
2. `gsd-validator` logs an advisory WARNING (not a fail) in `validation` output when `PRE_EXECUTION_EVIDENCE:` is missing or empty; validation still passes if other gates are green.
3. An operator reading a v2.6 executor task's E-phase content sees at least one of the 8 security checklist items with a concrete applied/n-a/skipped reason (not generic "checked").
4. Gate 6 evidence parse rate across v2.6 executor tasks is > 80% after 1 week (measured by `gsd-tools audit-rpetd-intelligence` batch report).
5. `pytest && npm test` pass rate is unchanged from Phase 10 baseline (no regression in executor task failure rate).
6. Every completed executor task's D-phase content contains either an `APPLIED_LEARNING:` citation or an explicit "no applicable prior learnings" note.

**Kill switch:** `GSD_E_MANDATE=advisory` (default in v2.6) makes evidence block advisory only. `GSD_E_MANDATE=off` disables the mandate entirely — executors revert to v2.5 behavior.

**Pitfalls Prevented:**
- **E1 — Executors skip the mandate**: prevented by external validator parsing the evidence block (not self-validation), per v2.5 AGT-05 principle.
- **E3 — Security checklist cargo-cult**: prevented by requiring concrete applied/n-a/skipped reasons per item — generic "checked" strings are flagged.
- **E4 — Memory queries return task_event noise**: prevented by explicit `--source auto_learning,lesson-learned,best-practice` filter in EXEC-05.
- **C1 — Prompt size explosion**: prevented by shared reference file + 3-line runtime Read (NOT `@` include, which doesn't work in agent .md), avoiding 4× duplication across executors.

**Rollback Plan:** Set `GSD_E_MANDATE=off`. 3-line runtime Read blocks in each executor agent revert via single commit per file. `pre-execution-checklist.md` stays on disk as inert reference. `gsd-validator` parser block guarded by the env var — no code revert needed beyond flipping the flag.

**Plans:**
2/2 plans complete
- [ ] 11-02: gsd-validator advisory PRE_EXECUTION_EVIDENCE parser — logs WARNING if missing, does NOT fail validation in v2.6 (EXEC-04) — wave 2

---

### Phase 12: T-Phase QA Department + Spec Inheritance

**Goal:** Blocked on missing `_inherit_parent_spec()` helper at `amauta.py:2218`. Ships as commit 1 of this phase. Validator checks each parent G/W/T criterion individually. Edge cases, regression sweep, and RED-GREEN back-testing MANDATORY for bug-fix tasks.

**Depends on:** Phase 11 (T-phase checker validates E-phase's `PRE_EXECUTION_EVIDENCE:` block, so E must land first)

**Requirements:** QA-01, QA-02, QA-03, QA-04, QA-05, QA-06, QA-07, QA-08

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `amauta.py _inherit_parent_spec(item)` helper called from `_enrich_task_context()` at line 2218 | QA-01 |
| 2 | `amauta show TK-XXXX --json` adds `inherited_success_criteria` field; `--no-inherit` flag | QA-02 |
| 3 | `gsd-checker.md` `<post_check_mode>` pulls parent `success_criteria`, logs per-criterion pass/fail in T-phase | QA-03 |
| 4 | `gsd-validator.md` Gate 6 "parent-story criteria individually verified" (advisory in v2.6.2, hard gate in v2.6.3) | QA-04 |
| 5 | Edge-case generation: checker requires 2+ edge cases per happy-path criterion in `EDGE_CASES:` block | QA-05 |
| 6 | Regression sweep: `test-phase.md` instructs full `npm test && pytest` with before/after counts in `REGRESSION:` block | QA-06 |
| 7 | Adversarial testing for code with `security-sensitive: true` metadata (path traversal, injection, etc.) | QA-07 |
| 8 | RED-GREEN back-testing MANDATORY for bug-type tasks (RED commit before GREEN commit, verified via `git log --grep`) | QA-08 |

**Success Criteria (what must be TRUE for users):**
1. `amauta show TK-XXXX --json` on any task with a parent story emits an `inherited_success_criteria` array containing the parent's G/W/T criteria (verifiable on any existing task with a parent in the test fixtures).
2. Every v2.6 code task's T-phase RPETD content contains a non-empty `EDGE_CASES:` block with ≥ 2 edge cases per happy-path criterion (verifiable via `gsd-tools audit-rpetd-intelligence`).
3. Every v2.6 code task's T-phase RPETD content contains a `REGRESSION:` block with `before:` and `after:` test counts (e.g., `before: 2479p/0f, after: 2479p/0f`).
4. Every bug-type task's commit graph shows a RED commit (reproducing the bug) before a GREEN commit (fix), verifiable via `git log --grep="(T|E)" --reverse` against the task ID.
5. Parent-story spec inheritance rate is > 90% on tasks with a parent after 1 week (measured by `gsd-tools audit-rpetd-intelligence` batch report).
6. `gsd-validator` emits advisory Gate 6 warnings (NOT hard fails) when parent criteria are missing evidence in T-phase — validation still passes.

**Kill switch:** `GSD_T_SPEC_INHERIT=false` — disables the `_inherit_parent_spec` walk; falls back to task-only `success_criteria` as in v2.5.

**Pitfalls Prevented:**
- **T1 — Parent story G/W/T too vague**: surfaced by `_inherit_parent_spec` which emits `[INHERITED SPEC from ST-XXXX]` block — empty criteria become visible immediately.
- **T2 — Edge case bloat (20 useless tests)**: prevented by cap (2 edge cases per criterion, justification required); not 20.
- **T5 — Back-testing on missing repro**: QA-08 applies ONLY to bug-type tasks (forward-testing remains the default for feature tasks).
- **T6 — G/W/T inheritance breaks on rename**: prevented by snapshot-at-atomization-time; parent change triggers explicit `amauta task resync-criteria` (not auto).
- **T7 — Trajectory evaluation theatre**: deliberately NOT added in v2.6 (deferred to v2.7 per research).

**Rollback Plan:** Set `GSD_T_SPEC_INHERIT=false`. `_inherit_parent_spec()` helper stays on disk but is guarded. Agent `<spec_inheritance_protocol>` + `<qa_mandate>` blocks revert via commit per file. Gate 6 validator logic is env-var-guarded — flip the flag, no revert needed.

**Plans:**
- [x] 12-01: Python _inherit_parent_spec() helper + cmd_show --json inherited_success_criteria + --no-inherit (QA-01, QA-02) -- wave 1 -- DONE 2026-04-09 (commits 4ccd2dd, 05f5553, 77e699f)
- [x] 12-02: qa-checklist.md reference + gsd-checker.md update + agent-capabilities security_patterns (QA-03, QA-04, QA-05) -- wave 2 -- DONE 2026-04-09 (commits 52d67ff, c781bfe, b9f887a, bbee0b1)
- [x] 12-03: test-phase.md regression sweep + gsd-validator advisory + checkSpecInheritanceAdvisory + _checkQaBlocks + _checkRedGreenOrder (QA-04, QA-05, QA-06, QA-07, QA-08) -- wave 2 -- DONE 2026-04-09 (commits 1900dd5, 8f8d7ee, 47f32ac)
- [x] 12-04: Tests (Python + CJS) + STATE.md baseline section (QA-01..QA-08) -- wave 3 -- DONE 2026-04-09 (commits e4cac87, cadef90, 3b4df58, 8a114ee)

---

### Phase 13: R-Phase Creative Research (Narrowed)

**Goal:** Creative query variants (lateral, inversion, anti-pattern, cross-domain) gated behind task-type classification. Run ONLY for research/exploration/architecture-review tasks. Implementation tasks (type=task|bug with code file patterns) continue using v2.5 conservative single-query cascade. Prevents JetBrains Junie 3x rollback rate documented for novel suggestions in code tasks.

**Depends on:** Phase 11 (parallel with Phase 12 — R-creative and T-QA are architecturally independent; both depend on E-mandate being measurable before R/T land)

**Requirements:** CREATIVE-01, CREATIVE-02, CREATIVE-03, CREATIVE-04, CREATIVE-05

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `get-shit-done/references/creative-research.md` with 5 query transformation techniques documented | CREATIVE-01 |
| 2 | `gsd-research.cjs --creative` flag emits 3 variant queries per input, runs each through 5-step cascade, Jaccard dedups | CREATIVE-02 |
| 3 | Task-type gating: auto-enable `--creative` only for `type in (epic, story)` OR `task_type in (research, exploration, architecture-review, pattern-search)` | CREATIVE-03 |
| 4 | `gsd-researcher.md` `<creative_protocol>` section: when to use `--creative` vs conservative cascade | CREATIVE-04 |
| 5 | Perplexity token budget monitoring: per-variant usage logged; total cost delta < 20% vs baseline on 10 comparable tasks | CREATIVE-05 |

**Success Criteria (what must be TRUE for users):**
1. Running `gsd-research search "topic" --creative` emits 3 distinct variant queries (labeled direct / inversion / anti-pattern) with deduped results, visible in the CLI output.
2. Running `gsd-research search "topic"` (no `--creative`) against an implementation task (type=task with .py/.ts files) returns the v2.5 single-query cascade unchanged.
3. `gsd-researcher` auto-enables `--creative` only for tasks matching the gating criteria; an operator reviewing R-phase content on a `type=bug` task sees a single-query cascade, not 3 variants.
4. Perplexity token cost delta across 10 comparable v2.6 R-phase tasks is < 20% vs v2.5 baseline (measured by per-variant usage log).
5. Zero new hallucinated API calls appear in creative-mode R-phase output compared to baseline (manual audit on 10 tasks).

**Kill switch:** `GSD_R_CREATIVE=off` — disables creative variants entirely; all R-phase calls fall back to conservative single-query cascade regardless of task type.

**Pitfalls Prevented:**
- **R1 — Creative prompting adds noise, not lift, for codebase-grounded research**: prevented by task-type gating — only brainstorm/architecture/research tasks get variants; code tasks stay conservative.
- **R2 — Perplexity token bloat 3-5x**: prevented by 3-variant cap (not 5) + per-variant 500-char response cap + Redis cache dedup + budget monitoring gate.
- **R3 — Dedup failures (same finding 5 times)**: prevented by post-variant Jaccard dedup running AFTER all variants return.
- **R5 — Overfitting to novelty (3x rollback rate)**: prevented by gating — creative mode never fires on implementation tasks where novelty is punished.

**Rollback Plan:** Set `GSD_R_CREATIVE=off`. `--creative` flag in `gsd-research.cjs` stays but dormant. `gsd-researcher.md` `<creative_protocol>` block reverts via single commit. `creative-research.md` reference stays on disk as inert documentation.

**Plans:**
3/3 plans complete
- [x] 13-02: Creative cascade wiring + agent updates -- cmdSearch creative loop + providerPerplexity._creative + creative log + JSON/human output + gsd-researcher.md creative_protocol + gsd-operator.md execution_type + execute-phase.md flags (CREATIVE-02, CREATIVE-03, CREATIVE-04, CREATIVE-05) -- wave 2, depends on 13-01 -- DONE 2026-04-10
- [x] 13-03: Tests (30 CJS) + STATE.md baseline update (CREATIVE-01..05 coverage) -- wave 3, depends on 13-01 + 13-02 -- DONE 2026-04-10

---

### Phase 13.1: Orchestrator Hardening & Divergence Protocol

**Goal:** Install deterministic manifest-check utility + behavioral divergence protocol across executors and validator to prevent the Phase 13 silent scope-expansion failure mode. Ship the mechanical halt (HARDEN-01) paired with the behavioral decision tree (HARDEN-02) + agent .md updates (HARDEN-03) + validator `--gaps-found` third verdict (HARDEN-04) + synthetic divergence test suite (HARDEN-05).
**Requirements:** HARDEN-01..05 (5)
**Depends on:** Phase 13
**Plans:** 5 plans, 18 commits total (3 Wave 1 + 1 amend + 8 Wave 2 + 1 amend + 5 Wave 3)
**Status:** DONE — validator verdict `--pass`, all 5 requirements verified 2026-04-10

Plans:
- [x] 13.1-01: HARDEN-01 Manifest Enforcement — `manifestCheck` utility + `execute-phase.md` wiring + STATE/REQUIREMENTS docs (3 tasks) — DONE
- [x] 13.1-02: HARDEN-02 Divergence Protocol Reference File — `references/divergence-protocol.md` v1.0.0 (1 task) — DONE
- [x] 13.1-03: HARDEN-03+04 Agent .md Mechanical Updates — 4 executor .md files + validator .md vocabulary lock (5 tasks) — DONE
- [x] 13.1-04: HARDEN-04 Validator `--gaps-found` CLI + Routing — `cmdValidate` + gaps-report + execute-phase routing (2 tasks) — DONE
- [x] 13.1-05: HARDEN-05 Synthetic Divergence Test + Wave 1+2 fold-ins — deterministic + behavioral test suites, CI workflow, 4 folded fixes (5 tasks) — DONE

Notable: 3 in-production dogfood moments captured at 3 recursion depths (Wave 1 first-invocation, Wave 2 meta-recursive protocol self-application during its own creation, Wave 3 near-miss at hard ceiling with explicit rationalization-naming). Phase 13 incident replay test present and passing. Hard ceiling on task 13.1-05-05 held against a Phase-13-shaped rationalization ("the helper is useless if nothing consumes it") — executor resisted, verified via `git diff`, flagged for Phase 14 cleanup. Validator bound by the vocabulary lock + pre-gate divergence scan + never-invent-req-IDs rules that this same phase installed, and returned clean.

### Phase 14: P-Phase Task-Management Integration (LAST — highest blast radius)

**Goal:** When the planner outputs tasks, they are AUTOMATICALLY registered in amauta with full metadata (title, description, deps, G/W/T criteria, parent story, agent assignment) via structured XML in PLAN.md + workflow tool for 2-pass dep linking. Ships LAST because it has the highest blast radius on task topology — every other phase must be measured-stable before this lands.

**Depends on:** Phase 12 (uses Phase 12's `_inherit_parent_spec` helper to propagate inherited success criteria into emitted child tasks; also depends on Phases 10, 11, 13 being stable since P-phase touches task topology for all of them)

**Requirements:** PLAN-01, PLAN-02, PLAN-03, PLAN-04, PLAN-05, PLAN-06, PLAN-07

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `gsd-planner.md` `<planning_protocol>` emits structured XML plan block with `<task>` elements | PLAN-01 |
| 2 | `gsd-tools.cjs plan-to-tasks <plan-file>` subcommand parses XML, 2-pass walk (create, then link deps), idempotent | PLAN-02 |
| 3 | Auto-agent-assignment via `agent-capabilities.json` file-pattern matching + performance tiebreaker | PLAN-03 |
| 4 | Auto-dep-linking from explicit `depends_on` XML field + implicit ordering with `parallel: true` opt-out | PLAN-04 |
| 5 | Runaway defense: 10-task hard cap per plan; plans exceeding cap error out with guidance | PLAN-05 |
| 6 | `plan-phase.md` fails plan review if any sub-task lacks `--agent`, has dep cycle, or exceeds 10 tasks | PLAN-06 |
| 7 | P-phase RPETD content includes structured output: task IDs, agent assignments, dep DAG text, inherited criteria | PLAN-07 |

**Success Criteria (what must be TRUE for users):**
1. Running `gsd-tools plan-to-tasks <plan-file>` on a valid PLAN.md emits N task IDs with agent assignments and dependency edges visible in `amauta board`.
2. Re-running `gsd-tools plan-to-tasks <plan-file>` on the same plan is idempotent — no duplicate tasks created, exits with "N tasks already exist, skipping".
3. Attempting to register a plan with > 10 sub-tasks fails with a clear guidance message ("plans over 10 tasks must be split — split boundary suggestion: …"); no partial task creation.
4. Every auto-created task has a non-null `--agent` assignment visible via `amauta show TK-XXXX` (100% coverage — no defaults beyond `executor-general` for no-match cases).
5. Attempting to register a plan with a circular dependency fails at plan time (not execution time) with the cycle printed.
6. P-phase RPETD content on any plan shows the created task IDs, their agents, and a text DAG of dependencies, verifiable via `amauta show TK-XXXX` on the parent story.

**Kill switch:** `GSD_P_AUTO_TASK=false` — disables `plan-to-tasks` parser; planner falls back to prose output and manual `amauta add task` calls as in v2.5.

**Pitfalls Prevented:**
- **P1 — Runaway sub-task creation (50 when 5 would do)**: prevented by 10-task hard cap + guidance-message error.
- **P2 — Wrong agent assignment from file-pattern matching**: prevented by reusing v2.5 `routeExecutor` logic + performance tiebreaker (AGT-02 already shipped).
- **P3 — Circular dependency linking**: prevented by DAG validation on plan save — cycles rejected at plan time, not execution time.
- **P5 — Plans unreadable ("black-box planning")**: prevented by PLAN-07 structured RPETD output showing task IDs + agents + DAG in readable form.
- **P8 — Spurious dependency inference**: prevented by requiring explicit `depends_on` fields; implicit ordering has explicit `parallel: true` opt-out.
- **C5 — Solo-developer rollout risk**: prevented by shipping P-phase LAST, so all prior phases are measured-stable before task topology changes.

**Rollback Plan:** Set `GSD_P_AUTO_TASK=false`. `plan-to-tasks` subcommand stays in `gsd-tools.cjs` but is never invoked. Planner prompt changes revert via single commit. Existing PLAN.md files are unaffected (they were never parsed for amauta registration before v2.6).

**Plans:**
- [x] 14-01: Protocol & Schema Foundation — divergence-protocol v1.1.0 + plan-task-xml-schema.md + gsd-planner Read pointer (PLAN-01) — Wave 1 — DONE 2026-04-10 (7b8b887 + bfe0272)
- [x] 14-02: Dedup Bypass + Pass 0 Validation Engine — planToTasks() Pass 0 engine + scoped dedup bypass + 20 unit tests (PLAN-02/03/04/05) — Wave 2 — DONE 2026-04-10 (0965af3 + db50900 + eef17f2)
- [x] 14-03: Pass 1+2 Registration + Integration Tests — Pass 0.5/1/2 real subprocess calls + amauta.py scoped dedup bypass + 8 integration tests with SIGKILL failure injection (PLAN-02/03/04) — Wave 3 — DONE 2026-04-10 (bfb7301 + bb94163)
- [x] 14-04: Agent Wiring + Workflow Integration — operator PLAN_REGISTRATION parser + validator advisory + plan-phase PLAN-06 quality gate + execute-phase plan-to-tasks invocation + PLAN-04 errata (PLAN-04/06/07) — Wave 4 — DONE 2026-04-10 (0f3770c + a78fa18 + 06fe2cb)

---

### Phase 15: End-to-End Dogfood Verification

**Goal:** Observational verification that all 5 RPETD upgrades fired on a real task. Dedicated workflow + CLI tool for future regression detection. Not a hard gate — failure of any check reports to operator but does not block the milestone (except DOGFOOD-05 which requires 6/6 phases green as the ship criterion).

**Depends on:** Phase 14 (dogfood verifies all 5 RPETD upgrades landed; cannot run until P-phase is stable)

**Requirements:** DOGFOOD-01, DOGFOOD-02, DOGFOOD-03, DOGFOOD-04, DOGFOOD-05

**Deliverables:**
| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | `gsd-tools.cjs audit-rpetd-intelligence <task_id>` parses RPETD content and verifies D/E/T evidence blocks | DOGFOOD-01 |
| 2 | `get-shit-done/workflows/verify-rpetd-intelligence.md` creates sample story, runs through 5 phases, invokes audit | DOGFOOD-02 |
| 3 | `scripts/verify-v26.sh` end-to-end shell script: dogfood flow + `amauta health` + `npm test` + `pytest`, emits PASS/FAIL per capability | DOGFOOD-03 |
| 4 | `commands/amauta/verify-v26.md` slash command exposes verification flow to users | DOGFOOD-04 |
| 5 | Post-v2.6 regression: `verify-v26.sh` must pass 6/6 capabilities green before milestone shipped | DOGFOOD-05 |

**Success Criteria (what must be TRUE for users):**
1. An operator running `gsd-tools audit-rpetd-intelligence TK-XXXX` on a completed v2.6 task sees a JSON report with pass/fail flags for D-phase structured learning, E-phase evidence block, T-phase inherited criteria + edge cases + regression sweep.
2. An operator running `/amauta:verify-v26` slash command sees end-to-end verification: sample story created, 5 phases executed, audit report, `amauta health` output, test suite results — all in one session.
3. `scripts/verify-v26.sh` executed after Phase 14 ships reports 6/6 capabilities PASS (D-learning, E-mandate, T-spec-inherit, R-creative-gated, P-auto-task, baseline-tests-green).
4. An operator regression-testing post-v2.6 can run `verify-v26.sh` and get a single PASS/FAIL verdict with per-capability breakdown.
5. At least 8 of 10 randomly-sampled completed v2.6 tasks have all 5 RPETD intelligence checks firing when audited via `audit-rpetd-intelligence`.

**Kill switch:** None (observational only — doesn't affect running tasks). DOGFOOD-05 gate can be manually overridden via `--force-reason` on milestone close if 6/6 cannot be achieved.

**Pitfalls Prevented:**
- **AF7 — Trajectory evaluation theatre**: prevented by audit checking for SPECIFIC evidence markers (structured LEARNING fields, `PRE_EXECUTION_EVIDENCE:` block, `EDGE_CASES:` block) rather than tool-call presence.
- **C5 — Solo-developer rollout risk**: verify-v26.sh provides a single regression harness for all 5 upgrades; one command to detect if any capability regressed post-ship.

**Rollback Plan:** Delete `audit-rpetd-intelligence` subcommand, `verify-rpetd-intelligence.md` workflow, `verify-v26.sh` script, and `commands/amauta/verify-v26.md` slash command. Zero operational impact on running tasks since dogfood is observational.

**Plans:** TBD

---

## Phase Dependency Graph

```
Phase 9 (Tech-Debt Sweep) ──> blocks all v2.6 work
    │
    ▼
Phase 10 (D-Phase Structured Learning) ──> unlocks tag schema for Phases 11, 12, 13
    │
    ▼
Phase 11 (E-Phase Research-Informed Execution Mandate)
    │
    ├────► Phase 12 (T-Phase QA + Spec Inheritance)  [T validates E's evidence block]
    │           │
    │           ▼
    ├────► Phase 13 (R-Phase Creative Research, Narrowed)  [independent of T, parallel with 12]
    │           │
    │           ▼
    │      Phase 14 (P-Phase Task-Management Integration)  [uses 12's spec inheritance; highest blast radius, ships last]
    │           │
    │           ▼
    └────> Phase 15 (End-to-End Dogfood Verification)  [terminal, observational]
```

### Execution Waves (for parallel execution planner)

| Wave | Phases | Mode |
|------|--------|------|
| 1 | Phase 9 | Sequential (blocks all) |
| 2 | Phase 10 | Sequential (gates all downstream via tag schema) |
| 3 | Phase 11 | Sequential (E-mandate lands before T validates it) |
| 4 | Phase 12 + Phase 13 | **Parallel** (T and R are architecturally independent after E) |
| 5 | Phase 14 | Sequential (uses Phase 12's spec inheritance; highest blast radius, last) |
| 6 | Phase 15 | Sequential (terminal, verifies all prior phases) |

**Critical path length:** 6 waves (Phase 9 → 10 → 11 → {12+13 parallel} → 14 → 15).
**Parallelization opportunity:** 1 wave (Wave 4) can run two phases concurrently, reducing sequential phase count from 7 to 6.

---

## Coverage

| Category | Requirements | Phase | REQ-IDs |
|----------|--------------|-------|---------|
| Tech Debt | 6 | 9 | TECH-01..06 |
| D-Phase Structured Learning | 7 | 10 | LEARN-01..07 |
| E-Phase Research-Informed Execution | 8 | 11 | EXEC-01..08 |
| T-Phase QA + Spec Inheritance | 8 | 12 | QA-01..08 |
| R-Phase Creative Research (Narrowed) | 5 | 13 | CREATIVE-01..05 | Complete    | 2026-04-10 | 7 | 14 | PLAN-01..07 |
| Dogfood Verification | 5 | 15 | DOGFOOD-01..05 |
| **Total** | **46** | **7 phases** | — |

**Mapped:** 46/46 ✓
**Unmapped:** 0 ✓
**Duplicates:** 0 ✓

---

## Kill-Switch Summary

| Phase | Env Var | Default | Effect |
|-------|---------|---------|--------|
| 9 | N/A | — | Tech debt cleanup; no feature to disable |
| 10 | `GSD_D_STRUCTURED` | `true` | `false` = fall back to free-text storage |
| 11 | `GSD_E_MANDATE` | `advisory` | `off` = revert to v2.5 executor behavior |
| 12 | `GSD_T_SPEC_INHERIT` | `true` | `false` = fall back to task-only success_criteria |
| 13 | `GSD_R_CREATIVE` | `off` (opt-in) | `on` = enable creative variants globally |
| 14 | `GSD_P_AUTO_TASK` | `false` (opt-in) | `true` = enable auto plan-to-tasks |
| 15 | N/A | — | Observational only |

Note: Phases 13 and 14 are opt-in by default (kill switch off) per PITFALLS rollout strategy — ship the infrastructure, measure, then flip on.

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 9. Tech-Debt Sweep | 1/6 | In progress | Plan 09-01 complete (TECH-01, commit 5cee8a9) |
| 10. D-Phase Structured Learning + CLI Dedup | 7/9 | In progress | Plans 10-01..10-07 complete |
| 11. E-Phase Research-Informed Execution Mandate | 2/2 | Awaiting verification | Plans 11-01 + 11-02 complete, EXEC-01..08 addressed |
| 12. T-Phase QA Department + Spec Inheritance | 0/? | Not started | - |
| 13. R-Phase Creative Research (Narrowed) | 0/? | Not started | - |
| 14. P-Phase Task-Management Integration | 0/? | Not started | - |
| 15. End-to-End Dogfood Verification | 0/? | Not started | - |

---

*Roadmap created: 2026-04-09 after 4 parallel researcher agents (Stack, Features, Architecture, Pitfalls) validated the approved plan and flagged 5 course corrections.*
*Research sources: STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md, SUMMARY.md in `.planning/research/v2.6/`*
*Ship order locked by research; coarse granularity per config.json*
