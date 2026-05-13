# Roadmap: GSD-Amauta

## Milestones

- ✅ **v2.0 Self-Upgrade** — Phases 1-5 (shipped 2026-03-21)
- ✅ **v2.1 Durability & Compliance** — Phases 6-10 (shipped 2026-03-23)
- ✅ **v2.2 → v2.9** — see `.planning/milestones/` archives
- ✅ **v3.0 The Birth** — Phases 31-40 (shipped 2026-04-14)
- ✅ **v3.1 The Gathering** — Phases 41-47 (shipped 2026-05-13)
- 🚧 **v3.2 The Federation** — Phases 48-53 (in progress)

## Current State

v3.1 "The Gathering" complete: BMAD-METHOD patterns grafted onto Amauta's infrastructure. v3.2 "The Federation" begins: bind skills, agents, and infrastructure into installable modules; enable multi-agent collaboration on a shared blackboard; ship symmetric agent compilation to match skill compilation; close v3.1 carry-forward polish items.

## v3.1 Phases (archived)

<details>
<summary>✅ v3.1 The Gathering (Phases 41-47) — SHIPPED 2026-05-13</summary>

- [x] Phase 41: Sharded Workflows (FOUNDATION) — 3 plans, 151 assertions
- [x] Phase 42: Scale-Adaptive Intelligence — 4 plans, 150 JS + 32 Py assertions
- [x] Phase 43: Skills Architecture — 3 plans, 53 tests
- [x] Phase 44: Cross-IDE Installer — 3 plans, 47 tests
- [x] Phase 45: Intelligent Help Routing — 2 plans, 23 tests
- [x] Phase 46: Standalone MCP Server — 2 plans, 50 tests
- [x] Phase 47: Agent Dynamic Hydration — 3 plans, 30 tests

Archive: `.planning/milestones/v3.1-ROADMAP.md` · `.planning/milestones/v3.1-REQUIREMENTS.md` · `.planning/milestones/v3.1-MILESTONE-AUDIT.md`

</details>

---

# v3.2 "The Federation" — Active Milestone

**Starting phase number:** 48 (v3.1 ended at Phase 47)
**Phases:** 6 (Phases 48..53)
**Requirements:** 17 total (v3.2 scope)
**Granularity:** coarse (per config.json; 6 phases — each category is a natural delivery boundary; MOD and PARTY split for blast-radius isolation)
**Status:** Defined 2026-05-13

**Core value:** Every RPETD phase must see what the other phases have already learned — the brain synthesizes, not accumulates. The Federation binds individuals into operable, installable, cooperating units.

**Body-metaphor sequence:** brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → birth (v3.0) → gathering (v3.1) → **federation (v3.2)**. The Federation is when the organism joins peers: it learns to package itself for reuse (modules), to deliberate with others on a shared whiteboard (party mode), and to render its agents portably the way it already renders its skills (compilation). Modules give it identity, party mode gives it society, compilation gives it symmetry. The carry-forward polish closes the seams from v3.1.

**Goal:** GSD-Amauta capabilities are installable as semver-resolved modules; multiple agents can collaborate on a shared blackboard with structured turn-taking and decision records; agent definitions compile from canonical YAML to per-IDE Markdown the same way skills do; the v3.1 polish items (skill schemas, installer upgrade/uninstall, MCP wrappers, hydration auto-invoke) ship.

---

## Hard Constraints (apply to every phase)

1. **No new runtimes.** Python + Node.js only. Modules add no new runtime; they bundle existing-runtime artifacts.
2. **Backward compatible.** All existing data, configs, agents, skills, and workflows must continue working after `npm install -g . && docker compose up`. Existing `agents/*.md` files remain as compile outputs once COMPILE-01 lands.
3. **Manifest enforcement active.** HARDEN-01 `files_expected` blocks are mandatory per task.
4. **`gsd-tools plan-to-tasks` auto-registration mandatory.** Every PLAN.md must have `<story>` and `<task>` XML blocks. Pass 0 cycle detection enabled.
5. **Divergence protocol v1.1.0 active.** Surface mismatches; never silently absorb them. Phase 13 fingerprint = halt-phase trigger.
6. **Scope ceilings are load-bearing.** Exceeding declared LOC ceiling without a divergence report triggers halt-phase.
7. **Test coverage maintained.** `node --test tests/` and `pytest` must pass with 0 new failures before each phase is marked complete.
8. **820 assertion baseline.** v3.0 shipped 820 assertions; v3.1 maintained or exceeded. v3.2 must continue to maintain or exceed.
9. **Research-backed.** Every non-trivial design decision must cite its source (research finding, academic paper, prior research brief, or shipped Amauta pattern).

