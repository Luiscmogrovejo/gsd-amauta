# Phase 44: Cross-IDE Installer - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Evolve the existing `bin/init.cjs` (496 LOC, 5-step flow) into the 6-step Phase 44 contract: **detect IDEs → install skills → start infrastructure → run migrations → verify health → run assertions**. Add IDE auto-detection (currently requires manual `--claude`/`--opencode`), non-interactive CI mode (`--yes --tools <list>`), graceful degradation (no Docker = skills-only; no PG = SQLite fallback), legacy migration (`.claude/commands/` → `.claude/skills/` via timestamped backup-rename), a per-step structured result object, and a `platform-codes.yaml` registry that becomes the single source of truth for per-IDE directory names.

**Brownfield, not greenfield.** `bin/install.js` already handles 4 runtimes (claude / opencode / gemini / codex), `services/infra_detect.py` already cascades PG-local → Docker-PG → SQLite, `bin/cli.cjs` already dispatches `npx gsd-amauta init`. Phase 44 extends in place with zero breakage to existing flags.

Out of scope for this phase: upgrade/uninstall flows beyond what `install.js --uninstall` already does, user-global skill management beyond what `--global` already does, E2E containerized smoke tests (per-step unit tests + smoke is sufficient), detailed exit codes beyond 0/1, runtime IDE registry beyond `platform-codes.yaml`.

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Existing init.cjs treatment

**Approach: extend in place.** Keep `bin/init.cjs`'s current structure. Add a new IDE-detect step (step 1, before install), add the 6th assertions step (after verify), add `--yes` and `--tools <list>` flags, and add a legacy-migration call inside the install step. Smallest diff, lowest risk; existing flow already works end-to-end. Acceptable file growth past 700 LOC — splitting into modules deferred to a later phase if growth continues.

**Flag compatibility: additive, zero breakage.** Every existing flag (`--skip-install`, `--skip-daemon`, `--opencode`, `--claude`, `--backend`, `--force`, `--json`) keeps working unchanged. New flags:
- `--yes` — suppresses prompts, defaults to safe choices (skip-with-warn on ambiguity).
- `--tools <comma-list>` — overrides auto-detection (e.g., `--tools claude-code,cursor`). When `--tools` is given, `--claude`/`--opencode` are honored as legacy aliases with a single-line note ("`--claude` is treated as `--tools claude-code`"). No deprecation warnings in v3.1.

**Per-step result schema (returned by every step function):**
```js
{
  name: string,                    // e.g. 'detect_ides'
  status: 'pass' | 'fail' | 'skip' | 'warn',
  message: string,                 // human-readable summary
  duration_ms: number,
  details: object | null           // optional structured data (e.g., per-IDE detection table)
}
```
The orchestrator collects all step results into an array, prints a final summary table, and emits the array in `--json` mode. **Overall exit code semantics** (Area 3-locked): `0` unless at least one step has `status: 'fail'`, then `1`. Skip and warn do NOT affect the exit code. This satisfies INST-03's "CI exit codes are 0 (success) or 1 (failure), no interactive hangs."

**Test coverage: per-step unit tests + smoke.** Each step function is unit-tested in isolation with mocked filesystem (memfs or tmp dir), mocked `child_process.execFileSync` (for Docker/python3 calls), and mocked daemon HTTP. Plus one smoke test that runs init in `--skip-daemon --skip-install --backend sqlite` (dry-run-ish mode) and asserts the result-array schema. No Docker-in-Docker E2E this phase.

### Area 2 — IDE auto-detection signals

**Authoritative signal: filesystem directory presence.** Whichever of `.claude/`, `.cursor/`, `.opencode/` exist at the install root indicate the IDE is in use here. CLI on PATH and process-list checks are advisory boosts to confidence but do NOT block install when absent. Mirrors Phase 43's filesystem-only registry model and avoids the "CLI installed globally but never used in this project" false positive.

**Empty-directory false-positive guard.** A directory only counts as "detected" if it contains at least one expected child: any of the skill-subdir name (`skills/`, `rules/`, `commands/`), or any `*.md`/`*.json` file directly under it. An empty `.cursor/` left by an unrelated extension does NOT trigger Cursor install.

**Detection scope: project-local first, then $HOME.** Scan `./{.claude,.cursor,.opencode}/` in cwd. If none found, scan `~/{.claude,.cursor,.opencode}/`. Project install is the default target; global is the fallback. Matches existing `install.js --local/--global` pattern.

