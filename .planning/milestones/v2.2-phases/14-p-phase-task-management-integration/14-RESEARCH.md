# Phase 14 Research: P-Phase Task-Management Integration

**Gathered:** 2026-04-10
**Sources:** Direct file inspection — gsd-tools.cjs, gsd-amauta.cjs, amauta.py, gsd-operator.md, gsd-validator.md, plan-phase.md, execute-phase.md, 13.1-01-PLAN.md, 12-01-PLAN.md, REQUIREMENTS.md, STATE.md, 14-CONTEXT.md

---

## 1. Existing PLAN.md XML Schema (as-is)

Two reference examples examined: `13.1-01-PLAN.md` (Phase 13.1 era) and `12-01-PLAN.md` (Phase 12 era).

### Phase 12 era task element (12-01-PLAN.md lines 52-78)

```xml
<task id="12-01-01" agent="executor-backend" depends_on="">
<title>...</title>
<read_first>...</read_first>
<action>...</action>
<acceptance_criteria>...</acceptance_criteria>
</task>
```

Agent and depends_on are ATTRIBUTES on the `<task>` element itself, not child elements. No `<files_expected>` block. No `<story>` wrapper.

### Phase 13.1 era task element (13.1-01-PLAN.md lines 69-123)

```xml
<task id="13.1-01-01">
  <title>...</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <read_first>...</read_first>
  <action>...</action>
  <acceptance_criteria>...</acceptance_criteria>
  <files_expected>
    modify:
      - path/to/file
    create: []
    delete: []
  </files_expected>
</task>
```

By Phase 13.1: agent, depends_on, and files_expected are CHILD ELEMENTS (not attributes). `<depends_on>` takes a JSON-array string (`[]` or `["13.1-01-01"]`). The `<files_expected>` block uses YAML syntax embedded inside the XML element.

**Phase 14 adds on top of the 13.1 schema:** a mandatory top-level `<story>` sibling block. The new `plan-task-xml-schema.md` reference file locks this. The `<story>` block fields per CONTEXT.md: `<title>`, `<success_criteria>` (Given/When/Then), `<doc_refs>`.

**Key implication for plan-to-tasks XML parser:** Must handle BOTH child-element style (`<agent>`, `<depends_on>`) AND the embedded YAML in `<files_expected>`. The `_parseFilesExpectedYaml()` function already exists in `gsd-tools.cjs` (line 348) — plan-to-tasks reuses it.

---

## 2. `gsd-tools.cjs` Structure

**File:** `get-shit-done/bin/gsd-tools.cjs` — 1,172 lines total

**Import graph (lines 131-143):**
```js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { error } = require('./lib/core.cjs');
const state = require('./lib/state.cjs');
// ... phase, roadmap, verify, config, template, milestone, commands, init, frontmatter
```

`gsd-tools.cjs` does NOT import `gsd-amauta.cjs`. `gsd-amauta.cjs` does NOT import `gsd-tools.cjs`. There is NO import-graph cycle risk when adding `plan-to-tasks` to `gsd-tools.cjs` — it will call `gsd-amauta.cjs` via `child_process.spawnSync` (subprocess pattern), not via require.

**Existing top-level functions relevant to Phase 14:**
- `getCapabilityIndex()` — lazy-loads agent-capabilities.json, line 156
- `routeExecutor(filesStr)` — lines 184-228, reads file_patterns, priority order frontend > infra > backend > general, returns `"executor-frontend|infra|backend|general"` (WITHOUT `gsd-` prefix after line 222)
- `resolvePhaseDir(taskIdOrPhase, opts)` — lines 278-289, canonical phase-number extractor (added in 13.1-05-05)
- `_globToRegExp(glob)` — line 299, minimatch-style, already handles `*` and `**`
- `_matchesAny(pathStr, patterns)` — line 328
- `_parseFilesExpectedYaml(yamlText)` — line 348, parses the `modify/create/delete` YAML format in `<files_expected>` blocks
- `manifestCheck({...})` — line 459, full per-task enforcement logic

