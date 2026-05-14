# Requirements: GSD-Amauta v3.2 "The Federation"

**Defined:** 2026-05-13
**Core Value:** Every RPETD phase must see what the other phases have already learned — the brain synthesizes, not accumulates. The Federation binds individuals into operable, installable, cooperating units.

## v3.2 Requirements

Requirements for v3.2 "The Federation" — module system + multi-agent collaboration + agent compilation + v3.1 carry-forwards.

### Module System

- [x] **MOD-01**: Registry-based module architecture. Module manifest (YAML) declares the migrations, Docker services, agent definitions, and skill definitions that compose the module. Module = one cohesive installable unit.
- [x] **MOD-02**: Semver dependency resolution between modules. `requires:` field in manifest accepts semver ranges (e.g., `^1.2.0`). Resolver detects conflicts before install (e.g., module A requires `core@^1.0`, module B requires `core@^2.0`).
- [x] **MOD-03**: `gsd-amauta module install <name>`, `gsd-amauta module uninstall <name>`, `gsd-amauta module upgrade <name>` CLI subcommands. Each is idempotent + reversible (`--dry-run` flag); upgrade preserves user data via the underlying migrations.
- [x] **MOD-04**: Module manifest schema validation (Pydantic) + reproducible install. Same manifest input → same on-disk state. Rollback path on partial failure (any step error → undo applied changes).

### Party Mode (Multi-Agent Collaboration)

- [x] **PARTY-01**: Multi-agent session backed by `agent_findings` blackboard. New `party_sessions` PG table tracks session_id + participant agent list. Agents post findings tagged with session_id; structured turn-taking enforced via session state machine.
- [x] **PARTY-02**: Persistent session memory across agent invocations. A session can pause (operator command) and resume later with full context replay from `agent_findings` filtered by session_id.
- [x] **PARTY-03**: Structured decision records. When agent A proposes and agent B agrees/disagrees, both records are captured with reasoning (`decision_type: propose | agree | dissent | block`); consensus and dissent both visible to operator.
- [x] **PARTY-04**: Operator supervision CLI. `gsd-amauta party status` (list active sessions), `gsd-amauta party inspect <session_id>` (turn history + decisions), `gsd-amauta party kill <session_id>` (terminate with audit trail).

### Agent Compilation

- [x] **COMPILE-01**: Agent definitions in canonical YAML format under `get-shit-done/agents/<name>/AGENT.yaml`. YAML carries frontmatter (name/description/tools/color/memory/skills) plus the 10-section body content as structured fields. Existing `agents/*.md` files remain as compile outputs.
- [x] **COMPILE-02**: `gsd-tools agents compile --target=<ide>` subcommand. Symmetric with Phase 43 `gsd-tools skills compile`. Reads canonical YAML, emits per-IDE Markdown to the IDE's agent directory (claude → `~/.claude/agents/`, opencode → `.opencode/agents/`, etc.).
- [x] **COMPILE-03**: Per-IDE alias tables for tool names + frontmatter (e.g., `Read` → `read_file` for IDEs that use snake_case). Same pattern as `scripts/skill-compiler.cjs` TARGET_MAPS. Lives in the compiler, not in the YAML.
- [x] **COMPILE-04**: Optional compile-time hydration injection via `--hydrate <agent>` flag. Reuses Phase 47 `agent_hydrator.hydrate(agent_name)` to bake current context into the output `.md`. Default off (output stays generic + cacheable).

### v3.1 Carry-Forwards (Polish)

- [x] **POLISH-01**: Skill `input_schema` / `output_schema` Pydantic-validated frontmatter fields. Optional; when present, `gsd-tools skills validate` checks compile-time conformance.
- [x] **POLISH-02**: Installer upgrade/uninstall flow. `bin/init.cjs` gains `--upgrade` (version-aware migration) and `--uninstall` (Phase 44 was install-only). Idempotent; preserves user data; per-step result schema from Phase 44.
- [x] **POLISH-03**: MCP `amauta/bearings` tool wrapping `gsd-tools bearings`. Added to `services/amauta-mcp.py` tool list. Mirrors `gsd-tools bearings --json` output.
- [x] **POLISH-04**: MCP `amauta/agent-hydrate` tool wrapping `gsd-tools agent-hydrate`. Same wrapper pattern as POLISH-03.
- [x] **POLISH-05**: Hydration auto-invoke at every Task() spawn site. New workflow runner hook calls `gsd-tools agent-hydrate <agent>` before each subagent invocation and injects the rendered block into the agent prompt.

## Future Requirements (v3.3+)

### A2A Protocol
- **A2A-01**: Direct agent-to-agent message protocol (peer messaging, not blackboard broadcast). Requires Module System foundation.
- **A2A-02**: Authentication + authorization between agents (which agents may message which).

### Distributed Sessions
- **DIST-01**: Party Mode sessions distributed across machines (operator on one host, participants on others).
- **DIST-02**: Federated blackboard sync across distributed sessions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Live web UI for Party Mode | CLI-first; web layer is a separate product surface |
| Mobile client | Out of scope for v3.x; revisit in v4+ |
| Cross-tenant module isolation | Single-operator project assumption holds |
| Auto-discovery of installable modules from a registry server | Module discovery is filesystem-local in v3.2; remote registry is future work |
| LLM-driven turn-taking in Party Mode | Operator-supervised turns are deterministic; LLM-driven turns risk runaway loops |
| Auto-rollback on Party Mode dissent | Dissent is recorded, not auto-acted on — operator decides resolution |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| MOD-01 | Phase 48 | Complete |
| MOD-02 | Phase 48 | Complete |
| MOD-03 | Phase 49 | Complete |
| MOD-04 | Phase 49 | Complete |
| PARTY-01 | Phase 50 | Complete |
| PARTY-02 | Phase 50 | Complete |
| PARTY-03 | Phase 51 | Complete |
| PARTY-04 | Phase 51 | Complete |
| COMPILE-01 | Phase 52 | Complete |
| COMPILE-02 | Phase 52 | Complete |
| COMPILE-03 | Phase 52 | Complete |
| COMPILE-04 | Phase 52 | Complete |
| POLISH-01 | Phase 53 | Complete |
| POLISH-02 | Phase 53 | Complete |
| POLISH-03 | Phase 53 | Complete |
| POLISH-04 | Phase 53 | Complete |
| POLISH-05 | Phase 53 | Complete |

**Coverage:**
- v3.2 requirements: 22 total (17 original + 5 POLISH)
- Mapped to phases: 22 ✓
- Unmapped: 0
- Roadmap: `.planning/ROADMAP.md` (v3.2 "The Federation" — Phases 48-53)

---

*Requirements defined: 2026-05-13*
*Last updated: 2026-05-14 after v3.2 milestone completion (all 22 requirements Complete)*
