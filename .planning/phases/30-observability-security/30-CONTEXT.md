# Phase 30: Observability + Security - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning
**Source:** User-provided design context + discuss-phase Q&A

<domain>
## Phase Boundary

Full-stack tracing, kernel-level isolation, and policy enforcement wrap the completed v2.9 stack. Five additive capabilities land without changing any existing behavior: Langfuse OTel tracing (daemon + MCP server), model canary regression suite, Rule of Two capability audit, gVisor K3s sandbox, and MCP tool integrity checking. Everything degrades gracefully — no feature in this phase blocks agent execution if unavailable.

**Design principle (carried from v2.0):** Additive infrastructure only. Nothing in Phase 30 changes how agents, the daemon, or local dev sessions work. Spans are fire-and-forget. gVisor is K3s-only. Canary suite is a new manifest over existing tests. Rule of Two is a read-only audit script. Tool integrity is a startup-time check that blocks calls only on detected tampering.

</domain>

<decisions>
## Implementation Decisions

### K3s Cluster Assumption (OBS-01, SEC-02)
- **K3s is already running** on the Robert Amauta 3-node cluster. Phase 30 does NOT provision K3s.
- **Phase 30 K3s deliverables only:** Langfuse Helm values for the existing cluster, gVisor RuntimeClass manifest, namespace + RBAC for observability/security workloads.
- **Graceful degradation on local Mac dev:** Langfuse skipped (OTEL_EXPORTER not set), gVisor skipped (no RuntimeClass). Canary suite and Rule of Two audit still run — they have no K3s dependency.
- **K3s-dependent features are additive**, not required. Local dev is unchanged.

### OTel Instrumentation Placement (OBS-01)
- **Instrumentation lives in `services/amauta-daemon.py`** — every HTTP endpoint handler wraps execution in an OTel span.
- **Span shape per endpoint call:** `{agent_name, phase, task_id, duration_ms, token_count, status}`.
- **The daemon is the single chokepoint** — all 11 agents go through it, so instrumenting the daemon covers all agent invocations without touching agent `.md` files.
- **`gsd-tools.cjs` is NOT instrumented** — keep the CJS layer thin. No OTel in Node.
- **`services/amauta-mcp.py` gets its own spans** — tool invocations (one span per `call_tool` / `read_resource` call). Same OTLP exporter pattern.
- **Both daemon + MCP server export via OTLP** to Langfuse endpoint.
- **Fire-and-forget** — if Langfuse is down, spans are dropped silently. Never block agent execution for telemetry. Span export happens in a background thread or with zero timeout.
- **Span hierarchy:** RPETD phase → agent invocation (API call) → tool call sub-span. This gives `>= 3 span levels` as required.

### Canary Suite Design (OBS-02)
- **Stratified by requirement category** — not random. Select ~3 tests per category: HANDOFF, STALE, CAVE, CACHE, SEMANTIC, ROUTE, INFRA, RLM, BEHAV (~9 categories × ~5-6 tests = ~50 total).
- **Scoring: `node --test` exit codes** — binary pass/fail per test. No LLM evaluation (expensive and non-deterministic).
- **Suite artifact:** JSON manifest `tests/fixtures/30-canary-manifest.json` listing `{test_file, test_name, requirement_id}` tuples.
- **Baseline stored in PG** — existing `pg_store.py` pattern; new table or JSONB column in `rpetd_context`.
- **McNemar's test** on pass/fail vectors before/after model change. Alert threshold: degradation > 1% with p < 0.05.
- **Hand-curated initial list** — random sampling would miss edge cases. Planner selects from existing test files.
- **Runtime target:** < 5 minutes for the full 50-test suite.

### gVisor Sandbox Scope (SEC-02)
- **K3s-only sandbox** — local Claude Code sessions on Mac are unchanged. Local dev is trust-the-developer; K3s production is trust-nothing.
- **Mechanism:** When running on K3s, executor tasks dispatched via the daemon spawn as K3s Jobs with gVisor RuntimeClass. `AMAUTA_SANDBOX=gvisor` env var gates this path.
- **SEC-02 deliverables:** gVisor RuntimeClass manifest + SandboxProfile CRD + a test that verifies gVisor is active on K3s nodes + fallback test (standard container when gVisor unavailable).
- **Local behavior:** Executor bash commands continue running in the user's shell via Claude Code's own sandboxing. No change.
- **Network egress blocked from gVisor sandbox** by default — this is the key security property.

### Rule of Two Audit (SEC-01)
- **Read-only audit script** — produces a JSON report, changes nothing.
- **Capability annotations per agent:** `{reads_untrusted: bool, accesses_sensitive: bool, modifies_state: bool}`.
- **All 11 agents** in `agents/` directory covered.
- **Any agent with all three = true** → flagged as `RULE_OF_TWO_VIOLATION` with remediation plan.
- **At least 1 violation expected** — gsd-executor-backend and gsd-executor-general are plausible candidates (they read untrusted code, access PG/Valkey, and modify files).

### Tool Integrity Checking (SEC-03)
- **Lives in `services/amauta-mcp.py`** — hashes all tool definitions at startup.
- **Hash target:** each tool's `name` + `inputSchema` JSON (deterministic serialization).
- **Runtime check:** before each `call_tool` invocation, re-hash and compare to startup hash.
- **On mismatch:** log `TOOL_INTEGRITY_VIOLATION` warning + block the call (return error to caller).
- **On match:** silent pass — no logging overhead.
- **Covers:** built-in amauta tools + any external MCP server tool definitions registered at startup.

