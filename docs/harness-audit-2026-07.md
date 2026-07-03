# GSD-Amauta Harness Audit — 2026-07-02

Full-system audit of memory, RLM retrieval, research/agentic-pattern posture, agent roster, enforcement ("mandatoriness"), and usability. Produced by parallel audit agents (memory, RLM, agent-wiring, external research) + synthesis. Intended as the requirements input for a future milestone (v3.5 candidate: "The Lens").

**Status of the roster expansion:** the 5 new specialist executors (mobile-android, mobile-ios, mobile-cross, wearables, ai) were implemented and wired as part of this audit session — see §5. Everything else in this document is a finding/recommendation, deliberately NOT applied, so it can go through discuss-phase → plan-phase → execute-phase.

---

## 1. Memory subsystem — findings

### HIGH

| ID | Finding | Location | Fix |
|---|---|---|---|
| MEM-H1 | **Claude LLM distillation is dead code.** `claudeSummarize` calls `execSync` without requiring it (the `require('child_process')` lives inside other functions). The ReferenceError is swallowed by try/catch, so the advertised Claude distill path NEVER runs — distillation always degrades to Ollama or raw concatenation. | `get-shit-done/bin/gsd-memory.cjs:2135-2180` (call sites 2144, 2168) | Add `const { execSync } = require('child_process')` at function/module scope. |
| MEM-H2 | **`applied_count` never enters search ranking.** A learning cited 10× ranks identically to one never applied; the citation signal is only used for SKB promotion. | `services/pg_store.py:648-691`, `2065-2108` | Add bounded citation boost, e.g. `+ min(log1p(applied_count), 3)`, in `_score_memories` and `_score_semantic_results`. |
| MEM-H3 | **No hybrid FTS+vector fusion for memory search, despite RRF already existing in-repo.** `memory_search` is FTS-only (AND-joined terms → any missing term drops to an ILIKE `created_at DESC` fallback that ignores relevance); `memory_semantic_search` is vector-only. `rlm_search.py` and `skill_invocation_store.py` already implement RRF. | `pg_store.py:555-646`, `612`, `1981-2063`; RRF at `services/rlm_search.py:72-130` | Reuse the RRF helper to fuse both paths for the default memory query; add a BM25 (pg_search) index on `gsd_memory`. |

### MEDIUM

| ID | Finding | Location | Fix |
|---|---|---|---|
| MEM-M1 | Source bonus + recency decay applied **post-hoc after SQL LIMIT** — a high-value entry ranked #21 by raw similarity is discarded before scoring can rescue it. | `pg_store.py:614-623`, `2028-2037` | Over-fetch `limit*4`, score, truncate — or push bonus/decay into SQL ORDER BY. |
| MEM-M2 | Voyage reranker **discards the composite score** — rerank order replaces (not blends) source/recency/citation scoring; a stale `task_event` can outrank a fresh `lesson-learned`. | `pg_store.py:2046-2063` | Weighted blend of rerank score and composite score. |
| MEM-M3 | Wrong pgvector GUC: `SET ivfflat.iterative_scan` while the only index is **HNSW** — filtered vector queries get no iterative-scan benefit. | `pg_store.py:431`, `migrations/011:39` | `SET hnsw.iterative_scan = relaxed_order`. |
| MEM-M4 | Distillation **destroys signal**: merged entry downgraded to `source='distilled'` (+2), originals (incl. `lesson-learned` +4 with citations) deleted; `applied_count` and citation history not carried forward. | `gsd-memory.cjs:2329-2365` | Carry max source bonus; sum applied_count; merge citations. |
| MEM-M5 | Auto-distill **always uses concatenation** — `maybeAutoDistill` never passes `use-llm`. | `gsd-memory.cjs:2064`, `2241`, `2282-2286` | Pass `'use-llm': true` (after MEM-H1 fix). |
| MEM-M6 | **No write-path dedup at all when embeddings unavailable** — no-API-key installs store unbounded duplicates. (Note: the claimed "Jaccard dedup at write" does not exist anywhere; Jaccard is used only in distill grouping.) | `pg_store.py:494-553`; daemon routing `amauta-daemon.py:2253-2261` | Add trigram/Jaccard fallback dedup in `memory_store`. |

### LOW
- MEM-L1 No contradiction detection; distill would happily merge "do X" with "never do X" (`gsd-memory.cjs:2216-2233`).
- MEM-L2 No per-project consolidation summaries.
- MEM-L3 Distill only sees newest 1000 rows (`gsd-memory.cjs:2188`, `pg_store.py:725`) — older duplicates never eligible.
- MEM-L4 `metadata.citations` grows unboundedly (`pg_store.py:910-931`).
- MEM-L5 Doc drift: usage text says semantic search "requires OPENAI_API_KEY" though Voyage is primary (`gsd-memory.cjs:2656`).
- MEM-L6 Write dedup checks only the single nearest neighbor within the project (`pg_store.py:1951-1958`).
- MEM-L7 `.opencode/get-shit-done/` appears to be a duplicated copy of `get-shit-done/` — confirm sync strategy or remove.

