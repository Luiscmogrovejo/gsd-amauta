# Requirements: GSD-Amauta v2.9 "Nervous System"

**Defined:** 2026-04-13
**Core Value:** Every RPETD phase must *see* what the other phases have already learned — the brain synthesizes, not accumulates.

## v2.9 Requirements

Five infrastructure layers composing into a unified upgrade. Target: 3x retrieval precision (MRR), native MCP interoperability, self-correcting execution, full-stack observability, kernel-level isolation.

### Infrastructure — The Substrate (Phase 26)

Infrastructure installs with zero application code changes. Everything downstream depends on this.

- [ ] **INFRA-01**: Redis replaced by Valkey 8.x. All existing Redis clients work unchanged. Throughput measured via redis-benchmark shows >= 30% improvement on SET operations. BSD 3-Clause license confirmed in docker-compose.yml.
  - *Acceptance:* valkey-cli ping returns PONG. All 2750 existing tests pass. Benchmark delta logged.

- [ ] **INFRA-02**: pgvector upgraded to >= 0.8.0. Iterative index scans enabled (SET ivfflat.iterative_scan = relaxed_order). Filtered vector queries on semantic_cache table show >= 3x speedup on 10-query benchmark vs current.
  - *Acceptance:* SELECT extversion FROM pg_extension WHERE extname='vector' returns >= 0.8.0. Benchmark results logged.

- [ ] **INFRA-03**: ParadeDB pg_search extension installed alongside pgvector. BM25 index created on a test table. SELECT * FROM test_table WHERE test_table @@@ 'query' returns results. Migration 011-paradedb-setup.sql delivered.
  - *Acceptance:* SELECT extversion FROM pg_extension WHERE extname='pg_search' returns non-null. BM25 query returns ranked results.

- [ ] **INFRA-04**: Tree-sitter parsers installed for JavaScript, Python, TypeScript, and CJS. tree-sitter parse <file> produces valid AST for one sample file of each language. Parser binaries available to Python and Node processes.
  - *Acceptance:* 4 sample files parsed, AST node count > 0 for each. Parser import succeeds in both Python and CJS test files.

### Retrieval — The Retrieval Rewrite (Phase 27)

The standalone rlm-service.py BM25 engine rebuilt on top of the substrate. Six capabilities collapse into one coherent pipeline.

- [ ] **RLM-01**: Tree-sitter AST-aware chunking replaces fixed-character chunking. Each chunk is a complete function, class, or method. Chunk metadata includes: {file_path, symbol_name, symbol_type, start_line, end_line, dependencies[], dependents[]}. Chunk boundary never splits a function.
  - *Acceptance:* Given 10 sample files totaling 5000+ lines, zero chunks contain partial function definitions. Chunk count within 20% of function/class count.

- [ ] **RLM-02**: ParadeDB BM25 indexes RLM chunks inside PostgreSQL. Migration 012-rlm-paradedb.sql creates rlm_chunks table with BM25 index. All BM25 queries route through PG instead of the standalone Python engine. rlm-service.py becomes a thin HTTP wrapper over PG queries.
  - *Acceptance:* EXPLAIN on BM25 query shows pg_search index scan. Response latency <= 50ms on 95th percentile for 20-query benchmark. Standalone BM25 scoring code marked deprecated.

- [ ] **RLM-03**: Code-specific embeddings replace general-purpose embeddings for RLM chunks. Voyage Code 3 API (primary) or Qodo-Embed-1-1.5B (local fallback). Matryoshka dimensionality: 1024-dim stored, 256-dim for fast lookup. Migration 013-code-embeddings.sql adds embedding_code column.
  - *Acceptance:* Code retrieval MRR on 20-query golden set improves >= 15% vs current general embeddings. Embedding generation gracefully falls back from API to local model.

- [ ] **RLM-04**: Hybrid search via Reciprocal Rank Fusion combines BM25 + vector similarity in a single SQL query. RRF formula: 1/(k + rank_bm25) + 1/(k + rank_vector) with k=60. Both indexes queried in parallel within one PG transaction.
  - *Acceptance:* Hybrid MRR >= 95% of max(BM25-only, vector-only) across 20 golden queries. Single SQL query, no application-level fusion.

- [ ] **RLM-05**: Cross-encoder reranking after hybrid retrieval. Hybrid top-20 -> Jina Reranker v2 (or compatible cross-encoder) -> return top-5. Reranker scores cached in Valkey by (query_hash, chunk_id) with 10-minute TTL. Graceful fallback: if reranker unavailable, return hybrid top-5 unranked.
  - *Acceptance:* Reranked MRR >= 10% improvement over hybrid-only on 20 golden queries. Reranker failure does not crash the pipeline. Cache hit rate logged.

- [ ] **RLM-06**: Dependency graph built from tree-sitter AST. Nodes = functions/classes/modules. Edges = imports, calls, inheritance. Stored as adjacency lists in Valkey. When retrieval finds a function, 1-hop graph neighbors included in context. PageRank identifies architectural hub files.
  - *Acceptance:* Graph covers >= 90% of function-level symbols in the codebase. Given a retrieved function, >= 1 caller and >= 1 callee included in expanded context (when they exist). Hub files list non-empty.