---

## Phases

- [x] **Phase 48: Module System Foundation** — Module manifest YAML schema + Pydantic validation + semver dependency resolver with conflict detection + gsd-tools `module validate` CLI dispatch (MOD-01, MOD-02). Plans 48-01 + 48-02 complete (2026-05-13).
- [x] **Phase 49: Module CLI + Lifecycle** — `gsd-amauta module install/uninstall/upgrade <name>` subcommands with idempotency, dry-run, and rollback (MOD-03, MOD-04). Plans 49-01/02/03/04 complete (2026-05-13). 93 total tests (25 Node + 68 pytest). 10/10 v3.1 canary diffs empty. MOD-03 + MOD-04 fulfilled.
- [ ] **Phase 50: Party Mode Foundation** — `party_sessions` PG table + session state machine + persistent session memory (resumable from blackboard replay) (PARTY-01, PARTY-02). Plan 50-01 complete (2026-05-13): migration 021 (UP+DOWN) + PartySession Pydantic + 5 FROZEN transitions + 19 tests.
- [ ] **Phase 51: Party Mode Decisions + Operator CLI** — Structured decision records (propose/agree/dissent/block) + `gsd-amauta party status/inspect/kill` subcommands (PARTY-03, PARTY-04). Depends on 50.
- [ ] **Phase 52: Agent Compilation** — Canonical AGENT.yaml schema + `gsd-tools agents compile` symmetric with Phase 43 skill compiler + per-IDE alias tables + optional compile-time hydration bake (COMPILE-01, COMPILE-02, COMPILE-03, COMPILE-04).
- [ ] **Phase 53: v3.1 Carry-Forwards** — Skill input/output schemas + installer upgrade/uninstall + MCP `amauta/bearings` + `amauta/agent-hydrate` + hydration auto-invoke at Task() spawn sites (POLISH-01..05).

---

## Phase Dependency Graph

```
Phase 48: Module System Foundation (no v3.2 deps)
    Manifest schema + semver resolver
    |
    +---> Phase 49: Module CLI + Lifecycle
              (install/uninstall/upgrade builds on schema + resolver)

Phase 50: Party Mode Foundation (no v3.2 deps; uses Phase 38 agent_findings)
    party_sessions PG table + persistence
    |
    +---> Phase 51: Party Mode Decisions + Operator CLI
              (decision records + supervision build on session schema)

Phase 52: Agent Compilation (no v3.2 deps; reuses Phase 43 skill-compiler pattern + Phase 47 agent_hydrator)

Phase 53: v3.1 Carry-Forwards (no v3.2 deps; touches Phase 43/44/45/46/47 surfaces)
```

**Recommended execution order:** 48 → 49 → 50 → 51 → 52 → 53

**Parallelizable blocks:**
- After 48 ships: 49, 50, 52, 53 can run concurrently (no cross-dependencies)
- 51 must wait for 50
- 49 must wait for 48

In practice, recommended serialization is 48 → 49 → 50 → 51 → 52 → 53 to keep one phase active at a time, with parallelization available if delivery pressure requires.

---

## Phase Details

### Phase 48: Module System Foundation
**Goal:** A module manifest (YAML) declares migrations, Docker services, agent definitions, and skill definitions as one cohesive installable unit, and a semver resolver detects dependency conflicts between modules before any install action runs. Foundation for Phase 49 lifecycle commands.
**Depends on:** Nothing (v3.1 shipped; this is the v3.2 foundation phase)
**Requirements:** MOD-01, MOD-02
**Success Criteria** (what must be TRUE):
  1. A module manifest schema (Pydantic) accepts `name`, `version`, `requires` (semver ranges), `migrations`, `services`, `agents`, `skills` fields; `gsd-amauta module validate <manifest.yaml>` exits 0 on a valid manifest and exits 1 with a structured error list on an invalid one.
  2. The semver resolver can take a set of module manifests and detect range conflicts (e.g., module A requires `core@^1.0`, module B requires `core@^2.0`) before any install, producing a deterministic conflict report listing the offending pair and the incompatible ranges.
  3. A two-module fixture with a satisfiable dependency graph (module B requires module A `^1.0`, module A is at `1.2.0`) resolves cleanly with a stable install order; the same fixture with module A pinned to `2.0.0` produces a non-zero exit and a conflict report.
  4. Manifest schema is documented and stable: a regression test pins the field set so accidental schema drift fails the build.