**The `module.exports` block (lines 689-702):**
```js
if (require.main !== module) {
  module.exports = {
    manifestCheck,
    GLOBAL_ALLOWLIST,
    ORCHESTRATOR_OWNED,
    MANIFEST_GLOB_BLOCKLIST,
    resolvePhaseDir,
    _parseFilesExpectedYaml,
    _globToRegExp,
    _diffNameStatus,
    routeExecutor,
  };
}
```

**Pattern for adding `plan-to-tasks`:** Add a new `// ─── Plan-to-Tasks (PLAN-02) ──────────────────────────────────────────────────` section between the manifest-check section (ends ~line 688) and the `if (require.main !== module)` export block. Add `planToTasks` to the `module.exports` object. Add a `case 'plan-to-tasks':` to the `switch (command)` block before the `default:` case (line 1165).

**CLI router switch-case dispatch structure (lines 739-1167):**
The last two custom cases before `default:` are:
```
case 'route-executor': ...   (line 1148)
case 'manifest-check': ...   (line 1157)
default: error(...)          (line 1165)
```

`plan-to-tasks` case goes between `manifest-check` and `default`.

---

## 3. `_dedup_check` in `amauta.py` — Exact Logic

**Location:** `amauta.py` lines 2461-2491

**Current behavior (unchanged by Phase 14):**
```python
def _dedup_check(items, title, agent):
    title_lower = title.lower().strip()
    stop = {"the","a","an","and","or","for","to","in","on","of","is","it","with",
            "fix","task","blocker","unblock","resolve","issue","check","pr","due"}
    title_words = set(w for w in title_lower.split() if w not in stop and len(w) > 2)

    for t in items:
        if not isinstance(t, dict): continue
        status = t.get("status", "")
        if status not in ("pending", "in-progress"): continue
        existing_agent = (t.get("assigned_to") or "").lower()
        if agent and existing_agent != agent.lower(): continue
        existing_title = (t.get("title") or "").lower().strip()
        ratio = difflib.SequenceMatcher(None, title_lower, existing_title).ratio()
        if ratio >= 0.70: return t.get("id")
        existing_words = set(w for w in existing_title.split() if ...)
        if title_words and existing_words:
            overlap = len(title_words & existing_words) / max(len(title_words), len(existing_words))
            if overlap >= 0.60: return t.get("id")
    return None
```

**What Phase 14 patches:** `_dedup_check` is called at `cmd_add` line 2501. The scoped bypass (CONTEXT.md Area 1 LOCK B) requires patching `_dedup_check` to accept an optional `from_plan` parameter and skip the similarity check IFF BOTH conditions hold: `source == "plan-to-tasks"` on the new task being added AND `from_plan` matches an existing task's `metadata.plan_id`. The `--from-plan` CLI flag carries the plan_id through `cmd_add`'s argparse into `_dedup_check`.

**Key constraint:** The bypass is scoped by SAME plan_id. Two plan-to-tasks tasks from DIFFERENT plan files with 90% title similarity still trigger dedup. Manual `amauta add task` never hits the bypass (no `source: "plan-to-tasks"` field).

**`amauta.py` argparse for `add` does NOT currently have `--source` or `--from-plan` flags** (verified lines 5559-5581). Phase 14 adds both to the `add` subparser.

---

## 4. `cmd_add` and `cmd_link` in `amauta.py` — Argument Signatures and Return

**`cmd_add(args)` — lines 2494-2572:**

Arguments accessible via `args.*`:
- `args.type` (choices: TYPES)
- `args.title`
- `args.description`, `args.details`, `args.test_strategy`
- `args.status`, `args.priority`, `args.agent`
- `args.parent`, `args.deps`, `args.tags`
- `args.sprint`, `args.due`, `args.hours`
- `args.importance`, `args.urgency`
- `args.criteria` (pipe-separated success_criteria)
- `args.deliverables`, `args.checklist`
- `args.force`

**No current `args.source` or `args.from_plan`.** Phase 14 adds these to argparse (line ~5580).

**Return behavior:** Prints to stdout. Exit code 0 on success (via `sys.exit(0)` implicit). Exit code 1 on parent not found, hierarchy error, dep not found. On dedup block: prints warning and `sys.exit(0)` (not a hard error — exits 0 but prints DEDUP BLOCKED to stdout).

