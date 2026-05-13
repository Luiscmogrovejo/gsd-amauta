# Requirements: GSD-Amauta v3.2 "The Federation"

**Defined:** 2026-05-13
**Core Value:** Every RPETD phase must see what the other phases have already learned — the brain synthesizes, not accumulates. The Federation binds individuals into operable, installable, cooperating units.

## v3.2 Requirements

Requirements for v3.2 "The Federation" — module system + multi-agent collaboration + agent compilation + v3.1 carry-forwards.

### Module System

- [ ] **MOD-01**: Registry-based module architecture. Module manifest (YAML) declares the migrations, Docker services, agent definitions, and skill definitions that compose the module. Module = one cohesive installable unit.
- [ ] **MOD-02**: Semver dependency resolution between modules. `requires:` field in manifest accepts semver ranges (e.g., `^1.2.0`). Resolver detects conflicts before install (e.g., module A requires `core@^1.0`, module B requires `core@^2.0`).
- [ ] **MOD-03**: `gsd-amauta module install <name>`, `gsd-amauta module uninstall <name>`, `gsd-amauta module upgrade <name>` CLI subcommands. Each is idempotent + reversible (`--dry-run` flag); upgrade preserves user data via the underlying migrations.
- [ ] **MOD-04**: Module manifest schema validation (Pydantic) + reproducible install. Same manifest input → same on-disk state. Rollback path on partial failure (any step error → undo applied changes).

### Party Mode (Multi-Agent Collaboration)

- [ ] **PARTY-01**: Multi-agent session backed by `agent_findings` blackboard. New `party_sessions` PG table tracks session_id + participant agent list. Agents post findings tagged with session_id; structured turn-taking enforced via session state machine.
- [ ] **PARTY-02**: Persistent session memory across agent invocations. A session can pause (operator command) and resume later with full context replay from `agent_findings` filtered by session_id.
- [ ] **PARTY-03**: Structured decision records. When agent A proposes and agent B agrees/disagrees, both records are captured with reasoning (`decision_type: propose | agree | dissent | block`); consensus and dissent both visible to operator.
- [ ] **PARTY-04**: Operator supervision CLI. `gsd-amauta party status` (list active sessions), `gsd-amauta party inspect <session_id>` (turn history + decisions), `gsd-amauta party kill <session_id>` (terminate with audit trail).

### Agent Compilation

- [ ] **COMPILE-01**: Agent definitions in canonical YAML format under `get-shit-done/agents/<name>/AGENT.yaml`. YAML carries frontmatter (name/description/tools/color/memory/skills) plus the 10-section body content as structured fields. Existing `agents/*.md` files remain as compile outputs.
- [ ] **COMPILE-02**: `gsd-tools agents compile --target=<ide>` subcommand. Symmetric with Phase 43 `gsd-tools skills compile`. Reads canonical YAML, emits per-IDE Markdown to the IDE's agent directory (claude → `~/.claude/agents/`, opencode → `.opencode/agents/`, etc.).
- [ ] **COMPILE-03**: Per-IDE alias tables for tool names + frontmatter (e.g., `Read` → `read_file` for IDEs that use snake_case). Same pattern as `scripts/skill-compiler.cjs` TARGET_MAPS. Lives in the compiler, not in the YAML.
- [ ] **COMPILE-04**: Optional compile-time hydration injection via `--hydrate <agent>` flag. Reuses Phase 47 `agent_hydrator.hydrate(agent_name)` to bake current context into the output `.md`. Default off (output stays generic + cacheable).

### v3.1 Carry-Forwards (Polish)

- [ ] **POLISH-01**: Skill `input_schema` / `output_schema` Pydantic-validated frontmatter fields. Optional; when present, `gsd-tools skills validate` checks compile-time conformance.
- [ ] **POLISH-02**: Installer upgrade/uninstall flow. `bin/init.cjs` gains `--upgrade` (version-aware migration) and `--uninstall` (Phase 44 was install-only). Idempotent; preserves user data; per-step result schema from Phase 44.
- [ ] **POLISH-03**: MCP `amauta/bearings` tool wrapping `gsd-tools bearings`. Added to `services/amauta-mcp.py` tool list. Mirrors `gsd-tools bearings --json` output.
- [ ] **POLISH-04**: MCP `amauta/agent-hydrate` tool wrapping `gsd-tools agent-hydrate`. Same wrapper pattern as POLISH-03.
- [ ] **POLISH-05**: Hydration auto-invoke at every Task() spawn site. New workflow runner hook calls `gsd-tools agent-hydrate <agent>` before each subagent invocation and injects the rendered block into the agent prompt.

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
| MOD-01 | TBD | Pending |
| MOD-02 | TBD | Pending |
| MOD-03 | TBD | Pending |
| MOD-04 | TBD | Pending |
| PARTY-01 | TBD | Pending |
| PARTY-02 | TBD | Pending |
| PARTY-03 | TBD | Pending |
| PARTY-04 | TBD | Pending |
| COMPILE-01 | TBD | Pending |
| COMPILE-02 | TBD | Pending |
| COMPILE-03 | TBD | Pending |
| COMPILE-04 | TBD | Pending |
| POLISH-01 | TBD | Pending |
| POLISH-02 | TBD | Pending |
| POLISH-03 | TBD | Pending |
| POLISH-04 | TBD | Pending |
| POLISH-05 | TBD | Pending |

**Coverage:**
- v3.2 requirements: 17 total
- Mapped to phases: 0 (roadmapper fills next)
- Unmapped: 17 ⚠ (pending roadmap)

---

*Requirements defined: 2026-05-13*
*Last updated: 2026-05-13 after v3.1 milestone completion*