### Behavioral — The Behavioral Upgrade (Phase 28)

Prompt, workflow, and protocol changes sharing the same behavioral test infrastructure.

- [ ] **BEHAV-01**: AGENTS.md adopted as native format for per-directory agent instructions. Discovery follows "closest file wins" (existing specificity-wins pattern). Existing agent .md files in agents/ remain the system-level definitions; AGENTS.md files in project directories override per-directory behavior.
  - *Acceptance:* An AGENTS.md file placed in services/ directory is read and applied when an executor operates on files in services/. Agent definitions in agents/ still apply when no AGENTS.md exists. 5 tests covering discovery hierarchy.

- [ ] **BEHAV-02**: Circuit breaker on all 11 specialist agents. Track consecutive failures per agent. After 3 consecutive failures, agent enters OPEN state (auto-fallback to gsd-executor-general). Half-open recovery test after 60 seconds. State stored in Valkey with TTL.
  - *Acceptance:* Simulated 3 consecutive failures on gsd-executor-backend triggers fallback to gsd-executor-general. Recovery test after TTL re-enables the original agent. 4 tests covering open/closed/half-open states.

- [ ] **BEHAV-03**: Reflexion memory persists across sessions. When Divergence Protocol fires, gsd-debugger generates a verbal reflection stored in divergence-memory.json ({task_id, timestamp, what_failed, why, what_to_try_next}). Past reflections for the same task injected into executor context on retries (max 3 most recent).
  - *Acceptance:* After a divergence event, divergence-memory.json contains the new entry. On retry, executor's PRE_EXECUTION_EVIDENCE block includes past reflections. File format validated by JSON schema. 6 tests.

- [ ] **BEHAV-04**: Lint-after-edit guardrail in Manifest Enforcement. After each executor commit, run language-appropriate linter (eslint for JS/CJS, ruff for Python). If linter reports errors, commit is flagged (not rejected -- advisory in v2.9) with structured lint_report in commit metadata. Exit code from lint logged but does not block.
  - *Acceptance:* A commit introducing a syntax error produces a lint_report with >= 1 finding. A clean commit produces an empty lint_report. Linter failure (tool not found) gracefully degrades to no-op. 5 tests.

- [ ] **BEHAV-05**: Feature-level progress tracking via feature_list.json. Each plan generates a feature list ({feature_id, description, status: pending|passing|failing, test_file, last_verified}). Validator updates feature status after each test run. Prevents "premature victory" -- phase cannot be marked complete while any feature has status failing.
  - *Acceptance:* Plan 27-01 produces a feature_list.json with >= 3 features. Validator refuses --pass verdict when any feature is failing. Feature status updates after test execution. 5 tests.

- [ ] **BEHAV-06**: "Get bearings" ritual at session start. When a phase resumes after context window clear, the first action reads: feature_list.json + last 3 git log entries + divergence-memory.json + STATE.md current position. This context is assembled into a <= 400-token "bearings block" prepended to the phase's system prompt.
  - *Acceptance:* After /clear, resumed phase execution includes bearings block in first message. Bearings block <= 400 tokens (tiktoken measured). 3 tests.

### Interoperability — The MCP Interface (Phase 29)

The daemon gains protocol-native MCP server capabilities alongside its existing HTTP API.

- [ ] **MCP-01**: Amauta daemon exposes an MCP server via stdio transport (for Claude Code) and SSE transport (for remote clients). Server advertises capabilities: tools, resources, prompts. Existing HTTP API remains unchanged -- MCP is additive.
  - *Acceptance:* claude mcp list shows amauta server. MCP initialize handshake completes. HTTP API continues responding on all existing endpoints. 4 tests.

- [ ] **MCP-02**: RLM retrieval exposed as MCP tool amauta/search-code. Parameters: {query: string, top_k?: number, file_filter?: string}. Returns ranked chunks with metadata. Uses the Phase 27 hybrid pipeline internally.
  - *Acceptance:* MCP tool call with query returns >= 1 result. Results match HTTP /api/rlm/search output for same query. 3 tests.

- [ ] **MCP-03**: Memory system exposed as MCP tools: amauta/memory-store (store a memory), amauta/memory-search (semantic search), amauta/memory-distill (trigger distillation). Parameters follow existing daemon API contracts.
  - *Acceptance:* Store -> search round-trip returns the stored memory. Distill trigger completes without error. 4 tests.

- [ ] **MCP-04**: RPETD context exposed as MCP resources. amauta://context/{task_id}/{phase} returns the RPETDContext for a given task and phase. Resource list includes all active tasks.
  - *Acceptance:* MCP resource read returns valid JSON matching RPETDContext schema. Resource list is non-empty when tasks exist. 3 tests.

- [ ] **MCP-05**: Research chain exposed as MCP tool amauta/research. Parameters: {query: string, creative?: boolean}. Runs the 5-step chain (Memory -> SKB -> Context7 -> Perplexity -> WebFetch) and returns consolidated results. Semantic cache checked before execution.
  - *Acceptance:* Research tool call returns results. Cache hit on identical query returns cached response without API calls. 3 tests.

