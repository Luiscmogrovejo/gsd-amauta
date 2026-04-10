# Milestones

## Complete: v2.6 — Sight Beyond Sight (Shipped: 2026-04-10)

**Phases:** 9-15 (7 phases, 13 plans) | **Tests:** ~150 new (~2544 total passing) | **Duration:** ~4 days
**Requirements:** 46/46 satisfied | **Verification:** PASSED (15-VERIFICATION.md, commit `f52e13f`)

**Key accomplishments:**
1. D-Phase Structured Learning (Phase 10, LEARN-01..07): WHAT/WHY/WHEN/CATEGORY/TAGS format, 9 fixed categories, curated tag vocabulary with banned-tag stripping and synonym normalization, 5-tag cap, GIN index for <50ms tag+category search, `gsd-memory learn --structured`, applied_count tracking via `APPLIED_LEARNING:` citations, echo-chamber defense requiring manual review at applied_count > 10, `GSD_D_STRUCTURED=false` kill switch
2. E-Phase Research-Informed Execution (Phase 11, EXEC-01..08): mandatory `PRE_EXECUTION_EVIDENCE` block citing past failures + SKB best-practices + existing style + security checklist, advisory validator parser (Gate 6), `GSD_E_MANDATE=advisory` kill switch
3. T-Phase QA + Spec Inheritance (Phase 12, QA-01..08): `_inherit_parent_spec()` helper, mandatory `EDGE_CASES:` block (≥ 2 per happy-path criterion), mandatory `REGRESSION:` block with before/after counts, parent G/W/T verification, RED-GREEN back-testing
4. R-Phase Creative Research (Phase 13, CREATIVE-01..05): task-type-gated creative variants via `gsd-research --creative` flag, conservative default for implementation tasks, lateral/inversion/cross-domain/anti-pattern modes, `GSD_R_CREATIVE=off` kill switch (default)
5. Orchestrator Hardening & Divergence Protocol (Phase 13.1, HARDEN-01..05): deterministic per-task `files_expected` manifest check (HARDEN-01), behavioral divergence protocol v1.1.0 with exit code 87 fallback (HARDEN-02), agent prompt updates at `assumption_check_completed_at` contract (HARDEN-03), validator vocabulary lock with three verdicts `--pass`/`--fail`/`--gaps-found` exit 0/1/2 (HARDEN-04), synthetic behavioral test suite gated by `ANTHROPIC_API_KEY` (HARDEN-05)
6. P-Phase Task-Management Integration (Phase 14, PLAN-01..07): `gsd-tools plan-to-tasks` auto-registration, `metadata.plan_local_id` identity contract, two-layer dedup bypass, mandatory `<story>` block, structured `PLAN_REGISTRATION` block in P-phase RPETD, Pass 0 cycle detection, hard cutoff at phase 14+, `GSD_P_AUTO_TASK=false` kill switch
7. End-to-End Dogfood Verification (Phase 15, DOGFOOD-01..05): `scripts/verify-v26.cjs` structural audit with locked Q7 schema, `get-shit-done/bin/audit-rpetd-intelligence.cjs` standalone binary, `get-shit-done/workflows/verify-rpetd-intelligence.md` workflow, `commands/amauta/verify-v26.md` slash command, `15-AUDIT-REPORT.{json,md}` with MD auto-derived from JSON via `generateMarkdown()`, observational scope (no modifications to existing code files during the audit phase itself)
8. Dogfood ledger: `docs/v2.6-dogfood-ledger.md` (706 lines) with 9 captured depths of the divergence protocol firing in real v2.6 work, honest open slot at depth 3, Limitations section naming three meta-findings (schema-orphaned depths 8+9, depth-3 coverage gap, resistance-to-fix ratio as the discipline's measurable value: 4 patches prevented in Phase 15 Wave 2 alone), Routed Follow-ups section listing 7 items deferred to v2.7

**Closeout errata:** DOGFOOD-01 (subcommand → standalone binary) and DOGFOOD-03/05 (.sh → .cjs) applied to REQUIREMENTS.md with strikethrough + replacement text per Phase 15 CONTEXT.md Gap 1a/1c.

**Archive:** `.planning/ROADMAP.md` (v2.6 COMPLETE marker), `.planning/REQUIREMENTS.md` (46 requirements flipped Done), `docs/v2.6-dogfood-ledger.md`, `.planning/milestones/v2.2-phases/15-dogfood/15-VERIFICATION.md`

---

## Complete: v2.5 — Smarter Brain (Shipped: 2026-04-06)

**Phases:** 1-8 (8 phases, 26 plans) | **Tests:** 479 new (~2479 total) | **Duration:** ~2 weeks
**Requirements:** 49/49 satisfied | **Token reduction:** 39.4% Layer 2, 24.0% total lifecycle

**Key accomplishments:**
1. Memory system: pgvector semantic search, distillation fix (excludes source='distilled'), recency decay, tiered retention, autolearning pipeline with full content storage, pre-store embedding dedup (cosine > 0.95), Voyage AI rerank wired
2. RLM/REPL engine: word-boundary TF (MIT paper compliance), BM25 b=0.6 for code variance, position decay 5% configurable, chunk size 4000 char, camelCase/snake_case splitting, label boost saturation fix
3. Token efficiency: enrichment dedup window 300s, Perplexity output cap 1500 char + preamble stripping + citation stripping, RPETD soft cap 2000 char, phase-specific reduction (T/D skip Layer 2)
4. Multi-agent: 11 agent audit, file-pattern routing extraction, performance tiebreaker with 70% fallback, error classification (TRANSIENT/GATE_FAIL/CAPABILITY_MISMATCH/SYSTEMIC), recovery routing, auto-escalation at 3 failures
5. Task manager: archive + reconcile + stale watchdog + retry flush, TOCTOU-safe file locking, dual-write with [PG_SYNC_WARN] visibility, 39-field PG sync via migration 007
6. Infrastructure: Redis L2 caching layer (redis-py>=5.0), Docker compose for Redis 7 on :6379, graceful fallback to in-memory cache, daemon health dashboard fields

**Archive:** `.planning/ROADMAP.md` (v2.5), AUDIT-SUMMARY.md

---

## Complete: v2.4 — Bulletproof (Shipped: 2026-03-25)

**Phases:** 20-23 (4 phases, 6 plans) | **Tests:** 117 new (408 Python total, ~2000+ with CJS)
**Requirements:** 20/20 satisfied | **Audit:** PASSED (0 tech debt)

**Key accomplishments:**
1. Fixed 10 bugs: daemon mirror list, HTTP timeout race, distill count, research chain logging, reconcile archive scope, enrichment project_id, Jaccard edge case, retention shutdown, archive genealogy, auto-learn SKB dedup
2. Created 10 comprehensive test suites: archive, reconcile, RLM wiring, PG integration, distill, auto-learn, task manager, daemon integration, fallback paths, E2E lifecycle
3. E2E smoke test validates full create→claim→RPETD→validate→archive lifecycle
4. Test coverage grew from ~291 to 408 Python tests (40% increase)

**Archive:** milestones/v2.4-ROADMAP.md | milestones/v2.4-REQUIREMENTS.md | milestones/v2.4-MILESTONE-AUDIT.md

---

## Complete: v2.3 — Clean Foundations (Shipped: 2026-03-25)

**Phases:** 15-19 + 19.1 (6 phases, 10 plans) | **Commits:** 46 | **+7,327/-1,602 lines**
**Requirements:** 18/18 satisfied | **Audit:** PASSED (6/6 integration, 0 tech debt)
**Timeline:** 2026-03-24 → 2026-03-25

**Key accomplishments:**
1. Data purge — removed 1,955 test/synthetic entries from gsd_memory (2,135→182), 111 from SKB (116→5)
2. Data integrity — fixed distill re-merging bug, pre-store embedding dedup (cosine >0.95), project_id auto-set from CWD, test isolation to __test__, legacy amauta_memory table renamed to gsd_memory (12 refs)
3. Task manager reliability — archive command (52% working set reduction), reentrant file lock (TOCTOU fixed for 17 functions), stale watchdog (>48h auto-revert), retry queue flush (60s), reconcile command, migration 007 (7 missing PG columns)
4. Memory optimization — source filtering (exclude task_event/rpetd_phase noise), recency decay (-0.5/30d), tiered retention (30d/90d archival)
5. Token efficiency — enrichment dedup (skip Layer 2 if Layer 1 <5min), Perplexity cap (1,500 chars), RPETD soft cap (2,000 chars)
6. Gap closure — reconcile compare_fields expanded to 37 fields, dedup project_id filter, preamble regex edge cases

**Archive:** milestones/v2.3-ROADMAP.md | milestones/v2.3-REQUIREMENTS.md | milestones/v2.3-MILESTONE-AUDIT.md

---

## Complete: v2.2 — Wiring & Hardening (Shipped: 2026-03-24)

**Phases:** 11-14 (4 phases, 9 plans) | **Commits:** 40 | **Tests:** 112 new (1783 total)
**Requirements:** 22/22 satisfied | **Audit:** PASSED (5/5 integration points)
**Timeline:** 2026-03-24 (single day)

**Key accomplishments:**
1. RLM context engine activated — removed 5 dead gates, HTTP transport replacing subprocess, BM25 scoring with camelCase splitting, Layer 1 RLM at claim-time
2. Semantic memory pipeline wired — pgvector cosine similarity replacing LIKE search, auto-embedding via Voyage AI, research chain auto-fires in R-phase
3. E/T phase memory enrichment — agents now see past failures (E-phase) and test strategies (T-phase), SKB Jaccard dedup prevents 3x duplication
4. Validation hardening — `--force-reason` replaces `--force` on validate, 100-char test proxy removed, self-validation block, mandatory note on fail/deferred
5. Pipeline integration — MCP server auto-registered, performance routing tiebreaker, PG_SYNC_WARN visible to agents, health dashboard with all system stats
6. D-phase learning stores full content (double-truncation removed)

**Tech debt:** 5 non-blocking items (E-phase LIKE search, GSD_PROJECT_DIR, force_reason in memory, checkbox updates, rate-limit flaky test)

**Archive:** milestones/v2.2-ROADMAP.md | milestones/v2.2-REQUIREMENTS.md | milestones/v2.2-MILESTONE-AUDIT.md

---

## Complete: v2.1 — Durability & Compliance (Shipped: 2026-03-23)

**Phases:** 6-10 (5 phases, 6 plans) | **LOC:** 13,349 Python | **Tests:** 53 new
**Timeline:** 2026-03-21 → 2026-03-23 (3 days)
**Audit:** 15/15 requirements satisfied, 3/3 integration points verified

**Key accomplishments:**
1. Immutable audit log for all validation decisions and RPETD events (append-only, no UPDATE/DELETE)
2. OIDC/SSO token validation with graceful degradation (3 env vars, no-auth fallback)
3. Backup/restore/verify pipeline for all 6 data tables including audit logs
4. Audit CLI commands (`amauta audit export` JSON/CSV, `amauta audit show TK-XXXX`)
5. SSO actor injection — authenticated identity flows through to audit records
6. Auto-backup on daemon start (daily, prune to 7)

**Gap closure:** Phases 9-10 created from milestone audit to fix 4 requirements (AUDIT-03/04, SSO-04, DUR-01)

---

## Complete: v2.0 — Self-Upgrade

**Phases:** 1-5 | **Tasks:** 34 | **Commits:** 39 | **Tests:** 1714
**Shipped:** Setup, RPETD enforcement, Memory & RLM, Task Management, Distribution

---
