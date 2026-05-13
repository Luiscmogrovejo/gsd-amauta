# Phase 48: Module System Foundation - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 48 + REQUIREMENTS.md (MOD-01..02) + Phase 43/44/47 patterns (no discuss-phase per session directive)

<domain>
## Phase Boundary

Ship the module manifest schema and the semver dependency resolver. After Phase 48, a developer can author `module.yaml` declaring migrations + Docker services + agent definitions + skill definitions as one bundle; the Pydantic schema validates the manifest; the resolver detects semver conflicts across a set of manifests before any install runs. This is the SUBSTRATE for Phase 49 (install/uninstall/upgrade CLI).

Out of scope: install/uninstall/upgrade execution (Phase 49), remote module registry server (v3.3+ DIST), cross-tenant isolation (PROJECT.md Out of Scope), LLM-driven module assembly. NO new dependency on a package manager — the resolver is pure Python over manifest files on disk.

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Manifest schema (Pydantic, mirroring Phase 43 `SkillFrontmatter`)

- **Canonical path:** `services/module_schema.py` exporting `ModuleManifest` Pydantic model. Mirrors the established `services/skill_schema.py` (Phase 43) + `services/step-orchestrator.py` (Phase 41) patterns. `_HAS_PYDANTIC` import-safety fallback mandatory.
- **Required fields (FROZEN, exact declaration order):**
  - `name: str` — module identifier (kebab-case, validated `^[a-z][a-z0-9-]*$`)
  - `version: str` — semver `MAJOR.MINOR.PATCH` (validated `^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$`)
  - `description: str` — one-line summary
  - `requires: dict[str, str]` — `{module_name: semver_range}` (e.g., `{"core": "^1.0.0"}`); empty dict if no deps
  - `migrations: list[str]` — paths (relative to module root) of SQL migration files to apply in order
  - `services: dict[str, dict]` — Docker service blocks (key=service name, value=compose-fragment-equivalent dict)
  - `agents: list[str]` — paths to agent .md or AGENT.yaml files this module ships
  - `skills: list[str]` — paths to SKILL.md files this module ships
- **Optional fields (deferred to Phase 49+ if needed):** `pre_install`, `post_install`, `pre_uninstall`, `homepage`, `license`. NOT in v3.2 scope.
- **Validation rules:**
  - All migration files referenced must exist on disk at validation time (FileNotFoundError surfaces as Pydantic ValidationError)
  - `requires` keys MUST NOT include the module's own `name` (self-dependency banned)
  - Empty `migrations`/`services`/`agents`/`skills` are valid (a module can be metadata-only)
  - At least ONE of `migrations`/`services`/`agents`/`skills` must be non-empty (a module that ships nothing is rejected)

### Area 2 — Semver resolver (pure Python, no external dep)

- **Resolver entry point:** `services/module_resolver.py` exporting `resolve(manifests: list[ModuleManifest]) -> ResolveResult`. Pure function, no I/O.
- **Semver subset implemented:** Caret (`^1.2.3` → `>=1.2.3, <2.0.0`), tilde (`~1.2.3` → `>=1.2.3, <1.3.0`), exact (`1.2.3`), wildcard major (`^1` → `>=1.0.0, <2.0.0`). NO pre-release ordering (`1.0.0-beta` < `1.0.0`) in v3.2 — pre-releases parse but ordering treats them as equal to release version. Sufficient for v3.2 scope.
- **`ResolveResult` shape (frozen):**
  ```python
  {
    "ok": bool,
    "install_order": list[str] | None,  # topologically sorted module names, or None on conflict
    "conflicts": list[{
      "module_a": str, "range_a": str,
      "module_b": str, "range_b": str,
      "requested_module": str,
    }],
    "missing": list[str],  # required modules absent from the input set
  }
  ```
- **Cycle detection:** if A requires B and B requires A → conflict report flags `cycle: true` in addition to `conflicts: []`. Resolver fails-closed.
- **Determinism:** identical input → identical output. Module ordering inside `install_order` is topological + alphabetical tiebreak.

