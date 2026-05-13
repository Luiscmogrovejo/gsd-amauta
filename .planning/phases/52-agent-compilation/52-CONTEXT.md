# Phase 52: Agent Compilation - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 52 + REQUIREMENTS.md (COMPILE-01..04) + Phase 43/47 patterns (symmetric with skill compiler)

<domain>
## Phase Boundary

Agent definitions move from per-IDE Markdown (the 17 `agents/*.md` files) to canonical YAML at `get-shit-done/agents/<name>/AGENT.yaml`, and a new `gsd-tools agents compile --target=<ide>` subcommand emits per-IDE `.md` outputs. SYMMETRIC with Phase 43 skill compilation: same canonical-vs-output split, same per-IDE alias-table approach, same one-way compilation (canonical → IDE, never the reverse). Optional compile-time `--hydrate <agent>` invokes Phase 47 `agent_hydrator.hydrate(agent_name)` to bake a `## Current context` block into the output.

Out of scope: bidirectional sync (Phase 43 Area 2 — explicitly rejected, inherited), remote agent registry, real-time hot-reload of agents during execution, LLM-driven agent generation, alias-table changes to the YAML (alias tables live in code per Phase 43).

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Canonical YAML schema

FROZEN schema at `get-shit-done/agents/<name>/AGENT.yaml`:

```yaml
frontmatter:
  name: gsd-planner               # required, kebab-case
  description: "Planning specialist: ..."   # required, single-line summary
  tools: [Read, Write, Edit, Bash, Task, Glob, Grep]    # required, list of canonical tool names
  color: green                    # required
  memory: user                    # required, enum (user|project|none)
  skills: [gsd-planner-workflow]  # optional list of skill refs

# 10 section structure mirrors v3.0 FORMAT-01 (Phase 31)
sections:
  role_and_identity: |
    You are gsd-planner — a planning specialist...
  domain_knowledge: |
    - **P1 Prompt Chaining:** ...
  patterns_and_practices: |
    ...
  workflow_and_process: |
    ...
  tools_and_resources: |
    ...
  quality_gates: |
    ...
  output_format: |
    ...
  error_handling: |
    ...
  examples: |
    ...
  metadata: |
    version: 3.0.0
```

Pydantic `AgentDefinition` model in new `services/agent_schema.py`. `_HAS_PYDANTIC` + `_HAS_YAML` fallback (mirrors `services/module_schema.py` from Phase 48 + `services/skill_schema.py` from Phase 43).

LOCKED frontmatter field order for grep verification: `name → description → tools → color → memory → skills`. 6 fields.

LOCKED 10 section names: `role_and_identity`, `domain_knowledge`, `patterns_and_practices`, `workflow_and_process`, `tools_and_resources`, `quality_gates`, `output_format`, `error_handling`, `examples`, `metadata`.

### Area 2 — Backward-compatibility lock (SC1)

**Critical contract:** existing `agents/*.md` files (17 of them) MUST be regenerable from `get-shit-done/agents/<name>/AGENT.yaml` and match the prior content **byte-for-byte for unchanged YAML inputs**.

Approach:
1. Phase 52 generates the canonical YAML from each existing `agents/*.md` (one-time conversion, committed as part of this phase)
2. Compiler emits `.md` from YAML — output is normalized (consistent whitespace, frontmatter formatting)
3. After conversion, the canonical YAML is the SOURCE; `agents/*.md` files become COMPILED OUTPUTS for the Claude target
4. Backward-compat test: `gsd-tools agents compile --target=claude-code --out agents/` produces the SAME content currently checked in for unchanged YAML inputs

Existing `agents/*.md` are NOT deleted in Phase 52 — they continue to live in `agents/` as the compiled-claude-target output. The compiler can write back to that location.

### Area 3 — `scripts/agent-compiler.cjs` (symmetric with skill-compiler)

NEW file mirroring `scripts/skill-compiler.cjs` (Phase 43) structure verbatim:

```js
// scripts/agent-compiler.cjs
function compile(target, opts) { ... }
function validate(agentDir) { ... }
function listAgents(source) { ... }

const TARGET_MAPS = {
  'claude-code': {
    dir_name: '.claude',
    agent_subdir: 'agents',
    tool_aliases: {},   // claude-code uses canonical names
    frontmatter_aliases: {},
  },
  'opencode': {
    dir_name: '.opencode',
    agent_subdir: 'agents',
    tool_aliases: { Read: 'read_file', Write: 'create_file', ... },   // example
    frontmatter_aliases: { 'allowed-tools': 'allowedTools', ... },
  },
  'cursor': {
    dir_name: '.cursor',
    agent_subdir: 'rules',
    tool_aliases: { ... },
    frontmatter_aliases: { ... },
  },
};
```

Per-IDE alias tables are CODE-RESIDENT (NOT in YAML). Same locked policy as Phase 43.

