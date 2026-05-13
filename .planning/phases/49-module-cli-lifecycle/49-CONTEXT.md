# Phase 49: Module CLI + Lifecycle - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 49 + REQUIREMENTS.md (MOD-03..04) + Phase 44/48 patterns

<domain>
## Phase Boundary

Build the operator surface for module lifecycle: `gsd-amauta module install <name>`, `module uninstall <name>`, `module upgrade <name>` with idempotency, `--dry-run` preview, automatic rollback on partial failure, and expand-and-contract migration preservation across upgrades. Consumes Phase 48's `ModuleManifest` schema + `resolve()` resolver.

Out of scope: remote module registry (v3.3+ DIST), cross-tenant isolation, web UI, transitive auto-resolve of missing dependencies (fails-closed when `requires:` modules are absent from explicit `--modules` set).

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Brownfield: extend Phase 48's CLI

- Extend `get-shit-done/bin/gsd-tools.cjs` `case 'module':` in place. Phase 48 added `validate`. Phase 49 adds `install`, `uninstall`, `upgrade`. Same `args[1]` action / `args.slice(2)` rest indexing (Phase 48 Issue 1 fix preserved).
- Python heavy lift in new `services/module_lifecycle.py` exporting `install()`, `uninstall()`, `upgrade()`. Returns structured `LifecycleResult` dict. I/O via injectable hooks for testability.

### Area 2 — FROZEN `LifecycleResult` schema

```python
{
  "schema_version": "1.0",
  "operation": "install" | "uninstall" | "upgrade",
  "module": str,
  "module_version": str,
  "status": "pass" | "fail" | "skip" | "warn",   # worst-of all steps
  "steps": [
    {"name": str, "status": str, "message": str, "duration_ms": int, "details": dict | None},
    ...
  ],
  "rollback": {"triggered_by_step": str, "undo_actions": list[str]} | None,
  "dry_run": bool
}
```

Worst-of-status: `fail > warn > pass > skip` (skip never counts). Mirrors Phase 44.

### Area 3 — FROZEN step name vocabulary

**install (7):** `validate_manifest`, `resolve_dependencies`, `apply_migrations`, `register_services`, `copy_agents`, `copy_skills`, `post_install_verify`

**uninstall (7):** `read_install_record`, `remove_skills`, `remove_agents`, `unregister_services`, `revert_migrations`, `clear_install_record`, `post_uninstall_verify`

**upgrade (8):** `validate_new_manifest`, `read_install_record`, `compute_migration_delta`, `apply_expand_migrations`, `swap_services`, `apply_contract_migrations`, `update_install_record`, `post_upgrade_verify`

Tests + Phase 53 POLISH-02 reference these by exact string.

### Area 4 — Idempotency (FROZEN)

- install of already-installed (same version) → per-step `skip`, overall `skip`, exit 0
- uninstall of absent module → per-step `skip`, overall `skip`, exit 0
- upgrade where target_version == installed_version → overall `skip`; `--force` re-runs as install

Same-state-in → same-state-out, regardless of invocation count.

### Area 5 — Install record persistence

New migration `022-module-installs.sql`:

```sql
CREATE TABLE module_installs (
  module_name VARCHAR(64) PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  manifest_hash CHAR(64) NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  upgraded_at TIMESTAMPTZ,
  applied_migrations TEXT[] NOT NULL DEFAULT '{}',
  registered_services TEXT[] NOT NULL DEFAULT '{}',
  installed_agents TEXT[] NOT NULL DEFAULT '{}',
  installed_skills TEXT[] NOT NULL DEFAULT '{}'
);
```

DOWN file drops the table. SQLite fallback: `~/.amauta/data/module_installs.json` (Phase 44 cascade applies).

### Area 6 — Rollback model

When any install/upgrade step returns `fail`, lifecycle engine runs inverse of each preceding `pass` step in reverse order:
- Each undo is a separate `steps[]` entry with `name` prefixed `rollback_<step>` (e.g., `rollback_apply_migrations`)
- `rollback.triggered_by_step` records failing step; `rollback.undo_actions` lists what was reversed
- Undo failure → status stays `fail`, rollback step marked `fail` + `partial_rollback` warning; exit code 2 (operator action required)
- Dry-run failures do NOT trigger rollback (read-only)

Mirrors Phase 36 expand-and-contract + Phase 44 per-step schema.

### Area 7 — Dry-run contract

`--dry-run` flag sets `LifecycleResult.dry_run = true` and:
- State-modifying steps return `status: "skip"` with `details: {would_apply: <description>}`
- Manifest validation, dependency resolution, manifest hashing still execute (read-only)
- Exit 0 unless validation/resolution itself fails (then Phase 48 codes 1/2)
- `--json` emits LifecycleResult JSON verbatim; default = human summary with explicit `would_apply:` blocks

### Area 8 — Upgrade: expand-and-contract (Phase 36 reuse)

1. Compute migration delta (set difference of `manifest.migrations` arrays)
2. Apply expand migrations first (additive)
3. Swap services (docker compose for changed services only)
4. Apply contract migrations last (destructive)
5. Update install record (new version + hash + applied_migrations)