### Area 3 — Validation CLI

- **Entry point:** `gsd-amauta module validate <manifest.yaml> [<manifest.yaml> ...]`. Implemented in `bin/cli.cjs` dispatcher OR new `get-shit-done/bin/gsd-tools.cjs` subcommand `module validate` (Phase 45 bearings pattern). Either is acceptable; the Node side shells out to Python helper that imports `module_schema.py` + `module_resolver.py`.
- **Exit codes (frozen):**
  - `0` — all manifests valid AND resolver returns `ok: true`
  - `1` — one or more manifests invalid (Pydantic ValidationError) OR resolver returns `ok: false`
  - `2` — file I/O error (missing manifest, unreadable YAML)
- **`--json` flag** emits the `ResolveResult` + per-manifest validation errors as a structured object. Default mode emits human-readable summary.

### Area 4 — On-disk module layout

- **Module root:** `modules/<name>/` (project-relative). The directory contains:
  - `module.yaml` — the manifest
  - Referenced migrations, agents, skills are EITHER:
    - Inside the module root (e.g., `modules/auth/migrations/001-init.sql`), OR
    - Reference existing project assets via project-relative paths (e.g., `migrations/014-agent-findings.sql`)
  - Both forms are valid; Phase 49 install logic handles each.
- **Discovery:** Phase 48 does NOT scan for modules. Validate/resolve operates on EXPLICIT manifest paths passed via CLI. Auto-discovery is Phase 49.

### Area 5 — Reuse from prior phases

- Phase 43 `services/skill_schema.py` — `_HAS_PYDANTIC` fallback pattern, declaration-order discipline (frontmatter order locked for grep verification)
- Phase 44 `services/infra_detect.py` — graceful-degradation pattern (skip with structured warn rather than crash)
- Phase 44 `bin/init.cjs` — `buildStepResult` schema; Phase 49 install will reuse, but Phase 48 doesn't need it
- Phase 45 `gsd-tools bearings` subcommand pattern — CLI shell-out to Python helper, `--json` mode
- Phase 47 `services/agent_hydrator.py` `_HAS_PG`/`_HAS_REDIS` import-safety — same shape for `module_schema.py` (`_HAS_PYDANTIC`, `_HAS_YAML`)

### Claude's Discretion

- Whether `module_schema.py` uses Pydantic v1 or v2 syntax (match existing project — check `skill_schema.py`)
- YAML library choice (PyYAML preferred — already in project deps; fallback minimal parser if absent like Phase 43 did)
- Exact semver regex (a tested vendored snippet is fine; do NOT pull in `semver` npm package unless trivially small)
- Whether the resolver uses Kahn's algorithm or DFS for topo sort (executor's choice; output is deterministic regardless)
- Test framework (pytest for Python, node --test for JS — matches established conventions)
- Whether `gsd-tools module validate` or `gsd-amauta module validate` is the CLI surface (recommend `gsd-tools` first, with `bin/cli.cjs` dispatching it through; matches Phase 45 + 47 pattern)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 48 requirement source
- `.planning/REQUIREMENTS.md` §"Module System" — MOD-01, MOD-02 verbatim
- `.planning/ROADMAP.md` §"Phase 48: Module System Foundation" — 4 success criteria
- `.planning/PROJECT.md` §"Current Milestone: v3.2 The Federation"

### Reuse targets (DO NOT reinvent)
- `services/skill_schema.py` (Phase 43) — Pydantic model + `_HAS_PYDANTIC` fallback + declaration-order discipline. Module schema mirrors this.
- `services/step-orchestrator.py` (Phase 41) — StepHandoff Pydantic + `_HAS_PYDANTIC` pattern; reference for validation error shape.
- `services/agent_hydrator.py` (Phase 47) — `_HAS_PG`/`_HAS_REDIS` import-safety reference for `_HAS_YAML` fallback in module_schema.py
- `get-shit-done/bin/gsd-tools.cjs` — subcommand dispatcher; Phase 48 adds `case 'module':` (matching `bearings`, `agent-hydrate`, `skills`, `phase` cases)
- `scripts/skill-compiler.cjs` (Phase 43) — semver-validation regex precedent at line 292; reuse same form