**Canonical refs:**
  - PROJECT.md "Active — v3.2 The Federation" section, Module System bullets
  - REQUIREMENTS.md MOD-01, MOD-02
  - Precedent: Phase 43 `SkillFrontmatter` Pydantic model (`get-shit-done/skills/<name>/SKILL.md`); apply the same schema-first approach
  - Precedent: Phase 44 `platform-codes.yaml` frozen-schema pattern (line-by-line yaml parser, zero new deps)
**Plans:** 2/2 plans complete

### Phase 49: Module CLI + Lifecycle
**Goal:** Operators can install, uninstall, and upgrade modules with idempotent + reversible semantics, dry-run preview, and rollback on partial failure. Upgrade preserves user data via the module's migrations.
**Depends on:** Phase 48 (CLI consumes the manifest schema + resolver)
**Requirements:** MOD-03, MOD-04
**Success Criteria** (what must be TRUE):
  1. `gsd-amauta module install <name>` followed by `gsd-amauta module uninstall <name>` returns the filesystem + PG state to the pre-install state; a directory diff between pre-install and post-uninstall is empty (excluding logs).
  2. `gsd-amauta module install <name> --dry-run` prints the planned actions (migrations to apply, services to register, agents/skills to copy) without modifying any state; exit 0 and stdout includes a `would_apply:` block.
  3. `gsd-amauta module upgrade <name>` runs the module's expand-and-contract migrations in order (Phase 36 gsd-executor-data pattern) and preserves user data; an integration test seeds rows in a module-owned table, upgrades, and confirms row count and content are unchanged.
  4. A simulated mid-install failure (Docker service registration fails after migrations have applied) triggers automatic rollback: the migrations are undone and the on-disk state matches pre-install; rollback is logged with the failing step.
**Canonical refs:**
  - REQUIREMENTS.md MOD-03, MOD-04
  - Precedent: Phase 44 `bin/init.cjs` 7-step `buildStepResult()` schema and worst-of combinator (apply the same per-step result schema to module install/uninstall/upgrade steps)
  - Precedent: Phase 36 gsd-executor-data expand-and-contract migration discipline
  - Precedent: Phase 47 `services/agent_hydrate_cli.py` argparse + spawnSync shell-out wiring through `bin/gsd-tools.cjs`
**Plans:** 4/4 plans complete

### Phase 50: Party Mode Foundation
**Goal:** A multi-agent collaboration session is backed by the existing `agent_findings` blackboard with a new `party_sessions` PG table tracking session identity, participant agents, and lifecycle state. Sessions are persistent: pause + resume reconstructs the full context by replaying findings filtered by session_id.
**Depends on:** Nothing (uses Phase 38 `agent_findings` schema which already shipped; Phase 47 added `recipient_agent` + `severity` columns)
**Requirements:** PARTY-01, PARTY-02
**Success Criteria** (what must be TRUE):
  1. Migration 021 creates `party_sessions` table with columns `(session_id, status, participants jsonb, created_at, updated_at, paused_at, terminated_at)`; the migration applies cleanly via `bin/gsd-amauta.cjs` migrations runner, and a regression test exercises UP + DOWN.
  2. A session state machine enforces the transitions `created → active → paused → active → terminated`; invalid transitions (e.g., terminated → active) return an error and do not mutate the row.
  3. Two agents posting findings tagged with the same `session_id` write to `agent_findings` with the session_id surfaced as a queryable column; an integration test verifies turn-taking by checking that findings are ordered and attributable.
  4. After pausing a session and starting a new daemon process, calling `gsd-amauta party resume <session_id>` returns the full ordered history of findings for that session reconstructed from `agent_findings` joined on `session_id` (no state lost across the daemon restart).
**Canonical refs:**
  - REQUIREMENTS.md PARTY-01, PARTY-02
  - Precedent: Phase 38 `agent_findings` + `agent_messages` blackboard tables and daemon endpoints
  - Precedent: Phase 41 `step_handoffs` append-only PG persistence pattern (apply same append-only mindset to party findings)
  - Precedent: Phase 47 Plan 47-00 migration 020 schema-extension discipline