**The created item ID** is printed at line 2571: `print(c(f"Created {itype} {nid}: {args.title}", GREEN))`. The CJS wrapper captures this output to extract the TK-XXXX or ST-XXXX ID.

**`cmd_link(args)` — lines 5406-5437:**

Arguments: `args.id`, `args.dep_id`.

Per-edge `_reaches()` cycle check runs inside `cmd_link` (lines 5419-5427). Already halts on cycle with: `print(c(f"Would create circular dependency: {args.id} → {args.dep_id}", RED)); sys.exit(1)`.

Returns exit 0 on success, exit 1 on any error (not found, self-dep, cycle). On already-linked: prints `dim` message, exits 0.

**`cmd_link` is unchanged by Phase 14.** The batch cycle-check in plan-to-tasks Pass 0 runs before any `cmd_link` call, so `cmd_link`'s per-edge check serves as a double safety net.

---

## 5. `cmdAdd` and `cmdLink` in `gsd-amauta.cjs` — CJS Wrappers

**`cmdAdd(useDaemon, argv, jsonMode)` — lines 436-461:**

```js
async function cmdAdd(useDaemon, argv, jsonMode) {
  const type = argv[0];       // e.g. "task" or "story"
  const title = argv[1];
  const flags = parseFlags(argv, 2);
  const body = { type, title, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/add', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  // Direct CLI path
  const args = ['add', type, title];
  if (flags.parent) args.push('--parent', flags.parent);
  if (flags.agent) args.push('--agent', flags.agent);
  if (flags.priority) args.push('--priority', flags.priority);
  if (flags.description) args.push('--description', flags.description);
  if (flags.importance) args.push('--importance', flags.importance);
  if (flags.urgency) args.push('--urgency', flags.urgency);
  if (flags.tags) args.push('--tags', flags.tags);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}
```

**`plan-to-tasks` calls `cmdAdd` via subprocess**, not via require. The subprocess call is:
```bash
node gsd-amauta.cjs add task "<title>" --parent ST-XXXX --agent executor-backend \
  --criteria "..." --source plan-to-tasks --from-plan 14-01 --tags "..."
```

Phase 14 must also add `--source` and `--from-plan` flag pass-through to the direct CLI args block in `cmdAdd` (same pattern as existing `flags.parent`, `flags.agent`, etc.).

**`cmdLink(useDaemon, id, flags, jsonMode)` — lines 1444-1456:**

```js
async function cmdLink(useDaemon, id, flags, jsonMode) {
  if (!id) die('...');
  if (!flags.dep) die('--dep is required');

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/exec', { args: ['link', id, flags.dep] });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['link', id, flags.dep]);
  printResponse(result, jsonMode);
  return result.exit_code;
}
```

Invoked as: `amauta link TK-XXXX --dep TK-YYYY`. Exit 0 on success or already-linked. Exit 1 on cycle or not-found.

**No changes needed to `cmdLink` in Phase 14.** Only `cmdAdd` gets the two new flags.

---

## 6. RPETD Block Parser Pattern in `gsd-operator.md`

**File:** `agents/gsd-operator.md`

There is **NO central parser registry**. Each block type is hand-wired as a dedicated XML-tagged section in the operator agent prompt. Verified sections:

| XML tag | Block type | Phase |
|---------|-----------|-------|
| `<d_phase_structured_learning>` | `LEARNING:` block | Phase 10 |
| `<applied_learning_citation_scan>` | `APPLIED_LEARNING: mem-XXXX` references | Phase 10 |
| `<qa_report_phase_end>` | `QA_REPORT:` line | Phase 12 |

**Pattern:** Each section is a self-contained prose + bash-snippet block. No registry, no dispatch table. Each section independently greps or parses the relevant block type from task content (typically via `grep -oE` or python3 inline).

**Phase 14 action:** Add `<plan_registration_phase_end>` section to `gsd-operator.md` using the SAME hand-wiring pattern as the three existing sections. Place it AFTER `<qa_report_phase_end>`. No registry introduction needed — that would be scope creep per CONTEXT.md Area 4 note.

The operator section checks P-phase content for a `PLAN_REGISTRATION:` block (indented fields), extracts key fields (`plan_id`, `story_id`, `task_count`, `task_ids`), and logs them at phase-end alongside LEARNING/APPLIED_LEARNING/QA_REPORT.