### Area 4 — CLI surface

```
node get-shit-done/bin/gsd-tools.cjs agents compile --target=<ide> [--out <dir>] [--hydrate <agent>] [--json] [--dry-run]
node get-shit-done/bin/gsd-tools.cjs agents validate [<path>]
node get-shit-done/bin/gsd-tools.cjs agents list
```

Mirrors Phase 43 `gsd-tools skills compile/validate/list` exactly. Same `case 'agents':` dispatch convention (args[1] action, args.slice(2) rest — Phase 48/49 indexing).

Exit codes FROZEN (mirror Phase 48):
- 0 = success
- 1 = validation error OR compile error
- 2 = file I/O error

`--target=<ide>` REQUIRED for compile; valid values: `claude-code`, `opencode`, `cursor`. Phase 44's `platform-codes.yaml` already declares these IDEs — Phase 52's compiler reads dir_name+subdir from there for consistency (or stores in TARGET_MAPS — executor's call; CONTEXT 44 made yaml authoritative, so prefer reading from yaml).

### Area 5 — Compile-time hydration (`--hydrate`)

SC4 mandates: `--hydrate <agent>` invokes Phase 47's `agent_hydrator.hydrate(agent_name)` and bakes the result as `## Current context` section into the compiled `.md` (prepended above other sections, mirroring Phase 46 `_render_agent`'s injection point).

Default (no `--hydrate`): output is GENERIC and CACHEABLE — no PG/Valkey reads at compile time. Compile is offline-safe.

When `--hydrate gsd-planner` is passed:
1. Compiler calls `gsd-tools agent-hydrate <agent> --json` (Phase 47 CLI)
2. Renders the JSON via the frozen Markdown template (Phase 47 `agent_hydrate_cli.render_markdown`)
3. Prepends to the agent body before other sections

`--hydrate` can be passed multiple times for multi-agent compile. Without `--hydrate`, ZERO calls to Phase 47.

### Area 6 — One-time conversion: existing agents/*.md → canonical YAML

The 17 existing `agents/*.md` files are converted to `get-shit-done/agents/<name>/AGENT.yaml` ONCE as part of Phase 52. The conversion:
1. Parses each `.md` file's frontmatter + body
2. Extracts the 10 sections per v3.0 FORMAT-01 (Phase 31) headings
3. Writes the canonical YAML
4. Compiles back to `.md` and verifies byte-for-byte match with original (SC1 backward-compat lock)

The conversion is a `scripts/agent-md-to-yaml.cjs` tool (one-shot; can be deleted after migration if desired). Output committed; tool can stay for future imports.

### Area 7 — Backward-compatibility test (SC1 lock)

`tests/agents-compile-claude-target-byte-match.test.cjs`:
1. For each `agents/*.md` file:
   - Read its current bytes (committed)
   - Run `gsd-tools agents compile --target=claude-code --agent <name>` to a temp dir
   - Read the regenerated bytes
   - Assert byte-for-byte equality
2. Fails the build on any diff. This locks the conversion correctness.

### Area 8 — Reuse Phase 43/44/47 patterns (DO NOT reinvent)

- `scripts/skill-compiler.cjs` Phase 43 — compile/validate/list shape + TARGET_MAPS pattern
- `services/skill_schema.py` Phase 43 — Pydantic + `_HAS_PYDANTIC` fallback
- `services/module_schema.py` Phase 48 — Pydantic frontmatter declaration order discipline
- `get-shit-done/references/platform-codes.yaml` Phase 44 — IDE dir_name + skill_subdir source of truth; Phase 52 either reads dir_name + agent_subdir from here OR adds new `agent_subdir` field
- `services/agent_hydrator.py` Phase 47 — `--hydrate` flag invokes this
- `services/agent_hydrate_cli.py` Phase 47 — `render_markdown()` for the `## Current context` block
- `get-shit-done/bin/gsd-tools.cjs` Phase 48/49 case-dispatch convention

### Claude's Discretion