---

## 2. RLM retrieval engine — findings

**Root cause of most findings: two disjoint retrieval stacks.** The Phase 27 hybrid pipeline (tree-sitter AST chunking → caveman descriptions → Voyage embeddings → ParadeDB BM25 + pgvector RRF → rerank → graph) is only reachable via `/search`. The agents' primary entrypoint (`gsd-rlm.cjs query --dir`, used throughout every executor template) hits `/query`, which is the legacy in-memory regex-chunk BM25 path. **The AST chunker, embeddings, RRF, reranker, and dependency graph are all dead on the common path.**

### HIGH

| ID | Finding | Location | Fix |
|---|---|---|---|
| RLM-H1 | `/query` bypasses the entire Phase 27 pipeline (no ingestion, no hybrid_search, no rerank, no graph). | `rlm-service.py:1079-1165` vs `:982-1007`; client routing `gsd-rlm.cjs:298-323` | Route `/query` through scan→ingest→`hybrid_search`, same as `/search`. |
| RLM-H2 | **Label boost contributes zero for label-only matches** — TF counted from body tokens only, so a query matching only a function/class NAME scores 0 from that chunk. This is the exact case agents hit (they query task titles/symbols). | `rlm-service.py:731-756`, tokens at `652` | Seed TF with `label_tokens.count(term)` before BM25 saturation. |
| RLM-H3 | **MCP `amauta/search-code` ignores the query entirely** — `SELECT ... FROM code_embeddings LIMIT n` with no WHERE/rank; returns first N rows regardless of query. | `services/amauta-mcp.py:477-483` | Replace with pgvector `<=>` on embedded query or delegate to `rlm_search.hybrid_search`. |
| RLM-H4 | `scan_directory` silently truncates at 500 files AND `/query` re-walks the tree per request — incomplete + O(repo) per query on any repo >500 code files. | `rlm-service.py:770, 787-788, 1123` | Serve `/query` from the persistent `rlm_chunks` PG index. |
| RLM-H5 | **Dependency graph is never built** — `rebuild_graph` has zero callers; `expand_chunks_with_graph` always reads empty Valkey keys; `dependents` always `[]`; edges are raw call strings that don't match node names, so PageRank is meaningless. | `rlm_graph.py` (docstring :11 lies), `ast_chunker.py:209`, `rlm-service.py:1005` | Call rebuild on ingest/startup; resolve edge strings to symbol names; reverse-pass for dependents. |

### MEDIUM
- RLM-M1 Two live staleness systems (deprecated `MtimeIndex` drives `/query`; SHA-256 drives `/search`) — same file can report different freshness (`rlm-service.py:256-257, 325, 1127-1148` vs `rlm_ingestion.py:56-76`).
- RLM-M2 `/query` mtime branch is redundant with `ChunkCache` (both branches call `chunk_file`) (`rlm-service.py:1138-1144`).
- RLM-M3 In-memory BM25 uses b=0.6, pg_search uses default b=0.75 — two engines rank the same corpus differently (`rlm-service.py:715`, `rlm_search.py:11-14`).
- RLM-M4 **Caveman-description boost claimed but not implemented** — SQL is a bare `@@@` match with no field weights, so the whole Phase 22 caveman feature has near-zero retrieval effect (`rlm_search.py:94, 145`).
- RLM-M5 `legacy_chunker` re-execs the entire 1288-line rlm-service.py per non-code file during ingestion (`ast_chunker.py:296-302`).
- RLM-M6 Reranker cache key collides on `id=0` for all chunks lacking ids — cross-contaminated cached scores (`rlm_reranker.py:87, 106`).
- RLM-M7 AST coverage is PY/JS/TS only; Go/Rust/Java/Kotlin/Swift silently fall to paragraph splitting despite being advertised as code extensions (`ast_chunker.py:24` vs `rlm-service.py:99-104`). **Directly relevant now that mobile executors exist — Kotlin/Swift chunking is the weakest link for them.**
- RLM-M8 In-memory JS chunker breaks on arrow default-exports, decorators, JSX (`rlm-service.py:473-517`) — fixed by RLM-H1 (reuse AST path).