**`gsd-validator.md` advisory pattern:** Uses inline `[ADVISORY]` markers (lines 173-214). The spec-inheritance advisory (line 194) and pre-execution evidence advisory (line 173) follow the same pattern: parse output of `cmdValidate`, check for advisory flags, log to task notes with `$CLI note`. Phase 14 adds a third advisory for `PLAN_REGISTRATION` structural presence — same pattern.

---

## 7. `plan-phase.md` Workflow — Integration Point

**File:** `get-shit-done/workflows/plan-phase.md` — 645 lines

`plan-to-tasks` does NOT integrate into `plan-phase.md`. The plan-phase workflow creates PLAN.md files. The plan-to-tasks invocation happens at EXECUTE time, not plan time.

The plan-phase workflow's relevant integration point is the **plan-checker invocation (step 10-11)** which currently checks content quality. Per CONTEXT.md, the plan-checker gets an advisory zero-deps warning (if a wave has zero `<depends_on>` edges across N>2 tasks). This advisory lives in `plan-phase.md` at the checker quality gate, not in `plan-to-tasks` itself.

The existing plan-checker quality gate (lines 395-404) checks:
- Every `<task>` has `<read_first>` with at least one entry
- Every `<action>` contains concrete values
- Dependencies correctly identified
- Waves assigned
- must_haves derived from phase goal

Phase 14 extends this gate (per PLAN-06) to also check: no cycle, task count ≤ 10, every task has `<agent>` field, plus the advisory "zero `<depends_on>` edges" warning.

---

## 8. `execute-phase.md` Workflow — Integration Point

**File:** `get-shit-done/workflows/execute-phase.md` — 783 lines

**Current `discover_and_group_plans` step (lines 92-171):**

Already registers plans as amauta tasks in a lightweight way — using `$AMAUTA_CLI exec add task "$PLAN_OBJECTIVE" --parent "$PHASE_STORY"`. This is the existing "thin" registration that plan-to-tasks will REPLACE (or augment with full metadata) for phases ≥ 14.

**Where plan-to-tasks inserts (per CONTEXT.md):** Inside `discover_and_group_plans`, AFTER the existing PLAN_INDEX load and BEFORE the current thin `amauta add task` loop. The phase-number cutoff check goes here.

**The phase cutoff check pattern:**
```bash
PHASE_NUM=$(echo "$INIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase_number',''))" 2>/dev/null || echo "")
# plan-to-tasks runs for phase >= 14 only
if python3 -c "import sys; n='${PHASE_NUM}'; parts=n.split('.'); exit(0 if float(parts[0]) >= 14 else 1)" 2>/dev/null; then
  # Run plan-to-tasks for each PLAN.md
  ...
fi
```

The existing thin amauta task registration loop (lines 120-168) is REPLACED by plan-to-tasks for phases ≥ 14. For phases 9-13 (grandfathered), the existing loop stays untouched.

**Current thin registration gap plan-to-tasks closes:**
- Thin loop creates tasks with only: title, parent ST-XXXX, agent, priority=high
- plan-to-tasks adds: `metadata.plan_local_id`, `metadata.plan_file`, `metadata.plan_id`, `source: "plan-to-tasks"`, `success_criteria` from `<acceptance_criteria>`, `deps` from `<depends_on>`, full agent assignment with conflict detection

**The `manifest-check` migration note (line 334):** Already documents the HARDEN-01 grandfathering pattern. Phase 14 adds a parallel note for plan-to-tasks in the same section.

---

## 9. Test Infrastructure — Phase 13.1 Test Patterns

**Reference files:**
- `tests/13.1-manifest-check.test.cjs` — deterministic unit tests, 13 cases
- `tests/13.1-divergence-protocol.integration.test.cjs` — behavioral integration tests (real LLM)

