version: "1.0.0"
reference_type: runtime-read
scope: gsd-planner

# Plan Task XML Schema

> Runtime Read. `gsd-planner` MUST Read this file before emitting `<task>` blocks
> in any PLAN.md for phases >= 14. The schema below is the locked canonical format
> for `<story>` and `<task>` elements. Deviations are rejected by `plan-to-tasks`
> during Pass 0 validation.

---

## Schema Cutoff

This schema applies to phases >= 14. Phases 9-13 are grandfathered and their
PLAN.md files are NOT parsed for registration by `plan-to-tasks`. The phase
number is authoritative — the mere presence of a `<story>` block in a Phase
9-13 plan does NOT trigger registration.

---

## 1. `<story>` Block (MANDATORY)

A `<story>` block is MANDATORY in every PLAN.md for phases >= 14. A PLAN.md
without a `<story>` block is rejected by `plan-to-tasks` as a malformed plan.
The `<story>` block is a top-level sibling to `<task>` blocks (not a parent
element wrapping them).

### Fields

```xml
<story>
  <title>Story title (becomes `amauta add story` title)</title>
  <success_criteria>
    Given [preconditions],
    When [action],
    Then [observable outcome].
  </success_criteria>
  <doc_refs>
    - path/to/reference-1.md
    - path/to/reference-2.md
  </doc_refs>
</story>
```

| Field | Required | Description |
|-------|----------|-------------|
| `<title>` | YES | Story title; passed as the title arg to `amauta add story`. |
| `<success_criteria>` | YES | Given/When/Then format. Inherited by child tasks via `_inherit_parent_spec` at claim time (Phase 12 mechanism). |
| `<doc_refs>` | YES | Dash-prefixed list of canonical reference file paths. May be empty list if no refs apply. |

---

## 2. `<task>` Block (Child-Element Style)

All task fields use child-element style (NOT attribute style). The only
attribute on the `<task>` element itself is `id`.

### Field Inventory

```xml
<task id="{plan_id}-{NN}">
  <title>Task title</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <read_first>
    - path/to/file-1.md
    - path/to/file-2.cjs
  </read_first>
  <action>
    Concrete instructions with exact values, file paths, and commands.
  </action>
  <acceptance_criteria>
    - grep command or shell assertion that verifies this task
    - another verifiable condition
  </acceptance_criteria>
  <files_expected>
    modify:
      - path/to/modified-file.md
    create:
      - path/to/new-file.md
    delete: []
  </files_expected>
</task>
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` attribute | YES | Format: `"{plan_id}-{NN}"`, e.g. `"14-01-01"`. Two-digit zero-padded task number. |
| `<title>` | YES | Task title. |
| `<agent>` | YES | Executor agent short name (no `gsd-` prefix). Valid values: `executor-backend`, `executor-frontend`, `executor-infra`, `executor-general`. Must match `routeExecutor()` result over `<files_expected>.modify + .create`. |
| `<depends_on>` | YES | JSON array of task IDs within the same plan. Use `[]` for no deps. Dependencies are explicit-only (EXPLICIT ONLY) — tasks without `<depends_on>` entries are parallel-eligible by default. No implicit N+1 ordering. |
| `<read_first>` | YES | Dash-prefixed list of files the executor must read before working. |
| `<action>` | YES | Concrete instructions with exact values, commands, and file paths. |
| `<acceptance_criteria>` | YES | Dash-prefixed list of grep-verifiable conditions. |
| `<files_expected>` | YES — MANDATORY | Manifest block with `modify:`, `create:`, `delete:` YAML sublists. All three keys required; use `[]` for empty. HARDEN-01 mandate. |

---

## 3. Validation Rules

`plan-to-tasks` enforces these rules in Pass 0 before creating any tasks:

1. **MANDATORY `<story>` block** — A PLAN.md without a `<story>` block is
   rejected as malformed. No partial registration.
2. **MANDATORY `<files_expected>`** — Every `<task>` must have a
   `<files_expected>` block with all three sublists declared. Tasks missing
   this block are rejected. (HARDEN-01 mandate.)
3. **Non-empty `<agent>`** — Every `<task>` must have a non-empty `<agent>`
   field matching one of the four valid executor names.