### LOW
- RLM-L1 `complexity_scorer.py`'s new `top_level_dir_width` feature is dead in the deterministic scoring path (only used by logistic calibration) (`services/complexity_scorer.py:385-393` vs `:909`).
- RLM-L2 Tokenizer drops short/digit-leading terms (`s3`, `v2`, `db`, `id`) (`rlm-service.py:703, 709`).
- RLM-L3 TF fallback uses substring counting (`rlm-service.py:733`).
- RLM-L4 Matryoshka 256-dim truncation without renormalization + query-time cast means the vector leg **sequential-scans** (no index on 256-dim) (`rlm_embeddings.py:70`, `rlm_search.py:152`).
- RLM-L5 Tuning constants duplicated across engines (POSITION_DECAY, RRF k) (`rlm_search.py:24-28, 66`).
- RLM-L6 Voyage rerank-2 unused despite Voyage being the embedding provider — Jina/sbert only (`rlm_reranker.py:33`).

---

## 3. Research-backed feature adoption list (external, cited)

Tiered by impact; sources in the research annex (agent output). Top picks:

**Tier 1 — direct upgrades to existing subsystems**
1. **Fix the split-brain retrieval first** (RLM-H1..H5) — most of "hybrid + AST + rerank" is already built, just unreachable.
2. **AST chunking everywhere (cAST, arXiv 2506.15655)** — +4.3 Recall@5 on RepoEval; add tree-sitter grammars for Kotlin/Swift/Go/Rust (RLM-M7).
3. **Hybrid BM25+dense with RRF for memory** (MEM-H3) — 15-30% recall gains; plumbing only.
4. **mem0-style write-time memory ops (ADD/UPDATE/DELETE/NOOP)** — LLM decides at store time instead of blind insert + offline dedup; solves contradictions (MEM-L1) structurally.
5. **Bi-temporal validity windows (Zep/Graphiti pattern)** — `valid_at`/`invalid_at` columns; separates "old" from "wrong" (recency decay currently conflates them).
6. **PreToolUse hook gates** — see §4 Mandatoriness.
7. **Stop-hook completion gate** — block turn-end until validator verdict/tests green.

**Tier 2**
8. Cross-encoder/Voyage rerank-2 stage (fixes RLM-L6 too).
9. Aider-style repo map (tree-sitter symbol graph + personalized PageRank) injected at R/P phases — pairs with fixing RLM-H5.
10. Reflexion-style failure memories: on validator rejection or divergence, auto-generate a self-critique memory typed `reflexion`, auto-inject into next similar task.
11. Episodic vs semantic memory separation (two policies: decayed events vs validity-windowed facts); makes distillation a well-defined episodic→semantic promotion.
12. Sleep-time consolidation agent (Letta pattern): nightly LLM-driven merge/prune/summarize — supersedes concat distillation (MEM-M4/M5).
13. Graph-linked memories (A-MEM, NeurIPS 2025): `memory_links` table, one-hop link-following at retrieval.
14. Machine-readable feature ledger with `passes:false` booleans only the validator may flip (Anthropic long-running-harness guidance) — makes scope diffable.
15. OpenTelemetry GenAI spans → self-hosted Langfuse: per-agent/phase token+cost traces; prerequisite for the dashboard.

**Tier 3**
16. Single-writer rule for parallel waves (Cognition "Don't Build Multi-Agents"): deterministic check that no two parallel executors have overlapping file scopes.
17. Delegation-effort rules in the operator (1 agent for lookups, 2-4 for comparison, 10+ only for wide research) + context firewall (subagents return compressed structured results).
18. Just-in-time context: hydrate with memory IDs/paths, not payloads.
19. TDD-guard-style test-first PreToolUse hook (opt-in per phase type).
20. CI mirror of harness gates (manifest diff, validator verdict, feature booleans) — enforcement that survives non-harness edits.
21. Pipeline dashboard (kanban of phases/waves/agents + live token burn) — depends on 15.

**Tier 4 — mobile/wearables enablement (pairs with new agents)**
22. **XcodeBuildMCP** — build/test/simulator loop for the iOS+watchOS executors.
23. **mobile-mcp / emulator MCP + Gradle CLI loop** — on-device verification for Android/Wear OS.
24. Accessibility-tree snapshots (not screenshots) as the validator's mobile-UAT ground truth — "deterministic before behavioral" applied to mobile UI.

---

## 4. Mandatoriness & usability

**Current enforcement is detective or advisory:** manifest check runs `git diff` after commits; divergence protocol and RPETD ordering live in agent prompts; validator runs after the fact. The gap: nothing physically prevents an out-of-manifest Write at the moment it happens.