**Unit test pattern (`13.1-manifest-check.test.cjs`):**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const tools = require(GSD_TOOLS);
const { manifestCheck, GLOBAL_ALLOWLIST, ORCHESTRATOR_OWNED } = tools;
```

- Uses `node:test` top-level `test(...)` style (not describe/it)
- Each test creates its own `os.tmpdir()` temp dir with a prefixed name
- Temp dir removed on success, preserved + logged on failure
- Tests work with fake git repos (create actual git repos in temp dir via `execSync('git init ...')`)
- Tests invoke functions directly (unit path) OR via `execSync('node ... gsd-tools.cjs ...')` (CLI path)

**Phase 14 test files per CONTEXT.md:**
- `tests/14-plan-to-tasks.test.cjs` — CJS unit tests (no daemon), for Pass 0 logic
- `tests/14-plan-to-tasks.integration.test.cjs` — real-daemon integration tests

**Unit test coverage (~20-25 cases):**
- Pass 0: cycle detection (4 assertions in 1 test), cap counting (fold into same fixture as cycle)
- Files-disjoint split algorithm: 3 cases (overlap-all, no-clean-boundary, exact-10)
- Re-run idempotency: 3 cases (requires `spawnDaemon`/`killDaemon` lifecycle helpers with SIGKILL)
- Drift detection (`plan_amauta_drift`): ~2 cases
- Agent assignment conflict (`agent_assignment_conflict`): ~2 cases
- Dedup bypass scope: 1 test × 3 assertions
- PLAN_REGISTRATION parser + structural advisory: ~2 cases
- dag_text truncation (20-edge fixture): 1 case
- divergence-protocol version bump to 1.1.0: 1 case

**Critical integration test requirement:** daemon lifecycle helpers must use SIGKILL (not mock). The mid-flight failure test is the proof the forward-only + identity-contract recovery actually works, not just a design claim.

---

## 10. `_inherit_parent_spec` in `amauta.py`

**Confirmed location:** `amauta.py` lines 2218-2274

**Call signature:** `_inherit_parent_spec(item: dict, items: list) -> str`

**Behavior:**
- Walks up to 3 levels: task → story → epic
- First-wins semantics: stops at the first parent with non-empty `success_criteria`
- Caps at 10 criteria; appends truncation message if > 10
- Assigns `SC-01..SC-N` IDs with `enumerate(capped, 1)`
- Caches result on `item["metadata"]["inherited_spec"]` — a dict with `{source, source_type, criteria, truncated}`
- Returns the formatted string block OR empty string if no criteria found
- Kill switch: `GSD_T_SPEC_INHERIT=false` returns `""` immediately and sets `inherited_spec = None`
- Never raises: entire body in `try/except Exception: return ""`

**Phase 14 usage:** plan-to-tasks calls `_inherit_parent_spec` READ-ONLY (no caching, no metadata stamp) AFTER story creation in Pass 0.5, to compute `inherited_criteria_count` for the `PLAN_REGISTRATION` block. The count is: `len(result_dict["criteria"])` from the cached metadata, or 0 if not found.

The call is via subprocess: `amauta show <story_id> --json --no-inherit` to get the story's `success_criteria`, then count the items. plan-to-tasks does NOT call `_inherit_parent_spec` directly — it reads the already-computed count from the `show --json` output at the story level.

**Phase 12 precedent:** `cmd_show` at line 2588 already does a shallow dict copy and calls `_inherit_parent_spec` on-demand if `metadata.inherited_spec` is missing. plan-to-tasks inherits this behavior for free when reading via `amauta show --json`.

---

## Key Facts for Planning

### Files Phase 14 Modifies

| File | Change |
|------|--------|
| `get-shit-done/bin/gsd-tools.cjs` | NEW `planToTasks()` function + `case 'plan-to-tasks':` dispatch + exports |
| `get-shit-done/bin/gsd-amauta.cjs` | `cmdAdd()`: add `--source` and `--from-plan` flag pass-through |
| `amauta.py` | `_dedup_check()`: patch for scoped bypass; `cmd_add` argparse: add `--source`, `--from-plan` |
| `agents/gsd-planner.md` | 3-5 line addition to `<planning_protocol>` pointing at `plan-task-xml-schema.md` |
| `agents/gsd-operator.md` | New `<plan_registration_phase_end>` section |
| `agents/gsd-validator.md` | New structural advisory check for `PLAN_REGISTRATION` presence |
| `get-shit-done/workflows/plan-phase.md` | Extend plan-checker quality gate (advisory zero-deps warning) |
| `get-shit-done/workflows/execute-phase.md` | Replace thin registration loop with plan-to-tasks call (phase ≥ 14 gated) |
| `get-shit-done/references/divergence-protocol.md` | Bump v1.0.0 → v1.1.0, add 2 new enum values (single atomic edit) |
| `.planning/STATE.md` | Add plan-to-tasks cutoff note to "Roadmap Evolution" |
| `.planning/REQUIREMENTS.md` | PLAN-04 errata: strike implicit-N+1, add explicit-only + PITFALLS P8 footnote |

### Files Phase 14 Creates

| File | Purpose |
|------|---------|
| `get-shit-done/references/plan-task-xml-schema.md` | NEW: locks `<story>` + `<task>` + `<files_expected>` + `<depends_on>` schema |
| `tests/14-plan-to-tasks.test.cjs` | CJS unit tests (Pass 0 logic, no daemon) |
| `tests/14-plan-to-tasks.integration.test.cjs` | Real-daemon integration tests (idempotency, drift, dedup bypass) |

### Architecture Constraints for Planning

1. **gsd-planner.md is at 200-line ceiling** — all schema content goes in `plan-task-xml-schema.md` reference file (runtime Read pattern). The planner prompt addition is 3-5 lines max.

2. **No new PG schema** — `metadata.plan_local_id`, `metadata.plan_file`, `source: "plan-to-tasks"` all fit in existing `metadata jsonb` column (39-field task schema, migration 007).

3. **plan-to-tasks calls amauta via subprocess** — not via require. The import-graph has no cycle. This means plan-to-tasks parses `amauta add` stdout to extract created IDs (grep for `TK-[0-9]+` or `ST-[0-9]+`).

4. **`amauta list` does NOT filter by metadata fields** — `cmd_list` filters by agent, type, status, priority, sprint, tag only (lines 2610-2616). To find existing tasks by `metadata.plan_local_id`, plan-to-tasks must use `amauta list --json` and filter client-side, OR use `amauta show` on the known ID. The lookup pattern: call `amauta board --json` (if available) and filter by `metadata.plan_id`, or use the daemon API `/api/exec` with a list query. This is a key implementation detail to decide in plan-phase.

5. **`routeExecutor()` returns executor WITHOUT `gsd-` prefix** — line 222: `return agentId.replace('gsd-', '')`. So `routeExecutor("amauta.py")` returns `"executor-backend"`, not `"gsd-executor-backend"`. plan-to-tasks compares this against the planner-emitted `<agent>` field. The `<agent>` field in PLAN.md tasks must also use the short form (no `gsd-` prefix) for the comparison to work.

6. **`_dedup_check` currently has no `from_plan` parameter** — the argparse for `add` has no `--source` or `--from-plan` flags. Both additions are required in `amauta.py` before the bypass can work. The bypass logic in `_dedup_check` must check `args.source == "plan-to-tasks"` (passed as a new param) AND scan existing items for matching `metadata.plan_id`.

7. **divergence-protocol.md version bump is a SINGLE atomic edit** — both new enum values (`agent_assignment_conflict` and `plan_amauta_drift`) land in the same task that touches divergence-protocol.md. Don't split across two tasks (would collide on the version line).

8. **PLAN-04 errata edit is in CLOSEOUT commit** — not inline during execution tasks. Per CONTEXT.md Area 2 decision and the closeout-paperwork dogfood discipline.

### Recommended Task Atomization

Based on the CONTEXT.md test-surface estimate (~20-25 test cases) and dependency graph, the phase decomposes into roughly these logical units:

**Wave 1 (can run after research/planning):**
- T14-A: divergence-protocol.md v1.1.0 bump (new enum values). Small, isolated, required by all Pass 0 divergence detection.
- T14-B: `plan-task-xml-schema.md` reference file creation + gsd-planner.md 3-5 line pointer addition.

**Wave 2 (depends on T14-A for enum values):**
- T14-C: amauta.py `_dedup_check` patch + `cmd_add` argparse additions (`--source`, `--from-plan`) + `gsd-amauta.cjs` `cmdAdd` flag pass-through.
- T14-D: `gsd-tools.cjs` `planToTasks()` function — Pass 0 (cycle detection, cap counting, schema validation, agent conflict detection, split algorithm) + unit tests (14-plan-to-tasks.test.cjs).

**Wave 3 (depends on T14-C + T14-D):**
- T14-E: `planToTasks()` Pass 1 + Pass 2 implementation (actually calls `amauta add` and `amauta link` via subprocess) + integration tests (14-plan-to-tasks.integration.test.cjs) including daemon SIGKILL tests.

**Wave 4 (depends on T14-D + T14-E):**
- T14-F: `PLAN_REGISTRATION` block parser in gsd-operator.md + structural advisory in gsd-validator.md.
- T14-G: execute-phase.md plan-to-tasks integration (phase ≥ 14 gated, replaces thin registration loop) + STATE.md cutoff note.
- T14-H: plan-phase.md plan-checker quality gate extension (advisory zero-deps warning, mandatory `<story>` check, PLAN-06 gates).

**Closeout (not an executor task):**
- REQUIREMENTS.md PLAN-04 errata (orchestrator closeout commit, not executor scope).

This suggests 7-8 executor tasks, within the 10-task cap.

### Risks the Planner Must Address

1. **`amauta list` metadata filtering gap** — plan-to-tasks needs to look up existing tasks by `metadata.plan_local_id` for idempotency. There is no current CLI path for metadata-field filtering. Options: (a) parse `amauta board --json` output client-side, (b) add a minimal `/api/exec` board query with client-side filter, (c) use a dedicated daemon endpoint. Decide in plan-phase; this affects both T14-C (argparse) and T14-D (lookup logic).

2. **`_dedup_check` bypass needs both sides** — the Python `cmd_add` and the Python `_dedup_check` both need patching, AND the CJS `cmdAdd` wrapper needs the new flags. All three are in T14-C. If split across tasks, ensure dependency edges enforce order.

3. **Daemon lifecycle in integration tests** — the `spawnDaemon()`/`killDaemon()` helpers must actually SIGKILL the daemon process. If the daemon uses a non-standard process name or port, the kill logic needs the right PID. Check `GSD_AMAUTA_PORT` env var (used in test setup, line 52 of 13.1-manifest-check.test.cjs: `process.env.GSD_AMAUTA_PORT = '19998'`). Integration tests for Phase 14 must use a different test port to avoid colliding with the production daemon on 18799.

4. **gsd-planner.md at 200-line ceiling** — the 3-5 line addition must not exceed the limit. Current file: exactly 200 lines (verified via STATE.md). Plan-phase must verify the exact count before the executor touches the file and confirm the addition won't exceed ceiling.

5. **PLAN.md frontmatter `plan_id` field** — plan-to-tasks derives the `plan_id` from the plan filename convention (e.g., `14-01-PLAN.md` → `plan_id = "14-01"`). The current PLAN.md frontmatter has `plan_id:` as a field (13.1-01-PLAN.md frontmatter line 2: `plan_id: 13.1-01`). plan-to-tasks can read it from frontmatter OR parse the filename. The frontmatter field is more reliable — plan-to-tasks should read it.

---

## Summary

Phase 14 adds a new `planToTasks()` function to `gsd-tools.cjs` alongside `routeExecutor` and `manifestCheck`. It parses a structured PLAN.md XML block (with mandatory `<story>` wrapper), runs a 3-pass registration (Pass 0: shape validation + cycle check + cap check + agent conflict detection, Pass 0.5: story creation, Pass 1: task creation, Pass 2: dep linking), and is idempotent on re-runs via `metadata.plan_local_id` + `--from-plan` scoped dedup bypass. It calls `amauta add` and `amauta link` via subprocess (not require). It patches `_dedup_check` in `amauta.py` with a scoped bypass. It bumps `divergence-protocol.md` to v1.1.0 with two new enum values. It adds a `PLAN_REGISTRATION` structured block parsed by a new hand-wired section in `gsd-operator.md`. The phase is gated at phase ≥ 14 in execute-phase.md. `GSD_P_AUTO_TASK=false` disables it everywhere.

The main unknown for the planner is how plan-to-tasks queries existing tasks by `metadata.plan_local_id` for idempotency — there is no current metadata-filter CLI in `amauta.py`. This is the one design decision not fully locked by CONTEXT.md and requires a concrete choice in plan-phase.