- Whether to extend `platform-codes.yaml` to add `agent_subdir` field (recommend YES — single source of truth) or hard-code in TARGET_MAPS (Phase 43 precedent for alias tables)
- Pydantic v2 syntax matching existing project files
- YAML formatting style (recommend `yaml.safe_dump(... , default_flow_style=False, sort_keys=False)` to preserve declaration order)
- Whether one-time conversion script `scripts/agent-md-to-yaml.cjs` ships in this phase OR is one-off + deleted (recommend ship — useful for future agent additions)
- Tool alias table seed values (executor's call; populate with known IDE conventions, document blanks as "TODO: research per IDE")

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 52 requirement source
- `.planning/REQUIREMENTS.md` §"Agent Compilation" — COMPILE-01..04
- `.planning/ROADMAP.md` §"Phase 52: Agent Compilation" — 4 success criteria
- `.planning/PROJECT.md` §"Current Milestone: v3.2 The Federation"

### Phase 43 mirror (Symmetric foundation)
- `scripts/skill-compiler.cjs` — compile/validate/list structure; Phase 52 mirrors verbatim shape
- `services/skill_schema.py` `SkillFrontmatter` — Pydantic + locked field order; agent_schema.py mirrors
- `get-shit-done/skills/<name>/SKILL.md` canonical sources — Phase 52 establishes `get-shit-done/agents/<name>/AGENT.yaml` as analog

### Phase 44 inheritance (platform IDE registry)
- `get-shit-done/references/platform-codes.yaml` — 3 IDEs × 4 fields; Phase 52 either extends with `agent_subdir` or reuses `dir_name` directly

### Phase 47 inheritance (hydration injection point)
- `services/agent_hydrator.py` `hydrate(agent_name, task_id=None)` — `--hydrate` flag calls this
- `services/agent_hydrate_cli.py` `render_markdown()` — converts hydration dict → `## Current context` Markdown

### Phase 31 (v3.0 FORMAT-01)
- `agents/gsd-*.md` — 17 existing agent .md files with standardized 10-section format; Phase 52 converts these to canonical YAML

### Phase 48/49 alignment (operator CLI conventions)
- `get-shit-done/bin/gsd-tools.cjs` `case 'module':` — args[1]/slice(2) indexing convention
- Phase 49 lifecycle exit code 0/1/2 convention

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 43 `scripts/skill-compiler.cjs` — full shape to mirror
- Phase 43 `services/skill_schema.py` — Pydantic pattern
- Phase 44 `get-shit-done/references/platform-codes.yaml` — IDE dir_name source of truth
- Phase 47 `services/agent_hydrate_cli.py.render_markdown()` — `## Current context` Markdown generator
- Phase 48 `services/module_schema.py` — recent Pydantic locked-field-order precedent
- Phase 48/49 `get-shit-done/bin/gsd-tools.cjs case '<command>':` — dispatch convention

### Established Patterns
- Compiler structure (Phase 43): `compile/validate/list` + TARGET_MAPS + canonical→IDE one-way
- Per-IDE alias tables in CODE not config (Phase 43 Area 2)
- Frozen YAML field declaration order for grep verification (Phase 43/48)
- `_HAS_PYDANTIC` + `_HAS_YAML` import-safety
- CLI exit codes 0/1/2 (Phase 48/49)
- gsd-tools.cjs case dispatch with args[1]/slice(2) (Phase 48/49)

### Integration Points
- `scripts/agent-compiler.cjs` — NEW (mirrors skill-compiler.cjs)
- `services/agent_schema.py` — NEW (Pydantic AgentDefinition)
- `scripts/agent-md-to-yaml.cjs` — NEW one-time conversion tool
- `get-shit-done/agents/<name>/AGENT.yaml` — NEW canonical sources (17 files)
- `get-shit-done/bin/gsd-tools.cjs` `case 'agents':` — NEW dispatch
- `agents/*.md` — KEPT as compiled-claude-target outputs; SC1 byte-match lock
- `get-shit-done/references/platform-codes.yaml` — POTENTIALLY EXTENDED with `agent_subdir` field

</code_context>

<specifics>
## Specific Ideas

- 17 existing agent .md files become 17 AGENT.yaml files at `get-shit-done/agents/gsd-<name>/AGENT.yaml`
- SC1 backward-compat lock test: byte-for-byte match between current `agents/*.md` and `gsd-tools agents compile --target=claude-code --out <tmpdir>` output for every agent
- `--hydrate <agent>` is per-agent, NOT a global flag — can be passed multiple times in one compile call
- 4-5 plan structure suggested: 52-01 AGENT.yaml schema + Pydantic + conversion tool, 52-02 agent-compiler.cjs (compile/validate/list with TARGET_MAPS), 52-03 17-file conversion + byte-match test (SC1 lock), 52-04 gsd-tools.cjs `case 'agents':` dispatch + CLI tests, 52-05 `--hydrate` integration + tests

</specifics>

<deferred>
## Deferred Ideas

- Bidirectional sync (IDE .md → canonical YAML) → rejected per Phase 43 Area 2; inherited
- Remote agent registry → future
- LLM-driven agent generation → out of scope
- Hot-reload of agents during execution → future operational phase
- Per-agent versioning / changelog automation → `agents/changelog/` directory exists; manual for now
- YAML schema validation against JSON Schema → optional, current Pydantic is enough
- Cursor-specific `.cursor/rules/` format research → executor pulls from Cursor docs at execution; TARGET_MAPS seeded with best-effort defaults

</deferred>

---

*Phase: 52-agent-compilation*
*Context gathered: 2026-05-13*