### Claude's Discretion
- OTel SDK version pinned in requirements.txt
- Exact Langfuse Helm chart version and values structure
- RPETD phase span ID linking implementation (how PHASE_TASK_ID maps to trace IDs)
- Canary manifest exact format (beyond the `{test_file, test_name, requirement_id}` minimum)
- gVisor RuntimeClass apiVersion and exact CRD schema details
- Background thread vs. async executor for fire-and-forget span export

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Daemon — instrumentation target (OBS-01)
- `services/amauta-daemon.py` — 2967-line HTTP daemon. Read `do_GET` (line 1023) and `do_POST` (line 1631) handler dispatch loops before adding OTel wrapping. Every endpoint handler is a candidate span boundary.
- `services/pg_store.py` — PG connection pattern; canary baseline table follows same init pattern.

### MCP server — tool integrity + OTel spans (SEC-03, OBS-01)
- `services/amauta-mcp.py` — Tool definitions in `list_tools()` (Wave 1 scaffold); `call_tool()` dispatcher. Integrity hash computed over `name + inputSchema` per tool at startup.

### Agent definitions — Rule of Two audit targets (SEC-01)
- `agents/gsd-checker.md`, `agents/gsd-debugger.md`, `agents/gsd-executor-backend.md`, `agents/gsd-executor-frontend.md`, `agents/gsd-executor-general.md`, `agents/gsd-executor-infra.md`, `agents/gsd-operator.md`, `agents/gsd-planner.md`, `agents/gsd-researcher.md`, `agents/gsd-roadmapper.md`, `agents/gsd-validator.md` — All 11 agents; read capabilities sections before writing audit annotations.

### Existing tests — canary suite source (OBS-02)
- `tests/` directory — 2750 tests across ~30 CJS test files. Stratified selection across: HANDOFF (tests/04-*), STALE (tests/05-*), CAVE (tests/08-*), CACHE (tests/04-02, 05-*), SEMANTIC (tests/verify.test.cjs), ROUTE (tests/06-02*), INFRA (tests/05-01*), RLM (tests/rlm-*), BEHAV (tests/28-*).
- `tests/fixtures/` — Existing fixtures directory; `30-canary-manifest.json` goes here.

### Infrastructure — K3s delivery targets (OBS-01, SEC-02)
- `docker/docker-compose.yml` — Existing services pattern; Langfuse service added here for local dev if available.
- `requirements.txt` — Python deps; add `opentelemetry-sdk`, `opentelemetry-exporter-otlp`.

### Requirements
- `.planning/REQUIREMENTS.md` §OBS-01..OBS-02, §SEC-01..SEC-03 — Acceptance criteria (all 5 requirements).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/amauta-daemon.py` `_send_json()` method — wraps all endpoint responses; OTel span ends just before this call (captures full handler duration including any subprocess calls).
- `services/pg_store.py` `_get_conn()` — connection pattern with `ivfflat.iterative_scan` set; canary baseline storage follows same pattern (new table `canary_baselines`).
- `services/amauta-mcp.py` `@server.call_tool()` decorator — single intercept point for SEC-03 integrity check before any tool handler runs.
- Existing `node --test` test runner used across all CJS test files — canary suite reuses same runner, no new test framework.

### Established Patterns
- All services use `_load_dotenv()` for env config — OTel exporter endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`) follows same pattern: read from env, skip gracefully if unset.
- Fire-and-forget pattern precedent: semantic cache and research cache both use try/except with pass on failure — OTel export follows same pattern.
- Divergence protocol v1.2.0: `TOOL_INTEGRITY_VIOLATION` follows the same structured-warning format as `manifest_violation` (logged, surfaced to caller, not silently swallowed).

### Integration Points
- Daemon `do_GET`/`do_POST` handlers — OTel spans wrap each handler's body; `agent_name` extracted from request headers or query params.
- `services/amauta-mcp.py` `call_tool()` — integrity check fires here before dispatch; startup hash computed once in `__main__` before server starts.
- `tests/fixtures/` — canary manifest lives here alongside `27-golden-queries.json`.
- K3s manifests — new directory `k8s/` or `manifests/` at repo root; Helm values in `k8s/langfuse-values.yaml`, RuntimeClass in `k8s/gvisor-runtimeclass.yaml`.

</code_context>

<specifics>
## Specific Ideas

- "Everything degrades gracefully — no feature in this phase blocks agent execution if unavailable." — This is the load-bearing constraint for all 5 requirements. Langfuse down = silent span drop. gVisor missing = standard container. If this principle is violated in any task, it's a divergence.
- "The daemon is the single chokepoint — all 11 agents go through it." — Instrumentation at the daemon layer covers all 11 agents without modifying agent `.md` files or `gsd-tools.cjs`.
- "Hand-curate the canary list — random sampling would miss important edge cases." — Planner selects tests, not a random seed.
- "Local dev is trust-the-developer; K3s production is trust-nothing." — gVisor and K3s RBAC are production controls, not dev experience changes.
- "The standalone MCP service with direct PG/Valkey is v3.0 scope." — Do NOT retrofit amauta-mcp.py in this phase. Current daemon-wrapper pattern is accepted for v2.9.

</specifics>

<deferred>
## Deferred Ideas

- **amauta-mcp.py as standalone service with direct PG/Valkey** — v3.0 "The Birth" milestone. When Amauta becomes ecosystem infrastructure (accessible to Cursor, Gemini CLI, any MCP-compatible client), the MCP server gets its own connection pool and stops delegating to the daemon. Not v2.9.
- **RouteLLM dynamic routing** for canary-triggered model switching — post-v2.9 (requires training data).
- **Pass^k behavioral testing** for multi-trial policy adherence — post-v2.9.

</deferred>

---

*Phase: 30-observability-security*
*Context gathered: 2026-04-13*