Convention: `NNN-name-expand.sql` / `NNN-name-contract.sql`. Executor confirms naming matches Phase 36.

### Area 9 — CLI surface

```
node get-shit-done/bin/gsd-tools.cjs module install <manifest.yaml> [--dry-run] [--json] [--force]
node get-shit-done/bin/gsd-tools.cjs module uninstall <module-name> [--dry-run] [--json]
node get-shit-done/bin/gsd-tools.cjs module upgrade <new-manifest.yaml> [--dry-run] [--json] [--force]
```

`npx gsd-amauta module ...` via `bin/cli.cjs` shortcut.

Exit codes (FROZEN, mirrors Phase 48):
- 0 = success (including idempotent skip)
- 1 = lifecycle failed AND rollback completed cleanly
- 2 = file I/O error OR partial rollback (operator action required)

### Claude's Discretion

- sync vs asyncio (recommend sync — simpler at this scale)
- `manifest_hash` over raw bytes or canonicalized YAML (recommend canonicalized: `yaml.safe_dump(yaml.safe_load(content), sort_keys=True).encode()`)
- Docker service registration mechanism (recommend `docker compose -f <generated>.yml up -d <service>` for portability)
- `--force` vs `--force-reinstall` flag name (executor's call; document in --help)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 49 requirement source
- `.planning/REQUIREMENTS.md` §"Module System" — MOD-03, MOD-04
- `.planning/ROADMAP.md` §"Phase 49: Module CLI + Lifecycle" — 4 success criteria
- `.planning/PROJECT.md` §"Current Milestone: v3.2 The Federation"

### Phase 48 consumer surface (REUSE)
- `services/module_schema.py` `ModuleManifest` + `load_module_manifest()`
- `services/module_resolver.py` `resolve()`
- `services/module_validator_cli.py` — argparse + exit-code mapping precedent
- `get-shit-done/bin/gsd-tools.cjs` `case 'module':` — extend with 3 new actions; args[1]/slice(2) indexing locked
- `tests/fixtures/modules/{core-1.2.0,feature-requires-core,feature-wants-core-v2}/module.yaml` — reuse for lifecycle tests

### Phase 44 inheritance (per-step result + degradation)
- `bin/init.cjs` `buildStepResult(name, status, message, duration_ms, details)` — Phase 49 mirrors verbatim
- Worst-of-status combinator — copy from Phase 44

### Phase 36 inheritance (expand-and-contract)
- `agents/gsd-executor-data.md` — migration discipline; Phase 49 upgrade reuses

### Phase 44 SQLite fallback
- `services/infra_detect.py` cascade — Phase 49 honors `backend: sqlite`; install record falls back to JSON file

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 48 `module_schema.py` + `module_resolver.py` + `module_validator_cli.py`
- Phase 44 `bin/init.cjs` step orchestrator + buildStepResult + worst-of combinator
- Phase 44 `infra_detect.py` PG/SQLite cascade
- Phase 36 expand-and-contract migration patterns
- Phase 47 `services/agent_hydrate_cli.py` argparse + `if __name__ == "__main__":` pattern

### Established Patterns
- Per-step result schema (Phase 44/47/48)
- Frozen schema_version "1.0" (Phase 45/47/48)
- Worst-of-status combinator (Phase 44/47)
- Idempotency via PG record + filesystem fallback (Phase 44 migration 020 + Phase 47)
- Rollback discipline (Phase 36 + Phase 41 StepHandoff)
- `--json` mode (Phase 45/47/48)
- CLI subcommand extension via `case '<name>':` (Phase 45/47/48)

### Integration Points
- `bin/cli.cjs` — top-level `npx gsd-amauta module ...`
- `get-shit-done/bin/gsd-tools.cjs` `case 'module':` — 3 new actions
- `migrations/022-module-installs.sql` + DOWN — new PG migration
- `services/module_lifecycle.py` — new Python module
- `services/module_lifecycle_cli.py` — new CLI entry (or merge into existing module_validator_cli.py)

</code_context>

<specifics>
## Specific Ideas

- `manifest_hash` = SHA-256 of canonicalized YAML
- Step vocabulary FROZEN: 7 install + 7 uninstall + 8 upgrade = 22 names; grep-verified in tests
- Rollback prefix: `rollback_<step_name>`
- Migration 022: `module_installs` table (8 cols per Area 5)
- Filesystem fallback: `~/.amauta/data/module_installs.json` (PG row schema mirrored)
- Suggested 4-5 plan structure: 49-01 lifecycle engine + migration 022, 49-02 install action + tests, 49-03 uninstall + tests, 49-04 upgrade + tests, 49-05 CLI dispatch + E2E. Adjust if smaller split works.

</specifics>

<deferred>
## Deferred Ideas

- Transitive auto-resolve of missing requires → fails-closed; revisit if installer adoption demands
- Remote module registry → v3.3+
- Concurrent install of multiple modules → serial only
- Module version history retention → only current install record kept
- Pre/post hooks (pre_install, post_install scripts) → still deferred per Phase 48
- Module signing / supply-chain provenance → future security phase

</deferred>

---

*Phase: 49-module-cli-lifecycle*
*Context gathered: 2026-05-13*