4. **`<depends_on>` references must be intra-plan** — All task IDs listed in
   `<depends_on>` must reference IDs within the same PLAN.md. Cross-plan
   dependencies are not supported.
5. **Maximum 10 `<task>` elements per plan** — Plans with more than 10 tasks
   are rejected with a structured split-boundary suggestion. (PLAN-05 mandate.)
6. **No dependency cycles** — `plan-to-tasks` runs full DAG cycle detection in
   Pass 0. A cycle produces a hard error naming the cycle participants by
   plan-local ID, and zero tasks are created.
7. **`<agent>` must match `routeExecutor()`** — `plan-to-tasks` computes
   `routeExecutor()` over `<files_expected>.modify + .create` and compares
   against the planner-emitted `<agent>`. Mismatch halts registration with a
   `divergence_report` (`divergence_type: "agent_assignment_conflict"`).

---

## 4. Example: One Story, Two Tasks

```xml
<story>
  <title>Phase 14 Wave 1: Protocol and Schema Foundation</title>
  <success_criteria>
    Given divergence-protocol.md is at v1.0.0 with 5 enum values,
    When Wave 1 completes,
    Then the file is at v1.1.0 with 7 enum values including agent_assignment_conflict and plan_amauta_drift,
    And plan-task-xml-schema.md exists as a runtime Read reference locking the story+task XML schema,
    And gsd-planner.md points at it within its 200+4 line budget.
  </success_criteria>
  <doc_refs>
    - .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-CONTEXT.md
    - .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-RESEARCH.md
  </doc_refs>
</story>

<task id="14-01-01">
  <title>Bump divergence-protocol.md to v1.1.0 with two new enum values</title>
  <agent>executor-general</agent>
  <depends_on>[]</depends_on>
  <read_first>
    - get-shit-done/references/divergence-protocol.md
    - .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-CONTEXT.md
  </read_first>
  <action>
    Edit divergence-protocol.md — bump version to 1.1.0, add
    agent_assignment_conflict and plan_amauta_drift to the enum.
  </action>
  <acceptance_criteria>
    - grep -c '^version: "1.1.0"' get-shit-done/references/divergence-protocol.md returns 1
    - grep 'agent_assignment_conflict' get-shit-done/references/divergence-protocol.md matches
  </acceptance_criteria>
  <files_expected>
    modify:
      - get-shit-done/references/divergence-protocol.md
    create: []
    delete: []
  </files_expected>
</task>

<task id="14-01-02">
  <title>Create plan-task-xml-schema.md reference file and add planner Read pointer</title>
  <agent>executor-general</agent>
  <depends_on>[]</depends_on>
  <read_first>
    - get-shit-done/references/qa-checklist.md
    - agents/gsd-planner.md
    - .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-CONTEXT.md
  </read_first>
  <action>
    Create get-shit-done/references/plan-task-xml-schema.md and add a
    Read pointer in gsd-planner.md planning_protocol section.
  </action>
  <acceptance_criteria>
    - test -f get-shit-done/references/plan-task-xml-schema.md returns 0
    - grep 'plan-task-xml-schema' agents/gsd-planner.md returns a match
    - wc -l agents/gsd-planner.md returns 204 or fewer
  </acceptance_criteria>
  <files_expected>
    modify:
      - agents/gsd-planner.md
    create:
      - get-shit-done/references/plan-task-xml-schema.md
    delete: []
  </files_expected>
</task>
```

---

## 5. Common Mistakes to Avoid

- **Attribute style is wrong:** `<task id="14-01-01" agent="executor-backend">` is rejected. All fields except `id` use child elements.
- **Implicit dependency ordering is wrong:** Do NOT assume tasks are ordered N+1. All deps must be in `<depends_on>`. A task without `<depends_on>` is parallel-eligible.
- **`<files_expected>` with missing sublists:** All three of `modify:`, `create:`, `delete:` must be present even if empty (`[]`). A partial `<files_expected>` is rejected.
- **`<agent>` with `gsd-` prefix:** Use `executor-backend`, NOT `gsd-executor-backend`.
- **Cross-plan `<depends_on>` references:** Only intra-plan task IDs are valid in `<depends_on>`.