**Detection output: per-IDE table.** Every IDE the installer knows about gets one row in the summary:
```
| IDE         | Detected | Signals       | Action  |
|-------------|----------|---------------|---------|
| claude-code | yes      | dir+cli       | install |
| cursor      | no       | (none)        | skip    |
| opencode    | yes      | dir           | install |
```
Same table in `--json` mode as `details.detections[]`. INST-02's success criterion ("identifies at least 2 IDEs in a test environment with both present") is satisfied by this table being deterministic + auditable.

**`--tools <list>` override.** When `--tools` is provided, auto-detection still runs (for the table), but the install action is forced to match the list. Detected-but-not-listed → action: skip; listed-but-not-detected → action: install (creates the directory if needed). This is the explicit-opt-in path required for CI.

### Area 3 — Step contract: degradation, assertions, exit codes

**Degraded paths return `status: warn`, not `pass` or `fail`.** Specifically:
- No Docker AND no local PG → infrastructure step returns `warn`, message `"Docker unavailable — skills-only install (no daemon, no migrations)"`. Migrations and daemon-start steps that follow return `skip` with `requires_pg` reason.
- No PG but SQLite reachable → infrastructure step returns `warn`, message `"Using SQLite fallback at <path>"`. Migrations step still runs (SQLite-compatible migrations only). Daemon-start step still runs.
- Skills install completed but compiler emitted `manifest_skip` warnings (Phase 43 Area 2) → install step returns `warn` with details.

Overall exit code is still `0` for these cases (CI passes). The audit trail lives in `details` and the JSON output. Matches v2.5+ graceful-degradation pattern.

**The 6th "run assertions" step: post-install smoke.** After all prior steps complete, the assertions step runs 5 deterministic checks:
1. **Skill files present** — for each IDE in `Action: install` from the detection table, the expected skill subdir exists and contains at least one compiled `*.md` file.
2. **Compiler validates clean** — `node scripts/skill-compiler.cjs validate` exits 0 (Phase 43-locked subcommand).
3. **Daemon /health ok** — if daemon was started (not skipped), `GET /health` returns 200 with `status: ok`. Skipped step in degraded-mode runs.
4. **Schema applied** — at least one migration row exists in the `migrations` table (PG) OR the SQLite schema file exists at the fallback path. `requires_pg` skip applies in skills-only mode.
5. **Semgrep rule file present** — `.semgrep/skill-enforcement.yml` exists with 3 rules (Phase 43-03 contract). Does NOT run Semgrep here (binary may be absent — that's Phase 43-03's pre-commit/CI concern, not installer concern).

