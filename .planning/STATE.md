---
gsd_state_version: 1.0
milestone: v3.2
milestone_name: The Federation** — Phases 48-53
status: verifying
stopped_at: Phase 60 context gathered
last_updated: "2026-07-04T01:05:47.296Z"
last_activity: 2026-05-21 — SUMMARY files + 59-VERIFICATION.md written; roadmap advanced to Phase 60
progress:
  total_phases: 13
  completed_phases: 9
  total_plans: 35
  completed_plans: 35
  percent: 8
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-15 after v3.3 close + v3.4 "The Mirror" scoping)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. v3.4 turns the mirror on the harness itself — fix how it works, then show what it is.
**Current focus:** Milestone v3.4 — The Mirror. Phase 59 (FIDEL foundation) is complete; Phase 60 or 61 may now be planned.

## Current Position

Phase: 59 complete
Plan: 59-04 complete
Status: Phase 59 delivered and externally verified. Foundation gate for v3.4 cleared.
Last activity: 2026-05-21 — SUMMARY files + 59-VERIFICATION.md written; roadmap advanced to Phase 60
Next step: `/amauta:plan-phase 60` or `/amauta:plan-phase 61`

Progress: [#.........] 8% (1/13 phases)

## v3.4 Strategic Pivot (locked at scope-time)

- **BMAD-METHOD is prior art** (47.2k★, v6.6.0). Do NOT race feature-surface. Differentiator = executor-discipline layer (RPETD/validator/divergence/manifest). Recorded in PROJECT.md "Competitive Landscape" so future milestones don't re-litigate.
- **v3.4 is an effectiveness milestone, not a feature milestone.** Headline = fix the harness's own coding effectiveness + phase-file drift + tool reach.
- **FOUNDATION-FIRST is non-negotiable:** FIDEL track (phase-file fidelity) must complete before TOOL/PERS/TEL/POS — locking scope on top of drifting phases is the test-runner trap (named risk from the user's own analysis, endorsed).
- **HARD track gated** on v3.3.0 npm publish (not yet done — needs NPM_TOKEN + `git tag v3.3.0 && git push origin v3.3.0`) + a real-usage data window. HARD-* cannot start until issues actually arrive.
- **Deferred to v3.5+:** A2A-09 streaming, A2A-10 cross-host, HOST-01..03 hosted registry, module-marketplace expansion. Revisit only if telemetry shows the usage.

## v3.4 Phase Map

| Phase | Name | Track | Requirements | Status |
|-------|------|-------|--------------|--------|
| 59 | Phase-File Fidelity (FOUNDATION) | FIDEL | FIDEL-01..05 | COMPLETE (2026-05-21) |
| 60 | Sources of Truth / Tool Reach | TOOL | TOOL-01..03 | Pending |
| 61 | Coding Quality / Role Personas | PERS | PERS-01..02 | Pending |
| 65 | Retrieval Unification | RETR | RETR-01..07 | Pending |
| 66 | Memory Ranking & Lifecycle | MEMR | MEMR-01..08 | Pending |
| 69 | Mobile AST Grammars | ASTG | ASTG-01..03 | Pending |
| 67 | Enforcement Hooks | HOOK | HOOK-01..07 | Pending |
| 68 | Mobile/Wearable Build Loops | MOBL | MOBL-01..05 | Pending |
| 62 | Telemetry | TEL | TEL-01..03 | Pending |
| 70 | E2E Cross-Service Verification | E2E | E2E-01..03 | Pending |
| 63 | Positioning | POS | POS-01..03 | Pending |
| 71 | Observability | OBS | OBS-01..03 | Pending |
| 64 | Post-launch Hardening (external-gated) | HARD | HARD-01..04 | Pending |

**Execution order (updated 2026-07-02 — expansion interleaved):** 59 (FIDEL foundation, done) → 60+61 (TOOL+PERS wave, parallel) → 65 (RETR) → 66+69 (MEMR+ASTG, parallel, both depend on 65) → 67 (HOOK, requires 60's TOOL-01 catalog) → 68 (MOBL, requires 67) → 62 (TEL) → 70 (E2E, requires 67's hooks + 68) → 63 (POS, after TEL) → 71 (OBS, requires 62's consent framework + tracks 65-68) → 64 (HARD, external-gated last)
**External gate on Phase 64:** Cannot begin until v3.3.0 npm publish completes AND real GitHub issues arrive from users.
**Expansion note:** Phases 65-71 were appended 2026-07-02 from `docs/harness-audit-2026-07.md`; rows for 59-64 above are unchanged from the original 2026-05-15 roadmap (table reordered for readability, not re-sequenced).

## v3.3 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 54 | Stability & Hardening — FOUNDATION | STAB-01..06 | COMPLETE (2026-05-14) |
| 55 | A2A Protocol Foundation | A2A-01..04 | COMPLETE (plans 55-01+55-02+55-03+55-04 shipped 2026-05-14) |
| 56 | A2A Orchestration (breakers + threading + audit) | A2A-05..07 | COMPLETE (plans 56-01+56-02+56-03 shipped 2026-05-14) |
| 57 | Module Marketplace | MARK-01..04 | COMPLETE (3/3 plans) |
| 58 | Public Launch (capstone) | PUB-01..05 | COMPLETE (2026-05-14) |

**Execution order:** 54 → 55 → 56 → (57 ‖ Phase 58 prep) → 58
**Parallelizable:** After 54 + 55: 56 and 57 are independent. 58 is capstone — needs 54 (no debt) + 57 (marketplace story).

## Performance Metrics

(Reset for v3.4 milestone)

## Accumulated Context

### Decisions (carried forward — still informing work)

- v3.0 shipped: 10 phases (31-40), 24 plans, 820 assertions, 55 requirements, 17 agents.
- v3.1 shipped: 7 phases (41-47), 18 plans, ~536 tests, 25 requirements. BMAD-METHOD patterns grafted onto Amauta infrastructure (sharded workflows, scale-adaptive, skills, installer, bearings, MCP, hydration).
- v3.2 shipped: 6 phases (48-53), 24 plans, ~336 tests, 22 requirements. Modules + party mode + agent compilation + v3.1 polish.
- v3.2 Phase 52 Plan 52-03: scripts/agent-compiler.cjs (928 lines) symmetric with Phase 43 skill-compiler.cjs. TARGET_MAPS (claude-code/opencode/cursor), SECTION_KEY_TO_HEADING (9 keys), SECTION_EMIT_ORDER (10 keys, metadata first). SC1 byte-match 17/17 PASS pattern is the v3.3 baseline for any agent.md changes.
- v3.2 Phase 53 Plan 53-02: bin/init.cjs has --install + --upgrade + --uninstall with 19 frozen step names. PUB-04 builds on this (UX polish, not flow change).
- v3.2 Phase 53 Plan 53-03: services/amauta-mcp.py uses inline tools=[...] inside @server.list_tools() (NOT module-level TOOLS list). _MCP_ERROR_CODES 5-tuple is the error vocabulary.
- v3.2 Phase 48 Plan 48-01: Pydantic v2 model_config extra=forbid + field_validator + model_validator(mode=after). Module manifest LOCKED 8-field order. MARK-01 reuses this contract.
- v3.3 Phase 57 Plan 57-01: RegistryEntry 7-field LOCKED order (name/version/sha256/manifest_url/maintainer/signed_by/signature). registry_version="1.0" frozen. 8-tuple _REGISTRY_ERROR_CODES. Signature = ed25519 over sha256 hex UTF-8 bytes. TRUST_STORE_DIR = ~/.gsd-amauta/trusted-keys (fail-closed). compute_manifest_hash reused from Phase 49 (not re-implemented). cryptography>=42.0 sole new dep.
- v3.2 Phase 50/51: party_session blackboard + 5 frozen state transitions + decision records. A2A-01..07 builds on the same agent_findings + agent_messages PG infrastructure.
- 17-agent ecosystem with standardized format. Anti-over-engineering rule: "Do not add features, refactor code, or make improvements beyond what was explicitly requested."
- v3.3 Phase 58 Plan 58-03: npm OIDC provenance requires id-token:write at JOB level (not workflow level) — at workflow level it silently fails. cancel-in-progress:false for release job (no mid-publish cancellation). registry-url set in setup-node step for NODE_AUTH_TOKEN pickup. Python test steps guarded by file/dir existence checks.

### v3.4-Specific Constraints (locked at scope-time)

- **FIDEL phase is FOUNDATION** — no other v3.4 phase starts until Phase 59 completes. Rationale: locking scope on top of drifting phases is the test-runner trap.
- **Phase 60 + Phase 61 are independent surfaces** — capability catalog (TOOL) and agent routing (PERS) do not touch each other; they may plan and execute in parallel after Phase 59.
- **Phase 62 (TEL) follows the TOOL+PERS wave** — telemetry instruments what those phases produce; no blocking dependency on either surface specifically, just both must be in place.
- **Phase 63 (POS) follows Phase 62 (TEL)** — the RPETD compliance scorecard (POS-02) references the telemetry event schema from Phase 62; README repositioning is most credible once telemetry is real.
- **Phase 64 (HARD) deferred indefinitely, not actively pursued** — operator confirmed (2026-07-04) this is a personal-use project, not a public npm launch. HARD-01..04's premise (triage real-user GitHub issues, harden against real-user install failures) doesn't apply without real external users. The v3.3.0-publish gate is moot rather than a to-do. Revisit only if public distribution becomes a goal.
- **No A2A/registry/marketplace work** — deferred to v3.5+ per strategic pivot. Do NOT re-litigate.
- **Expansion (2026-07-02):** 7 new tracks / 36 requirements appended as Phases 65-71 from `docs/harness-audit-2026-07.md`. Phase 67 (HOOK) hard-requires Phase 60's TOOL-01 capability catalog as its allowlist source and FIDEL-01 (Phase 59, shipped) as its manifest precondition — a manifest gate against a broad-glob manifest enforces nothing. Phase 65 (RETR) is the pivot: Phase 66 (MEMR) reuses its generalized RRF helper and Phase 69 (ASTG) would create a third disjoint retrieval stack if built before it. `GSD_HOOKS_ENFORCE=off` kill switch is non-negotiable safety net for Phase 67, not an afterthought.

### Blockers/Concerns

- None active. (Phase 64 was previously listed here as blocked on npm publish — reclassified 2026-07-04 as scope-deferred, not a blocker, since public npm distribution is not a current goal.)

## Session Continuity

Last session: 2026-07-03T01:22:20.417Z
Stopped at: Phase 60 context gathered
Resume file: .planning/phases/60-sources-of-truth-tool-reach/60-CONTEXT.md

## Learnings











































































- [learning] 2026-09-07T23:02:19.178Z: legacy with agent
- [learning] 2026-09-07T23:02:19.118Z: legacy regression test: free text learning
- [learning] 2026-09-07T22:56:14.255Z: legacy with agent
- [learning] 2026-09-07T22:56:14.208Z: legacy regression test: free text learning
- [learning] 2026-07-03T23:41:27.169Z: Phase 67 shipped physical enforcement: PreToolUse manifest+claim gates, Stop completion gate, PreCompact/SessionStart handoff, all warn-first + fail-open + kill-switch-first. HOOK-06 self-test built against the REAL committed hook-allowlists.json (not a hand-authored fixture) caught a genuine security ordering bug (orchestrator_owned checked after global_allowlist) that wave-2's own disjoint-fixture tests missed. GSD_HOOKS_ENFORCE=warn is now this repo's live default.
- [learning] 2026-07-03T23:35:07.868Z: Phase-level RPETD 'all validated done' claims in a dispatch brief must be cross-checked against actual tracker JSON (status/rpetd_complete/validated_by fields), not trusted — a phase can have real committed working code with the tracker task still pending/unvalidated
- [learning] 2026-07-03T23:23:31.859Z: CI-mirror scripts should resolve their OWN tool dependencies (e.g. gsd-tools.cjs) via __dirname, never via an injectable --repo-root/--cwd param -- decouples 'code under test' from 'data under test' so sandboxed fixtures only need data files (ROADMAP.md, plan files, artifact json), not a full copy of the tool + its lib/ dependency tree.
- [learning] 2026-07-03T23:15:16.615Z: When two allowlist-style checks can match the same path, order the more-restrictive hard-halt check strictly before the more-permissive one; prove ordering with an overlapping fixture (matching the real artifact), not a disjoint hand-authored one, or the bug is invisible until production.
- [learning] 2026-07-03T23:13:20.606Z: legacy with agent
- [learning] 2026-07-03T23:11:45.854Z: legacy with agent
- [learning] 2026-07-03T23:11:21.778Z: legacy with agent
- [learning] 2026-07-03T23:08:45.392Z: legacy with agent
- [learning] 2026-07-03T23:03:45.414Z: legacy with agent
- [learning] 2026-07-03T22:58:28.489Z: legacy with agent
- [learning] 2026-07-03T20:49:07.732Z: legacy with agent
- [learning] 2026-07-03T20:44:32.978Z: legacy with agent
- [learning] 2026-07-03T18:58:52.859Z: Backend HTTP route dict-shape leaks: when a store fn's return type grows a new polymorphic dict sentinel, generalize the route's dict-check to a switch over ALL known shapes + catch-all passthrough, not one more special-case if. Same route (amauta-daemon.py /api/memory/store) leaked twice from special-casing (d029ff7 for dedup_skipped, now TK-1773 for noop/deleted_target/superseded_id).
- [learning] 2026-07-03T18:01:06.501Z: Plan 66-03 (MEMR-03/04): commit-range-scoped git diff (0b6f119~1..ca31d2e) confirms rlm_search.py byte-untouched across 4 sequential commits; JS gate branch/PR checks still fire on plain --pass for no-gitflow tasks (no auto-tag-exemption in current code), --force-reason remains required
- [learning] 2026-07-03T17:29:07.350Z: Phase 66-02 (MEMR-02/05): shared bounded log1p citation-boost + merged_sources carry helper wired into BOTH pg_store.py scorers, echo-chamber canary (memory_top1_concentration), memory_list/store applied_count plumbing (guarded against SQLite fallback incompatibility), and gsd-memory.cjs distill signal preservation (applied_count sum, merged_sources, deduped citations) + LLM auto-distill + paginated eligibility (5000 cap) + rate-limit backoff (2s/8s). All 5 tasks landed atomically (commits a219d63, 2fdfcb2, eb8e0ba, be6f99f, 4a5cd4b), 12 python + 2 node tests green, 3 required locks untouched and green, shadow before/after snapshot confirms zero unintended regression on live corpus.
- [learning] 2026-07-03T17:01:19.757Z: Fixing a swallowed-exception bug in a multi-tier fallback chain (try/catch around exec) can newly expose a SECOND, previously-invisible defect that was always there but masked by the first exception firing earlier -- always re-run the real end-to-end path, not just node --check, before declaring the fix complete.
- [learning] 2026-07-03T16:58:17.097Z: Phase 69 grammars: PyPI grammar wheels often omit node-types.json — live-parse enumeration is the reliable node-type discovery method; and a duplicated extension set at an ingestion gate can silently kill an entire feature (single-source by identity import, lock with a source-text partition test)
- [learning] 2026-07-03T16:46:54.741Z: Live E2E /reindex against a shared rlm-service daemon needs a longer timeout than /query calls (rebuild_graph over the whole index + concurrent sibling-agent load)
- [learning] 2026-07-03T16:44:15.550Z: rlm-service.py CODE_EXTENSIONS must stay a superset of ast_chunker.AST_CODE_EXTENSIONS; lock with a structural coherence test parsing source text around a HEURISTIC-ONLY marker, not just set membership
- [learning] 2026-07-03T16:38:47.104Z: Executor misreporting class (69-01): an executor asserted RPETD/status CLI actions in its SUMMARY that it never ran — code was correct, audit trail was fiction. External validators must always cross-check tracker state against SUMMARY claims (data/tasks.json vs prose), never trust the narrative.
- [learning] 2026-07-03T16:06:24.905Z: Phase 65 retrieval unification: unblocking a permanently-erroring path activates dormant downstream bugs (Decimal/None types, missing deps) — live E2E round-trips are the only verification class that catches env-level drift like declared-but-never-installed deps
- [learning] 2026-07-03T15:56:06.243Z: E2E test on a HAS_NETWORKX-style runtime feature flag: verify the pip package is importable in the exact live daemon interpreter, not just declared in requirements.txt, before trusting a service restart to fix silently-degraded behavior (graph feature returned nodes=0 across two restarts until networkx was actually installed).
- [learning] 2026-07-03T15:53:08.500Z: When core.cjs output()/error() call process.exit() unconditionally, code placed after a cmdX(...) call in a CLI dispatch switch is unreachable dead code on every path -- verify handler return-vs-exit behavior with a live smoke test before trusting an emit-after-call placement assumption; prefer emit-before-call attempt semantics by default.
- [learning] 2026-07-03T15:32:38.748Z: PostgreSQL numeric literals (e.g. 1.0/x in SQL) are typed NUMERIC by default, not float8 -- psycopg2 returns decimal.Decimal, not float, for such expressions. Downstream Python arithmetic like score * (1 - penalty) raises TypeError: unsupported operand type(s) for *: decimal.Decimal and float unless explicitly cast (float(score) or an explicit ::float8 in the SQL). RRF/hybrid-search fusion scores computed via 1.0/(k+rank) expressions are a common place this bites.
- [learning] 2026-07-03T15:22:25.078Z: In gsd-amauta.cjs's core.cjs, output() and error() both call process.exit() unconditionally -- any code placed AFTER a call to a handler that ends in output()/error() (e.g. phase.cmdPhaseComplete) is unreachable dead code; emit hooks or other post-call side effects must be placed BEFORE the handler call (attempt semantics) or the handler itself must be refactored to not exit synchronously.
- [learning] 2026-07-03T15:22:11.340Z: Mirror env-seam authoritative-exclusive semantics identically across runtime twins (GSD_TELEMETRY_CONFIG_PATH returned even if missing, no fallthrough) when porting Node config modules to Python or vice versa
- [learning] 2026-07-03T15:22:06.434Z: Mirror env-seam authoritative-exclusive semantics identically across runtime twins (GSD_TELEMETRY_CONFIG_PATH returned even if missing, no fallthrough) when porting Node config modules to Python or vice versa
- [learning] 2026-07-03T15:18:11.168Z: When rewiring one HTTP endpoint (/query) onto a hybrid pipeline already live behind a sibling endpoint (/search), normalize response shape at BOTH endpoints in the same change and retire the old staleness mechanism's every consumer (not just its obvious call sites) in the same pass, or the un-rewritten sibling becomes a live latent bug the moment its upstream dependency activates.
- [learning] 2026-07-03T14:55:30.244Z: Phase 62 telemetry core: consent-gated emit() with pre-consent zero-collection (no buffer file until opt-in), a fail-open flush engine using detached child_process.spawn + unref() so a dead sink never blocks the harness (options.timeout + req.destroy for a hard 3s POST budget), and a bounded JSONL buffer that drops oldest lines on cap overflow -- mirrors services/capability_access.py's fail-open JSONL discipline for the Node CLI layer.
- [learning] 2026-07-03T14:51:38.101Z: RETR-07 65-04: single-owner requirement split across sibling plans is workable when each plan's file-disjoint scope is documented explicitly in the plan doc (single-owner rule note)
- [learning] 2026-07-03T14:51:06.878Z: Guard cross-package Python imports with an explicit _AVAILABLE flag + loud stderr warning, never a silent except-ImportError-pass, since script-launched daemons often lack repo root on sys.path
- [learning] 2026-07-03T14:43:18.566Z: Cache lazily-imported sibling modules with a distinct failure sentinel (not just None) so failed loads short-circuit instead of retrying importlib per call
- [learning] 2026-07-03T14:33:18.312Z: Phase 65 planning: when a plan changes a result-row shape or retires a stats field, grep every consumer of the RESPONSE KEYS (not just the symbol) — /health index_size and CLI formatResults were audit-missed consumers; normalize server-side so all clients inherit the fix
- [learning] 2026-07-03T14:12:21.971Z: Phase 61 personas: overlay identity (kind/base_executor registry fields + explicit <persona> XML element) composes with deterministic routing without touching it — fail-closed unknown_persona + byte-identical absent-path proven by keeping legacy suites untouched as the regression oracle
- [learning] 2026-07-03T14:06:48.271Z: JS-side checkValidationGates (gsd-amauta.cjs) lacks the no-gitflow tag exemption that Python's _needs_gitflow_gate/_is_infra_host_only has -- plain --pass fails PR_URL/BRANCH_EVIDENCE for no-gitflow-tagged tasks even with explicit 'PR_URL: no-pr-needed' notes; must use --force-reason to route through the exempting path
- [learning] 2026-07-03T14:00:35.965Z: Extending a fail-closed conflict-check function with an optional overlay (persona): give every new branch its own unconditional continue so it cannot fall through to the legacy comparison, proving byte-identical-when-absent structurally rather than just asserting it.
- [learning] 2026-07-03T13:58:06.929Z: Prefer fs.readdirSync-derived roster enumeration over hardcoded counts/lists in lock tests to avoid staleness on every roster growth (agents/personas/plugins)
- [learning] 2026-07-03T13:50:53.533Z: Persona overlay agents (gsd-persona-*) get first-try byte-match by cloning an existing conformant agent's exact 10-section skeleton and blank-line cadence, then registering additively in agent-capabilities.json with file_patterns:[] so routeExecutor() stays untouched.
- [learning] 2026-07-03T13:39:25.611Z: AGENTS_WITH_HOOKS set additions are the sanctioned maintenance path for new hooks-bearing agents; add the name before authoring the .md so byte-match round-trip converges.
- [learning] 2026-07-03T13:32:39.925Z: Phase 60 capability catalog: script-launched daemons never get repo-root on sys.path — every 'from services.X' import was latently broken (11 sites, some failing SILENTLY at module load like prompt_cache/metrics-cache 503). Live HTTP round-trip verification catches what static checks + unit tests cannot: missing migrations, import scoping, route wiring.
- [learning] 2026-07-03T12:54:39.567Z: CLI daemon-unreachable fallback branches must treat a resolved non-2xx/error HTTP response the SAME as a connection failure, not just ECONNREFUSED, or a shared long-lived daemon that predates a route addition silently masquerades as success instead of degrading gracefully.
- [learning] 2026-07-03T12:41:20.868Z: Phase 60 Plan 60-03: capability_access.py fail-open audit layer (SENTINEL_TASK_ID=SYSTEM, JSONL PG-down buffer sharing <repo_root>/data with Node DATA_DIR, audit_diff() dynamic gsd-executor-* glob enumeration) + 3 daemon routes (capability intentionally excluded from _EXEC_ALLOWLIST) + hydration '### Capability reach' section, dropped at the same truncation tier as Recent activity. 20/20 new pytest tests passing. CapabilityEntry.name requires >=2 chars (^[a-z][a-z0-9-]{1,63}$) -- single-letter test fixture names silently fail catalog validation and masquerade as unrelated drift-assertion failures.
- [learning] 2026-07-03T12:22:49.468Z: PLAN.md authoring: dedent files_expected keys to column 0 (indented blocks parse only the first key — create: lists go invisible to FIDEL gates) and never embed literal task-field tag pairs in action/AC bodies (Pass-0 regex matches first occurrence; use string-concat or empty decoy pairs)
- [learning] 2026-07-03T12:17:25.157Z: amauta claim dependency gate requires status==done (not validation); for split-session plans with intra-plan task deps, log RPETD via rpetd (no status precondition) then manually walk pending->in-progress->validation, tagging no-gitflow+PR_URL:no-pr-needed for direct-to-master repos
- [learning] 2026-07-03T12:03:33.029Z: Path-restricted git commits (commit -- <file>) are only safe when the target file's working-tree diff is verified clean/expected immediately before committing -- a dirty tree with unrelated concurrent-session changes to the same file will get silently swept into the commit. Always git diff --stat the target file against HEAD right before commit, not just at task start.
- [learning] 2026-07-03T12:02:50.009Z: When adding the Nth LOCKED-order field to a Pydantic-with-loader schema (e.g. AgentDefinition + load_agent_definition), grep every sibling-field occurrence across the whole file first -- the standalone loader function fm.get()-parsing and constructor pass-through sites live far from the class body and are the easiest spot to silently miss, breaking round-trip parsing while class-level unit tests still pass. Guard order-preservation with a source.index(fieldA) < source.index(fieldB) structural test, not just behavioral construction tests.
- [learning] 2026-07-03T11:58:56.705Z: Env-var config-loader test seams (GSD_*_PATH) must be authoritative/exclusive when set, not just first-in-fallthrough-list, or a legitimately-existing repo-local fallback file defeats the test seam's ability to force empty/error states.
- [learning] 2026-07-03T01:49:54.394Z: Phase 60 planning: gsd_audit_log.task_id NOT NULL forces a sentinel (SYSTEM) for out-of-task capability accesses; new CLI verb groups need explicit switch cases (default passthrough 403s on /api/exec allowlist); audit engines over growing agent rosters need injectable-root dynamic glob enumeration plus a mid-test new-dir coverage test, never hardcoded names
- [learning] 2026-07-03T01:33:15.181Z: gsd_audit_log.task_id is NOT NULL (migrations/006-audit-log.sql:8) and /api/audit/log 400s without both task_id+event_type (amauta-daemon.py:2478); any new event_type like capability_access needs a sentinel task_id for out-of-task accesses
- [learning] 2026-07-03T00:43:48.139Z: legacy with agent
- [learning] 2026-05-14T23:44:09.428Z: Python Valkey circuit breaker pattern: INCR+EXPIRE for sliding failure window, SETNX EX 5s for half-open single-probe lock, fail-open (return True/STATE_CLOSED) on all Valkey exceptions, injectable redis_client param for test isolation, _HAS_BREAKER flag for graceful degradation
- [learning] 2026-05-14: npm OIDC provenance requires id-token:write at job level (not workflow level); at workflow level --provenance silently produces no attestation
(New v3.4 learnings appended below as phases ship)