**Plans:** TBD

### Phase 51: Party Mode Decisions + Operator CLI
**Goal:** Agents in a party session can record structured decisions (propose, agree, dissent, block) with reasoning, and the operator has a CLI surface to list, inspect, and terminate sessions. Consensus and dissent are both first-class and visible.
**Depends on:** Phase 50 (decisions and CLI consume the `party_sessions` schema and resume API)
**Requirements:** PARTY-03, PARTY-04
**Success Criteria** (what must be TRUE):
  1. A `decision_type` field on findings within a session accepts the frozen vocabulary `propose | agree | dissent | block`; an integration test posts one propose + one agree + one dissent + one block and confirms all four are queryable as a structured decision trail.
  2. `gsd-amauta party status` lists all sessions with status, participant count, and decision-count summaries; `gsd-amauta party inspect <session_id>` prints the ordered turn history and the decision trail (consensus and dissent both shown); `gsd-amauta party kill <session_id>` terminates the session with an audit-trail row recording who killed it and when.
  3. Dissent records do NOT auto-rollback or auto-resolve — they are recorded and surfaced to the operator only. A regression test verifies that a dissent finding leaves the session active and does not mutate other agents' work (matches Out-of-Scope item "Auto-rollback on Party Mode dissent" in REQUIREMENTS.md).
  4. `gsd-amauta party inspect <session_id> --json` returns a stable JSON shape (frozen schema with `schema_version: "1.0"`) suitable for downstream tooling and tests.
**Canonical refs:**
  - REQUIREMENTS.md PARTY-03, PARTY-04
  - REQUIREMENTS.md Out of Scope: "Auto-rollback on Party Mode dissent" + "LLM-driven turn-taking" (operator-supervised, deterministic)
  - Precedent: Phase 45 `gsd-tools bearings` frozen 6-rule recommendation + JSON `schema_version: 1.0` pattern
  - Precedent: Phase 38 operator supervision endpoints on the blackboard
**Plans:** TBD