Recommended enforcement ladder (deterministic-before-behavioral, consistent with house doctrine):
1. **PreToolUse hook: manifest gate.** Block Edit/Write on files outside the claimed task's `files_expected` (+GLOBAL_ALLOWLIST); hard-block ORCHESTRATOR_OWNED. Moves HARDEN-01 from post-hoc to write-time.
2. **PreToolUse hook: claim gate.** Block Edit/Write when no task is claimed (env/session marker) — makes "use the harness" structurally mandatory rather than habitual.
3. **Stop hook: completion gate.** Refuse turn-end while claimed task lacks T-phase evidence or has unresolved divergence reports.
4. **SessionStart/PreCompact hooks: automatic handoff ledger** — auto-write/rehydrate pause-work state; removes the skippable manual step.
5. **CI mirror** of the same gates for edits made outside the harness.

Usability quick wins:
- `amauta board --watch` style TUI or web dashboard (Tier-3 #21) fed by OTel data.
- Surface `service_errors[]`/degradation state in the statusline instead of requiring `amauta health`.
- Fix MEM-L5-class doc drift (help text) and add `gsd-memory why <id>` (show score decomposition: similarity/source/recency/citations) — makes ranking debuggable.

---

## 5. Roster expansion — SHIPPED in this session

Five new specialist executors, full v3.x format (10 sections, RPETD protocol, PRE_EXECUTION_EVIDENCE, structured LEARNING, divergence protocol, CACHE_BREAKPOINT), wired into every registry:

| Agent | Owns (routing) | Core domain rules |
|---|---|---|
| `gsd-executor-mobile-android` | `*.kt *.kts *.gradle *.aidl AndroidManifest.xml proguard-rules.pro android/*` | ANDR-01 release-safety warning (minSdk/version/signing/permissions); ANDR-02 background-work review |
| `gsd-executor-mobile-ios` | `*.swift *.storyboard *.xib *.xcconfig *.pbxproj *.entitlements *.xcstrings Podfile ios/*` | IOS-01 privacy/signing safety (purpose strings; signing = hard stop); IOS-02 pbxproj discipline |
| `gsd-executor-mobile-cross` | `*.dart *.podspec pubspec.yaml analysis_options.yaml metro.config.js eas.json react-native.config.js` | XPLAT-01 bridge-boundary integrity (both sides in files_expected); XPLAT-02 dependency hygiene |
| `gsd-executor-wearables` | `wear/* wearos/* watchos/* watch/* tiles/* complications/* *.watchface` (dir patterns out-score mobile extensions) | WEAR-01 sensor/battery budget; WEAR-02 phone↔watch sync integrity; WEAR-03 health-data privacy hard stop |
| `gsd-executor-ai` | `prompts/* evals/* *.prompt` | AI-01 eval-first prompt changes; AI-02 injection-surface review; AI-03 token/cost budget discipline |

Deliberate conflict decisions: `*.java` stays with executor-backend (Android-Java via planner assignment); `.ts/.tsx` stays frontend/backend (React Native via planner assignment); general `.py` AI code stays backend (LLM-specific work via `prompts/`/`evals/` dirs or planner assignment).

Files touched: `agents/gsd-executor-{mobile-android,mobile-ios,mobile-cross,wearables,ai}.md` (new), `get-shit-done/agents/*/AGENT.yaml` (compiled), `get-shit-done/agent-capabilities.json` (11→16 entries), `get-shit-done/bin/gsd-tools.cjs` (routingOrder 3→8), `get-shit-done/bin/lib/core.cjs` (MODEL_PROFILES), `bin/install.js` (CODEX_AGENT_SANDBOX), `get-shit-done/references/model-profiles.md`, `README.md`, tests `06-01`/`06-02` (+15 routing cases)/`06-05`/`34-agent-format` (+ hooks-frontmatter compliance fix for pre-existing gsd-architect/gsd-tester/gsd-executor-data).

Registry observation (pre-existing): the v3.0 agents (architect, qa, reviewer, security, tester, executor-data) are intentionally NOT file-pattern routed — workflow-invoked only. The new executors ARE routed, since their value is automatic dispatch.

---

## 6. Suggested milestone sequencing

1. **Phase A — Retrieval unification (highest ROI):** RLM-H1..H5, RLM-M1..M4; one phase since they share the index rebuild.
2. **Phase B — Memory ranking & lifecycle:** MEM-H1..H3, MEM-M1..M6 + bi-temporal columns + episodic/semantic split (one migration).
3. **Phase C — Enforcement hooks:** manifest/claim/Stop/handoff hooks + CI mirror.
4. **Phase D — Mobile enablement:** XcodeBuildMCP + mobile-mcp integration, Kotlin/Swift tree-sitter grammars, accessibility-tree UAT for validator.
5. **Phase E — Observability & UX:** OTel→Langfuse, dashboard, `gsd-memory why`.
