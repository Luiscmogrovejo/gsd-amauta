# Phase 19: Dynamic Ledger Schema — Context

**Gathered:** 2026-04-12
**Status:** Ready for planning
**Milestone:** v2.7 "Steady Hands"
**Phase ID:** 19-dynamic-ledger-schema
**Requirements:** SCHEMA-01
**Scope ceiling:** ~40 LOC. One new function (`scanDogfoodLedgerDepths()`) in `scripts/verify-v26.cjs` plus its tests. The filesystem scan pattern is already used elsewhere in the script.

<domain>
## Phase Boundary

Phase 19 replaces the static `dogfood_ledger_depths_captured: [0, 1, 2, 4, 5, 6, 7]` and `dogfood_ledger_gaps: [3]` in `buildReport()` with a runtime scan that produces the correct depth set at each audit run. Two data sources are combined: the v2.6 dogfood ledger (structured table, depths 0-9) and the memory directory (depths 10+). Gap identification is automatic via set difference.

Explicitly **out of scope:**
- Amending memory files with explicit `depth: N` YAML frontmatter (useful but a separate cleanup task — v2.8 backlog)
- Creating a v2.7 dogfood ledger file (that's a v2.7 closeout task, not Phase 19)
- Modifying the dogfood ledger file content (only reading it)
- Any refactor of `verify-v26.cjs` internal structure "while in there" — same Phase 13 fingerprint
- Changing `assessDogfood01()` or any other audit criterion — Phase 19 only touches the depth/gap fields
- Fixing the `cmdInitPhaseOp` residual ghost (Phase 16 gap, not Phase 19)

</domain>

<decisions>
## Implementation Decisions

### GA1 — Data Source Strategy: Ledger-Primary + Memory-Secondary Union

- **Locked:** `scanDogfoodLedgerDepths()` combines two sources into a single depth set:

  **Source 1 (primary): Parse `docs/v2.6-dogfood-ledger.md` table.**
  The ledger has a structured Markdown table with rows like `| 0 | 13.1 Wave 1 | ... |`. The parser:
  1. Reads the ledger file
  2. Matches rows with pattern `/^\|\s*(\d+)\s*\|/` to extract depth numbers
  3. Identifies "Not yet observed" rows (depth 3 has `| — |` in the Phase column or "Not yet observed" in the Outcome) — these are GAP entries, not captured depths
  4. Returns a Set of captured depth integers

  **Source 2 (secondary): Scan memory directory for v2.7+ depth files.**
  The ledger only covers v2.6 (depths 0-9). Depths 10+ exist only in memory files. The scanner:
  1. Globs `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_*dogfood*.md` plus `project_*_dogfood*.md` (to catch filenames without "dogfood" — though currently only depth 2 is missed, and it's covered by the ledger anyway)
  2. For each file, reads the YAML frontmatter `description:` field and body first heading
  3. Matches `/[Dd]epth[-:\s]+(\d+)/` to extract depth number
  4. Returns a Set of depth integers found

  **Union:** Merge both Sets. Sort. Compute gaps as `{0..max} \ union`.

  **Why ledger-primary:**
  - The ledger is the published, human-readable record. It already normalizes all depth numbers into a structured table. No free-text parsing needed.
  - The memory glob `project_*dogfood*.md` misses depth 2 (`project_phase13_1_wave3_near_miss.md` — no "dogfood" in filename). The ledger catches it.
  - Depth 3's "Not yet observed" status is explicit in the ledger table — the scanner can represent it as intentionally absent rather than a parsing bug.
  - For depths 0-9, the ledger is authoritative. Memory files are a cross-check only.

  **Why memory-secondary:**
  - v2.7 depths (10, 11) are NOT in the v2.6 ledger. They exist only in memory files with the newer consistent "Depth N" annotation format.
  - As future milestones add depths, they'll appear in memory before being published to a ledger. The memory scan provides forward-looking coverage.

  **Cross-check (advisory, not blocking):** Count of memory files matching the glob should be >= count of ledger depths. If memory count < ledger count, log a `ledger_memory_mismatch` advisory observation — it means a memory entry is missing or doesn't match the glob. This is informational, not a scan failure.

### GA2 — Depth Extraction Regex: Ledger Table Row Primary, Memory "Depth N" Secondary

- **Ledger table regex:** `/^\|\s*(\d+)\s*\|/` — matches `| 0 |`, `| 7 |`, `| 13 |` at the start of a table row. Simple, deterministic, no ambiguity.
- **Gap detection regex:** Rows where the Phase column is `—` or Outcome contains "Not yet observed" → mark as gap, not captured depth.
- **Memory depth regex:** `/[Dd]epth[-:\s]+(\d+)/` — matches "Depth 7", "Depth-6", "Depth 11", "depth: 10". This handles all memory entries from depth 5 onward (which use the consistent "Depth N" format). Depths 0-4 have inconsistent annotations ("First-invocation", "recursion depth one", "Fourth") but are already covered by the ledger — the memory regex doesn't need to catch them.
- **No ordinal parsing.** "Fourth", "recursion depth one", etc. are NOT parsed. They're v2.6 historical artifacts that the ledger covers. If a future depth entry uses ordinal prose without a "Depth N" annotation, it will be missed by the memory scan — but by then, a new ledger file should exist with a structured table.

### GA3 — Degradation Fallback List: Updated to Current State

- **Locked:** When the memory directory is unreachable AND the ledger file is also unreachable, fall back to `[0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]` with `gaps: [3]`.
- **Rationale:** The entire premise of Phase 19 is dynamic detection. The static fallback should be the best-known static snapshot, not a Wave-1 artifact. Keeping `[0, 1, 2, 4, 5, 6, 7]` actively contradicts the phase goal — if both sources fail, you want depths 8-11 in the fallback because they exist.
- **No backward compat argument holds** since the fallback is only reached on service failure. Downstream consumers of the field see a more complete picture even in the degraded case.
- **Degradation observation:** `ledger_scan_degraded: both_sources_unavailable` logged in audit report. Include the fallback list explicitly in the observation so a human reader knows the field values come from a static snapshot, not a live scan.

### GA4 — Degradation Cascade (three-tier)

When sources are partially available:

| Ledger available | Memory available | Behavior |
|---|---|---|
| Yes | Yes | Full union of both sources. Primary path. |
| Yes | No | Ledger depths only (0-9). Log `ledger_scan_degraded: memory_unavailable`. v2.7+ depths missed. |
| No | Yes | Memory depths only. Log `ledger_scan_degraded: ledger_unavailable`. Depths 0-4 depend on inconsistent annotations — some will be missed. |
| No | No | Static fallback `[0,1,2,4,5,6,7,8,9,10,11]`. Log `ledger_scan_degraded: both_sources_unavailable`. |

### Schema version bump

- **Locked:** Bump `schema_version` from 3 to 4. Phase 17 set it to 2, Phase 18 to 3, Phase 19 to 4.
- **The `dogfood_ledger_depths_captured` field name is UNCHANGED** — same key, same array-of-integers type, just dynamically populated instead of static.
- **The `dogfood_ledger_gaps` field name is UNCHANGED** — same key, same array-of-integers type, just dynamically computed via set difference instead of static.

### generateMarkdown update

- **The existing Dogfood Ledger Status section** (lines 860-864 in `generateMarkdown()`) already renders `dogfood_ledger_depths_captured` and `dogfood_ledger_gaps`. No structural change needed to the renderer — just verify the dynamic values display correctly.
- **Add a single line** noting the scan source: `Scan source: [ledger + memory | ledger only | memory only | static fallback]`.

### Claude's Discretion

- Exact function signature and parameter list for `scanDogfoodLedgerDepths()`
- Whether the memory directory path is passed as a parameter or computed from `process.env.HOME` + the known project path
- Whether the ledger and memory scan happen sequentially or via a helper per source
- Test fixture design: inline strings for ledger table parsing, temp dirs for memory scan, or both
- Exact wording of degradation observations

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirement definitions
- `.planning/REQUIREMENTS.md` § "SCHEMA-01" (line 67) — full requirement text with all four test cases
- `.planning/ROADMAP.md` § "Phase 19: Dynamic Ledger Schema" — goal, success criteria, rollback plan

### The audit script
- `scripts/verify-v26.cjs` line 712-713 — the static `dogfood_ledger_depths_captured: [0, 1, 2, 4, 5, 6, 7]` and `dogfood_ledger_gaps: [3]` that Phase 19 replaces
- `scripts/verify-v26.cjs` § `buildReport` — where the depth/gap fields live
- `scripts/verify-v26.cjs` § `generateMarkdown` lines 860-864 — the existing Dogfood Ledger Status renderer

### Data sources
- `docs/v2.6-dogfood-ledger.md` lines 38-49 — the structured depth table (10 rows, depths 0-9, with depth 3 marked "Not yet observed")
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_*dogfood*.md` — memory files for depths 5-11 (10 files, but depth 2 has no "dogfood" in filename)
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_phase13_1_wave3_near_miss.md` — depth 2 specifically (no "dogfood" in filename, caught by ledger parse instead)

### Prior phase patterns
- `.planning/milestones/v2.7-phases/18-sampling-pool-expansion/18-CONTEXT.md` — Phase 18's graceful degradation pattern (daemon_available / fallback_used / limitations_observed) is the direct precedent for Phase 19's three-tier degradation cascade
- `.planning/milestones/v2.7-phases/17-audit-script-hardening/17-CONTEXT.md` — schema version bump pattern (Phase 17: 1→2, Phase 18: 2→3, Phase 19: 3→4)

### Divergence protocol
- `get-shit-done/references/divergence-protocol.md` v1.1.0 — Phase 13 fingerprint protection

### Test patterns
- `tests/17-audit-script-hardening.test.cjs` — inline fixture precedent for `buildReport` mock testing
- `tests/18-sampling-pool.test.cjs` — `spawnSync` hijack pattern (if needed for the scanner)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`buildReport()` return object (line 712-713):** Currently has `dogfood_ledger_depths_captured: [0, 1, 2, 4, 5, 6, 7]` and `dogfood_ledger_gaps: [3]` as static values. Phase 19 replaces these with the `scanDogfoodLedgerDepths()` result.
- **`generateMarkdown()` ledger section (lines 860-864):** Already renders the depths and gaps as bullet points. Only addition: a "Scan source:" line.
- **`schema_version` field pattern:** Phase 17 added it, Phase 18 bumped it. Phase 19 bumps again (3 → 4).
- **`fs.readFileSync` + `path.join` patterns:** Used throughout the script for file reading. No new dependencies needed.
- **`module.exports` at bottom of file:** Phase 17 and 18 already expanded it. Phase 19 adds `scanDogfoodLedgerDepths`.

### Established Patterns

- **Graceful degradation cascade:** Phase 18 introduced `sampling_health` with `daemon_available` / `fallback_used` / `limitations_observed`. Phase 19's three-tier cascade follows the exact same shape but for ledger/memory sources instead of daemon.
- **Schema version bump:** Established as a pattern across three consecutive phases. The field is top-level in the report JSON.
- **Separation of concerns:** Implementation functions are `module.exports`-ed for test access. Tests are in separate files using `node:test` + `assert/strict`. Phase 19 follows this.

### Integration Points

- **`buildReport()` is the sole consumer** of `scanDogfoodLedgerDepths()`. The function replaces the static arrays with the dynamic result.
- **`generateMarkdown()` is the sole renderer.** The field names are unchanged, so the existing renderer works. Only add the "Scan source:" line.
- **The memory directory path** (`~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/`) is hardcoded in the requirement. The function should accept it as a parameter for testability (temp-dir fixtures can pass their own path).

### Ledger Table Structure (from investigation)

The `docs/v2.6-dogfood-ledger.md` depth table at lines 38-49:
```
| Depth | Phase | Actor | Artifact | Rationalization Named | Outcome |
|-------|-------|-------|----------|----------------------|---------|
| 0 | 13.1 Wave 1 | ... | ... | ... | Caught, ... |
| 1 | 13.1 Wave 2 | ... | ... | ... | Self-referential ... |
| 2 | 13.1 Wave 3 | ... | ... | ... | Resisted ... |
| 3 | — | — | — | — | Not yet observed |
| 4 | 13.1 Closeout | ... | ... | ... | Resisted ... |
...
| 9 | Phase 15 Wave 2 | ... | ... | ... | 4 distinct ... |
```

Parsing: regex `/^\|\s*(\d+)\s*\|/` on each line. Depth 3 has `| — |` in Phase column → detected as gap.

### Memory File Depth Annotations (from investigation)

| Depth | File | Annotation |
|---|---|---|
| 5 | `project_phase13_1_discuss_phase_reconciliation_dogfood.md` | `# Phase 13.1 Discuss-Phase Reconciliation Dogfood — Depth 5` |
| 6 | `project_phase14_prior_session_verification_dogfood.md` | `description: Depth-6 dogfood moment` |
| 7 | `project_phase15_ghost_directory_dogfood.md` | `# Phase 15 Ghost Directory Dogfood — Depth 7` |
| 8 | `project_phase15_execute_init_dogfood.md` | `# Phase 15 Execute-Phase Init Dogfood — Depth 8` |
| 9 | `project_phase15_wave2_auditor_self_restraint_dogfood.md` | `# Phase 15 Wave 2 Auditor Self-Restraint — Depth 9` |
| 10 | `project_phase16_init_resolver_self_referential_dogfood.md` | `# Phase 16 Init Resolver Self-Referential Dogfood — Depth 10` |
| 11 | `project_phase18_init_resolver_residual_dogfood.md` | `**Depth 11 — Phase 16 Residual Ghost Fallback...` |

All v2.7 depths (5+) use `/[Dd]epth[-:\s]+(\d+)/` — reliable.
Depths 0-4 have inconsistent annotations but are covered by the ledger table — no memory regex needed for them.

</code_context>

<specifics>
## Specific Ideas

- **The ledger table parser is ~8 LOC.** Read the file, split by newline, regex match `/^\|\s*(\d+)\s*\|/` per line, check for gap marker, return {captured: Set, gaps: Set}.
- **The memory scanner is ~15 LOC.** Glob the directory, read each file's frontmatter + first heading, regex `/[Dd]epth[-:\s]+(\d+)/`, add to Set.
- **The union + gap computation is ~5 LOC.** Merge Sets, compute `{0..max} \ union`, sort both.
- **Total: ~28 LOC for the function** + ~5 LOC for the `buildReport` wiring + ~5 LOC for the degradation cascade + ~2 LOC for `generateMarkdown` scan-source line = ~40 LOC. Within scope ceiling.
- **Expected output after Phase 19 ships:** `dogfood_ledger_depths_captured: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]` and `dogfood_ledger_gaps: [3]`. If depth 3 gets captured during v2.7 closeout, it auto-includes in the next audit run.

</specifics>

<deferred>
## Deferred Ideas

- **Amend memory files with `depth: N` YAML frontmatter** — would make the memory scan fully reliable for all depths (including 0-4). v2.8 cleanup task. Not Phase 19.
- **Create `docs/v2.7-dogfood-ledger.md`** — v2.7 closeout task, not Phase 19. When it's created, `scanDogfoodLedgerDepths` should be updated to scan multiple ledger files (or glob `docs/v*-dogfood-ledger.md`).
- **Support multiple ledger files** — The current parser reads one hardcoded path. A future version could glob `docs/v*-dogfood-ledger.md` and union all tables. Deferred to the v2.7 closeout task or v2.8.
- **Phase 16 gap: cmdInitPhaseOp residual ghost** — Still firing (Phase 19 discuss-phase init returned `v2.3-phases/19-token-efficiency` ghost). Route to Phase 16.1 gap closure.

</deferred>

---

*Phase: 19-dynamic-ledger-schema*
*Context gathered: 2026-04-12*
*Next: `/amauta:plan-phase 19`*