### Symmetric pattern (skill compiler ↔ module schema)
- Phase 43 SKILL.md frontmatter validation is the closest analog. Phase 48 module manifest validation follows the same pattern at a coarser grain (bundle of files vs. single file).

### Pydantic shape examples
- `services/skill_schema.py` `SkillFrontmatter` class (Phase 43) — exact pattern for `ModuleManifest`
- `services/step-orchestrator.py` `StepHandoff` class (Phase 41) — alternate pattern for nested fields

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/skill_schema.py` Pydantic class — copy structure for `ModuleManifest`
- `services/agent_hydrator.py` `_HAS_PG` fallback — mirror as `_HAS_YAML` + `_HAS_PYDANTIC`
- `get-shit-done/bin/gsd-tools.cjs` subcommand dispatcher — add `case 'module':`
- `bin/cli.cjs` top-level CLI — may add `module` shortcut (recommended) so `npx gsd-amauta module validate` works directly
- PyYAML is in the existing Python environment (services/amauta-daemon.py uses it)

### Established Patterns
- **Pydantic + `_HAS_PYDANTIC` fallback (Phase 41/43/47):** module_schema.py mandatory.
- **Subcommand dispatch in gsd-tools.cjs (Phase 45/47):** Phase 48 adds `module validate` here.
- **Frozen exit codes 0/1/2 (Phase 44/47):** Phase 48 uses 0=ok, 1=invalid/conflict, 2=I/O error.
- **`--json` mode parity (Phase 45/47):** structured output mirrors human-readable output content.
- **Filesystem-only registry (Phase 43 Area 8):** Phase 48 honors — no central module registry, just files on disk + explicit CLI args.
- **Test colocation:** Python tests in `tests/test_*.py`, JS tests in `tests/*.test.cjs` (Phase 42-47 convention).

### Integration Points
- Phase 49 consumes `services/module_resolver.py` `resolve()` to compute install order before executing migrations/services.
- Phase 52 (agent compilation) may emit module manifests referencing compiled agents — schema reuse downstream.
- Phase 53 (POLISH-02 installer upgrade/uninstall) may consume module_schema for migration introspection.

</code_context>

<specifics>
## Specific Ideas

- **`ModuleManifest` field declaration order is LOCKED** for grep-based downstream verification (mirrors Phase 43 SkillFrontmatter discipline): name, version, description, requires, migrations, services, agents, skills.
- **Semver caret/tilde/exact ONLY in v3.2.** Pre-release ordering deferred. Document this in module_schema.py docstring.
- **Resolver `ResolveResult` schema_version `"1.0"`** for forward-compat with Phase 49 consumer.
- **Two-module fixture for tests:** `tests/fixtures/modules/core-1.2.0/module.yaml` + `tests/fixtures/modules/feature-requires-core/module.yaml`. Tests assert both satisfiable and conflicting variants.
- **`gsd-tools module validate <path>` shell-out** mirrors Phase 45's `gsd-tools bearings` — Node side reads args + flags, Python helper does the heavy lift. Python entry: `services/module_validator_cli.py` with `if __name__ == "__main__":` block (Phase 47 agent_hydrate_cli.py pattern).

</specifics>

<deferred>
## Deferred Ideas

- **Install execution** — Phase 49 (`gsd-amauta module install/uninstall/upgrade`).
- **Module auto-discovery** — Phase 49.
- **Remote module registry** — v3.3+ (DIST family).
- **Pre-release semver ordering** — out of scope; revisit when needed.
- **Cross-tenant module isolation** — PROJECT.md Out of Scope.
- **Module signing / supply-chain provenance** — future security phase.
- **Hot-reload of modules without restart** — future operational phase.

</deferred>

---

*Phase: 48-module-system-foundation*
*Context gathered: 2026-05-13*