### Phase 52: Agent Compilation
**Goal:** Agent definitions move to canonical YAML (mirroring Phase 43's skill canonicalization) and compile to per-IDE Markdown via `gsd-tools agents compile`. Per-IDE alias tables convert tool names + frontmatter the same way `skill-compiler.cjs` does. Optional compile-time hydration injection reuses Phase 47's `agent_hydrator.hydrate` to bake current context into the output.
**Depends on:** Nothing in v3.2 (reuses shipped Phase 43 skill-compiler pattern and shipped Phase 47 `services/agent_hydrator.py`)
**Requirements:** COMPILE-01, COMPILE-02, COMPILE-03, COMPILE-04
**Success Criteria** (what must be TRUE):
  1. Canonical agent definitions exist at `get-shit-done/agents/<name>/AGENT.yaml` with frontmatter fields (`name`, `description`, `tools`, `color`, `memory`, `skills`) plus structured body sections matching the v3.0 standardized 10-section format; existing `agents/*.md` files are regenerated from YAML and match the prior content byte-for-byte for unchanged YAML inputs (backward compatibility lock).
  2. `gsd-tools agents compile --target=claude-code` reads canonical YAML and emits `.md` files into `~/.claude/agents/`; `--target=opencode` emits into `.opencode/agents/`; `--target=cursor` emits into the cursor agents directory; output format matches the target IDE's expected layout.
  3. Per-IDE alias tables (e.g., `Read → read_file` for IDEs using snake_case tool names) live in the compiler under a `TARGET_MAPS`-shaped constant — NOT in the YAML; a unit test confirms that the same canonical YAML produces three different `.md` outputs when compiled to three IDE targets, and the differences are exactly the alias remappings.
  4. `gsd-tools agents compile --hydrate <agent>` invokes `agent_hydrator.hydrate(agent_name)` and bakes the result into the output `.md` as a `## Current context` section; without `--hydrate`, the output stays generic and cacheable (no PG/Valkey reads at compile time).
**Canonical refs:**
  - REQUIREMENTS.md COMPILE-01..04
  - Precedent: Phase 43 `scripts/skill-compiler.cjs` `TARGET_MAPS` pattern + 3 IDE targets (claude identity / opencode +compatibility / cursor snake_case aliases)
  - Precedent: Phase 47 `services/agent_hydrator.py` `hydrate(agent_name)` API and `## Current context` frozen section header
  - Precedent: Phase 31 v3.0 standardized 10-section agent format (FORMAT-01..07)
**Plans:** TBD

### Phase 53: v3.1 Carry-Forwards
**Goal:** Five carry-forward items from v3.1 land in one bundle: skills get input/output schemas, the installer gains upgrade + uninstall, the MCP server gets `amauta/bearings` and `amauta/agent-hydrate` tools, and every Task() spawn site in the workflow runner auto-invokes hydration.
**Depends on:** Nothing in v3.2 (touches Phase 43 skill schema, Phase 44 installer, Phase 45 bearings, Phase 46 MCP server, Phase 47 hydration — all shipped)
**Requirements:** POLISH-01, POLISH-02, POLISH-03, POLISH-04, POLISH-05
**Success Criteria** (what must be TRUE):
  1. `SkillFrontmatter` accepts optional `input_schema` and `output_schema` Pydantic-validated fields; `gsd-tools skills validate` checks them at compile time when present; a skill with a malformed schema fails validation with a structured error pointing to the offending field.
  2. `bin/init.cjs --upgrade` runs version-aware migration (pre-existing installs get patched in place, user data preserved); `bin/init.cjs --uninstall` removes Amauta from the project while preserving user-authored content (PLAN.md, REQUIREMENTS.md, ROADMAP.md, STATE.md untouched); both flags emit the Phase 44 frozen per-step result schema and a worst-of overall exit code.
  3. MCP tool `amauta/bearings` is registered in `services/amauta-mcp.py` and returns the same JSON shape as `gsd-tools bearings --json` for the same project state; MCP tool `amauta/agent-hydrate` mirrors `gsd-tools agent-hydrate --json`; both are listed in `tools/list` and callable from an MCP client.
  4. The workflow runner has a single hook that, before each `Task()` subagent invocation, shells out to `gsd-tools agent-hydrate <agent>` and injects the rendered `## Current context` block into the agent prompt; a regression test spawns a subagent with the hook enabled and confirms the prompt contains the hydrated section, and with the hook disabled (kill switch) it does not.
**Canonical refs:**
  - REQUIREMENTS.md POLISH-01..05
  - Precedent: Phase 43 `SkillFrontmatter` Pydantic model + 7-field declaration order (POLISH-01 extends this)
  - Precedent: Phase 44 `bin/init.cjs` 7-step flow + frozen `buildStepResult` schema (POLISH-02 extends with --upgrade + --uninstall)
  - Precedent: Phase 45 `gsd-tools bearings --json` schema_version 1.0 (POLISH-03 wraps as MCP tool)
  - Precedent: Phase 46 `services/amauta-mcp.py` direct-PG MCP tool registration pattern (POLISH-03 + POLISH-04 add two tools)
  - Precedent: Phase 47 `gsd-tools agent-hydrate` CLI + render_markdown frozen template (POLISH-04 wraps as MCP tool; POLISH-05 invokes at spawn sites)
**Plans:** TBD

---

## Progress

**Execution Order:** 48 → 49 → 50 → 51 → 52 → 53

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 48. Module System Foundation | 1/1 | Complete    | 2026-05-13 |
| 49. Module CLI + Lifecycle | 0/0 | Complete    | 2026-05-13 |
| 50. Party Mode Foundation | 0/0 | Not started | - |
| 51. Party Mode Decisions + Operator CLI | 0/0 | Not started | - |
| 52. Agent Compilation | 0/0 | Not started | - |
| 53. v3.1 Carry-Forwards | 0/0 | Not started | - |

---

*Roadmap created: 2026-05-13 for v3.2 "The Federation" milestone.*
*Primary input: .planning/REQUIREMENTS.md (17 requirements across 4 categories), PROJECT.md (v3.2 goal + body-metaphor sequence)*
*Phase structure: requirement-category derived (Module / Party / Compilation / Polish) with MOD and PARTY split into foundation + lifecycle pairs for blast-radius isolation*
*Previous milestone (v3.1 The Gathering): 7 phases shipped (41-47), 25 requirements, ~536 tests; archive at .planning/milestones/v3.1-ROADMAP.md*