Each assertion produces one entry in `details.assertions[]` with `name`, `status`, `message`. Step status = worst-of-assertions (fail beats warn beats pass; skip doesn't count). Reuses Phase 43's `gsd-skills validate` rather than reimplementing.

**Exit-code aggregation: 0 / 1 only.** `failOverall = results.some(r => r.status === 'fail')`. `exitCode = failOverall ? 1 : 0`. Skips and warns are visible in the table but don't fail CI. Matches INST-03 verbatim. The information density loss vs detailed exit codes is recovered via `--json`.

**`--yes` on ambiguity: skip with warn, never destructive.** When `--yes` is set and an ambiguous condition arises (e.g., both `.claude/commands/` AND `.claude/skills/` exist — legacy migration target collision; or `.claude/` exists but no skill subdir matches Phase 43 output), the relevant step returns `status: warn` with a specific message and an override-flag hint (e.g., `"pass --force-migrate to override"`). Never silently overwrites or deletes; never auto-applies a destructive default just to keep CI green.

### Area 4 — Legacy migration + platform-codes.yaml

**Migration mechanism: atomic timestamped backup-rename.**
```
mv .claude/commands/ .claude/commands.bak.<ISO8601-compact>/
```
Where `<ISO8601-compact>` = `YYYY-MM-DDTHH-MM-SS` (colons replaced with dashes for filesystem safety). After the rename, the new `.claude/skills/` is populated fresh from `gsd-skills compile --target=claude-code`. The user can recover original content from `.claude/commands.bak.*` indefinitely. No file-by-file name mapping is attempted — the canonical SKILL.md files in `get-shit-done/skills/<name>/` ARE the new authoritative source, and the compiler produces them; the old `commands/` files were drafts.

**Idempotency: filesystem scan, no state file.** The migration step is a pure scanner:
- `.claude/commands/` missing or empty → `status: skip`, message `"no legacy commands directory"`.
- `.claude/commands/` present AND `.claude/skills/` also present (collision) → with `--yes`: `status: warn`, message `"both legacy commands/ and skills/ present — skipped migration; pass --force-migrate to override"`. Without `--yes`: prompt the user.
- `.claude/commands/` present AND `.claude/skills/` absent → migrate (rename + compile-and-install).
- Future runs see the rename completed → `status: skip`. The filesystem is the source of truth; no `.planning/migrations-applied.json` needed.

This is the simplest correct design for v3.1 — adding a state file is premature.

**`platform-codes.yaml` location: `get-shit-done/references/platform-codes.yaml`.** Matches the Phase 43-03 precedent of placing externalized config in `references/` (alongside `mutation_verbs.txt`). Single source of truth — both the installer (`bin/init.cjs`) and the Phase 43 compiler (`scripts/skill-compiler.cjs`) read this file. The compiler's existing `TARGET_MAPS` is **updated in this phase** to read `dir_name` and `skill_subdir` from the yaml, while keeping the per-IDE frontmatter/tool alias tables (e.g., `Read` → `read_file` for Cursor) in code where they belong. Two consumers, one config; no drift.

**`platform-codes.yaml` schema (minimal but complete):**
```yaml
ides:
  claude-code:
    ide_id: claude-code            # canonical name (used in --tools list)
    dir_name: .claude              # filesystem directory at install root
    skill_subdir: skills           # subdir under dir_name where skills land
    cli_name: claude               # binary name for PATH lookup (advisory signal)
  cursor:
    ide_id: cursor
    dir_name: .cursor
    skill_subdir: rules            # Cursor uses rules/, not skills/
    cli_name: cursor
  opencode:
    ide_id: opencode
    dir_name: .opencode
    skill_subdir: skills
    cli_name: opencode
```

Exactly 4 fields per IDE. Optional fields (e.g., `min_version`, frontmatter aliases, dependency list) explicitly deferred — would couple installer config to compiler-internal aliasing and add validation surface that earns its keep only when there's a second alias variant to add.

The `claude-code` `ide_id` (with the `-code` suffix) disambiguates from `.claude/` directories belonging to other Anthropic products; the `--tools claude-code` form is what INST-03 specifies.

### Claude's Discretion

- Exact yaml-parser choice in `bin/init.cjs` (probably `js-yaml` already in package.json — confirm during execution; if not, hand-roll a minimal parser like Phase 43's `_HAS_YAML` fallback in `services/skill_schema.py`).
- Step ordering when `--tools` restricts the install set (e.g., only `--tools claude-code` → cursor and opencode rows still appear in the table with `Action: skip`; install step skips them; the rest of the flow is unchanged).
- Retry policy on transient daemon startup failures (existing `bin/init.cjs` already has a polling loop — keep it).
- Where the per-step result array is rendered as a human-readable table (probably reuse the colored-output helpers already at the top of `bin/init.cjs`).
- How to surface `--force-migrate` and `--force` interaction (one consolidated `--force` that bypasses all skip-with-warn guards, or per-guard flags — executor's call, but document in `--help`).
- Whether step 1 (detect_ides) populates an internal var that step 2 (install_skills) consumes, or whether install_skills re-runs detection. Single-pass is preferred but the existing install.js architecture may dictate otherwise.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 44 requirement source
- `.planning/REQUIREMENTS.md` §"Cross-IDE Installer" — INST-01..INST-04 verbatim
- `.planning/ROADMAP.md` §"Phase 44: Cross-IDE Installer" — phase goal, 4 success criteria, dependency on Phase 43
- `.planning/PROJECT.md` — v3.1 "The Gathering" portability constraint (no K3s/gVisor/API-key graders)

### Existing installer surface (BROWNFIELD — modify in place, don't replace)
- `bin/cli.cjs` — `npx gsd-amauta` dispatcher; routes `init` to `bin/init.cjs`
- `bin/init.cjs` — existing 496-LOC installer with 5 steps (install / detect-infra / migrations / daemon / verify). Phase 44 evolves this file.
- `bin/install.js` — existing 4-runtime installer (claude / opencode / gemini / codex), `--local/--global/--uninstall`, `--all/--both`. Phase 44's install step delegates here (existing pattern preserved).
- `services/infra_detect.py` — existing PG-local → Docker-PG → SQLite cascade with `--auto-start`. Phase 44 keeps this for the infrastructure step.

### Phase 43 outputs (Phase 44 wraps these)
- `.planning/phases/43-skills-architecture/43-CONTEXT.md` §Area 2 — one-way compilation, per-IDE alias tables, VCS policy (compile outputs gitignored), `gsd-skills compile --target=<ide>` is the manual command Phase 44 automates
- `.planning/phases/43-skills-architecture/43-CONTEXT.md` §Area 7 — Phase 43/44 boundary rule: 43 ships standalone, 44 wraps the compile flow
- `.planning/phases/43-skills-architecture/43-CONTEXT.md` §Area 8 — filesystem-only registry (no `skills-index.json`)
- `scripts/skill-compiler.cjs` — Phase 43 compiler with `TARGET_MAPS` for claude / opencode / cursor. Phase 44 UPDATES this to read `dir_name`/`skill_subdir` from `platform-codes.yaml`; per-IDE frontmatter/tool alias tables stay in code.
- `get-shit-done/skills/{plan-phase,execute-phase,discuss-phase}/SKILL.md` — canonical sources that compile to IDE-specific files at install time
- `.semgrep/skill-enforcement.yml` — Phase 43-03 enforcement rules; assertions step verifies this file exists (does NOT run Semgrep — binary may be absent)
- `get-shit-done/references/mutation_verbs.txt` — Phase 43-03 precedent for placing externalized config under `references/` (analogous to where `platform-codes.yaml` will live)

### Established patterns (v2.5+ — reuse, don't reinvent)
- `services/amauta-daemon.py` — daemon HTTP surface; existing `/health` endpoint is what assertion 3 hits
- `migrations/` directory + `migrations` table — schema-versioning pattern; assertion 4 reads from here in PG mode
- Graceful-degradation pattern across the v2.5+ test suite — tests skip with clear message when infra absent (see `tests/skill-invocation-store.test.cjs` ECONNREFUSED handling for the canonical example)

### Existing prototype/draft material to migrate
- `.claude/commands/` (when present in user projects) — legacy command files that the migration step backup-renames to `.claude/commands.bak.<timestamp>/`
- `.opencode/` (this repo, untracked) — prototype directories; the compiler's idempotent install rewrites these through the canonical path
- `commands/` (top-level, this repo) — pre-Phase-43 command files; NOT in the legacy-migration scope (different from the `.claude/commands/` user-facing case)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `bin/init.cjs` — HTTP helpers (`httpGet`, `isDaemonRunning`), colored output constants, `stepInstall` / `stepDetectInfra` / step orchestration. Phase 44 reuses all of these and adds two new step functions (`stepDetectIdes`, `stepAssertions`) plus a structured result aggregator.
- `bin/install.js` — runtime selection logic (`getDirName`, `selectedRuntimes`), `--local/--global` resolution. Phase 44's install step delegates here; the new detection table is built ABOVE this layer in `bin/init.cjs`.
- `services/infra_detect.py` — `detect_infrastructure(auto_start=True)` returns `{backend, connection_url, features, message}`. Phase 44 keeps this as-is; the structured per-step result wraps its output.
- Phase 43 `scripts/skill-compiler.cjs` — `compile(target, opts)`, `validate(skillDir)`, `listSkills(source)`. Phase 44's install step invokes `compile` for each IDE in the install action list.
- Phase 43 `services/skill_schema.py` — Pydantic `SkillFrontmatter` model. Not directly consumed by the installer, but the install step relies on the compiler having validated frontmatter upstream.

### Established Patterns
- **Per-step structured results** — pattern is new in Phase 44 but mirrors Phase 42's task-completions metadata schema (`status`, `outcome_class`, `message`).
- **Filesystem-only registry** — Phase 43 Area 8. Phase 44 honors this: detection scans dirs, no `installed-ides.json` registry file.
- **Graceful-degradation cascades** — Phase 42 SCALE-02 score → phase set, Phase 43 Area 4 semgrep-missing = warn-only. Same shape: missing optional infra → degraded mode + warn, never fail.
- **YAML-as-config in references/** — Phase 43-03 `mutation_verbs.txt` set the precedent. `platform-codes.yaml` follows.
- **One-way data flow** — Phase 43 Area 2 (canonical → IDE, never bidirectional). Phase 44 install step: canonical SKILL.md → IDE skill subdir, never reads back.

### Integration Points
- **CLI dispatch:** `bin/cli.cjs` already routes `init` to `bin/init.cjs`. No change.
- **Compiler ← installer:** Phase 44's install step shells out to `node scripts/skill-compiler.cjs compile --target=<ide_id> --out=<computed-from-platform-codes-yaml>` for each IDE.
- **Compiler ↔ platform-codes.yaml:** Phase 44 updates `scripts/skill-compiler.cjs` to load `dir_name` + `skill_subdir` from the yaml at startup. Per-IDE frontmatter/tool alias tables stay hard-coded in `TARGET_MAPS`.
- **Legacy migration ← installer:** New helper inside `bin/init.cjs` (or extracted to `bin/init/legacy-migration.cjs` if file growth warrants — executor's call). Called from the install step BEFORE compiler runs.
- **Daemon assertions:** Assertion 3 hits the existing `/health` endpoint via `httpGet` already imported in `bin/init.cjs`. Assertion 4 reads `migrations` table via the existing daemon HTTP surface OR direct PG query (executor's call — daemon HTTP is preferred for portability).

</code_context>

<specifics>
## Specific Ideas

- **Timestamp format for legacy backup:** `YYYY-MM-DDTHH-MM-SS` (colons replaced with dashes). Filesystem-safe across macOS/Linux/Windows. ISO-8601-compatible enough that `ls -la` sorts chronologically. Generate with `new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)`.
- **Per-step result schema (frozen):** `{ name: string, status: 'pass'|'fail'|'skip'|'warn', message: string, duration_ms: number, details?: object }`. Same schema across all 6 steps. JSON-stable.
- **Per-IDE detection table columns (frozen):** `IDE | Detected | Signals | Action`. `Signals` is a `+`-joined short list (e.g., `dir+cli`, `dir`, `(none)`). `Action` is one of `install | skip`.
- **5 assertions (frozen):** `skill_files_present`, `compiler_validates`, `daemon_health`, `schema_applied`, `semgrep_rules_present`. Step status = worst of these 5.
- **Exit code rule (frozen):** `exitCode = results.some(r => r.status === 'fail') ? 1 : 0`. Nothing else.
- **`platform-codes.yaml` field count:** exactly 4 per IDE — `ide_id`, `dir_name`, `skill_subdir`, `cli_name`. Additional fields are an explicit Phase 44.x scope expansion, not a creeping addition.

</specifics>

<deferred>
## Deferred Ideas

Out of scope for Phase 44 — captured so they're not lost:

- **Upgrade/uninstall beyond `install.js --uninstall`** — full version-aware upgrade with conflict resolution (e.g., user-modified skill detection, three-way merge) is a separate phase. Phase 43-CONTEXT.md flagged this; INST-01..04 don't require it, so it stays deferred.
- **Detailed exit codes (2, 3, …)** — INST-03 explicitly mandates 0/1 only. Skipped per spec.
- **E2E Docker-in-Docker smoke test** — slowest, flakiest tier; per-step unit tests + smoke is sufficient for v3.1.
- **Bidirectional IDE → canonical sync** — Phase 43 rejected this; Phase 44 inherits the rejection.
- **User-modified skill detection at install time** — interesting telemetry (Was this skill edited locally? Do we overwrite?) but not in INST-* scope. Plan for HYDRA or a later phase.
- **Auto-discovery of new IDE runtimes from filesystem** — INST-02 enumerates 3 IDEs. Adding a 4th in v3.1 is configuration-only (extend `platform-codes.yaml`); programmatic discovery beyond the known list is deferred.
- **`platform-codes.yaml` field expansion** — `min_version`, frontmatter alias overrides, dependency declarations. Premature; revisit when a concrete second consumer needs them.
- **Migration state file (`.planning/migrations-applied.json`)** — filesystem-scan idempotency is sufficient. Re-evaluate only if a destructive-by-default migration ever joins the flow.
- **CLI tool detection beyond `which`** — `process` list inspection (e.g., scanning for running `claude-code` processes) is INST-02 spec text but treated as advisory in this phase; if filesystem dir presence + CLI-on-PATH proves insufficient in practice, deepen the process-list integration in a follow-up.
- **Web installer / one-line curl-pipe** — npm/npx is the v3.1 distribution channel. A `curl install.sh | bash` flow is a packaging concern for later.

</deferred>

---

*Phase: 44-cross-ide-installer*
*Context gathered: 2026-05-12*