### Operations — Observability + Security (Phase 30)

Full-stack tracing, kernel-level isolation, and policy enforcement.

- [ ] **OBS-01**: Langfuse deployed on K3s via Helm chart. All 11 agents instrumented with OpenTelemetry spans. Each RPETD phase is a trace, each agent invocation is a span, each tool call is a sub-span. Token costs tracked per trace.
  - *Acceptance:* Langfuse UI shows traces for a complete RPETD cycle. Token cost per phase visible. Trace includes >= 3 span levels (phase -> agent -> tool). Graceful degradation: if Langfuse is down, agents continue operating without tracing. 4 tests.

- [ ] **OBS-02**: Model canary test suite. 50 representative tasks selected from existing 2750 tests. Run against current model on milestone start to establish baseline scores. After any model change, re-run and compare via McNemar's test. Alert if degradation > 1% with p < 0.05.
  - *Acceptance:* Canary suite runs in < 5 minutes. Baseline scores stored in PG. Comparison function returns {degraded: bool, p_value: float, delta: float}. 3 tests.

- [ ] **SEC-01**: Rule of Two audit across all 11 agents. Each agent annotated with capabilities: {reads_untrusted: bool, accesses_sensitive: bool, modifies_state: bool}. Any agent satisfying all three flagged with RULE_OF_TWO_VIOLATION in audit report. Remediation plan documented per violation.
  - *Acceptance:* Audit script produces JSON report. >= 1 violation identified and documented with remediation. Report includes all 11 agents. 3 tests.

- [ ] **SEC-02**: gVisor RuntimeClass installed on K3s nodes. New SandboxProfile CRD defines execution boundaries for code execution tasks. Executor agents' bash commands run inside gVisor sandbox when AMAUTA_SANDBOX=gvisor is set. Fallback to standard container when gVisor unavailable.
  - *Acceptance:* kubectl get runtimeclass shows gvisor. A test command runs inside sandbox and produces output. Network egress blocked from sandbox by default. Fallback path tested. 4 tests.

- [ ] **SEC-03**: Tool definition integrity checking. All MCP tool definitions hashed at startup. Runtime hash comparison before each tool invocation. Hash mismatch logs a TOOL_INTEGRITY_VIOLATION warning and blocks the call. Covers both built-in tools and external MCP servers.
  - *Acceptance:* Modifying a tool definition between startup and invocation produces a violation warning. Unmodified tools pass integrity check silently. 3 tests.

## Future Requirements

Deferred beyond v2.9:

- **A2A Agent Cards** — Agent-to-agent discovery protocol (v0.3, not production-ready)
- **RouteLLM dynamic routing** — Replace static model routing with learned routing (requires training data)
- **Local LLM tier** — Qwen3.5 35B-A3B via Ollama for zero-cost T/D phases (requires GPU node)
- **libSQL fallback** — DiskANN vector search for PG-down degraded mode
- **Sleep-time agents** — Async memory consolidation (Letta/MemGPT pattern)
- **SAGE plan-induction** — Analyze failed trajectories to produce corrective plans
- **pass^k behavioral testing** — Multi-trial policy adherence measurement

## Out of Scope

| Feature | Reason |
|---------|--------|
| A2A protocol support | v0.3 spec, not stable enough for production |
| GPU-dependent features | No GPU node in current K3s cluster |
| Full Kubernetes migration | Daemon stays as Python process; K3s for observability/security only |
| SPLADE/ColBERT retrieval | Storage overhead disproportionate for ~100K-line codebase |
| Agent rewriting/replacement | Optimize existing 11 agents, not rebuild |
| Real-time streaming MCP | SSE transport sufficient; WebSocket deferred |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 26 | Pending |
| INFRA-02 | Phase 26 | Pending |
| INFRA-03 | Phase 26 | Pending |
| INFRA-04 | Phase 26 | Pending |
| RLM-01 | Phase 27 | Pending |
| RLM-02 | Phase 27 | Pending |
| RLM-03 | Phase 27 | Pending |
| RLM-04 | Phase 27 | Pending |
| RLM-05 | Phase 27 | Pending |
| RLM-06 | Phase 27 | Pending |
| BEHAV-01 | Phase 28 | Pending |
| BEHAV-02 | Phase 28 | Pending |
| BEHAV-03 | Phase 28 | Pending |
| BEHAV-04 | Phase 28 | Pending |
| BEHAV-05 | Phase 28 | Pending |
| BEHAV-06 | Phase 28 | Pending |
| MCP-01 | Phase 29 | Pending |
| MCP-02 | Phase 29 | Pending |
| MCP-03 | Phase 29 | Pending |
| MCP-04 | Phase 29 | Pending |
| MCP-05 | Phase 29 | Pending |
| OBS-01 | Phase 30 | Pending |
| OBS-02 | Phase 30 | Pending |
| SEC-01 | Phase 30 | Pending |
| SEC-02 | Phase 30 | Pending |
| SEC-03 | Phase 30 | Pending |

**Coverage:**
- v2.9 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after initial definition*
