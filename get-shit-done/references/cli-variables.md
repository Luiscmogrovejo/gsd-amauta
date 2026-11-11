# Shared CLI Variables (runtime Read — NOT @ include)

**Pattern:** Agents and workflow files use the Read tool to load this file at the start of the RPETD protocol. They paste the shell block below directly into their bash invocations. This dedupes boilerplate across 11 agents + 6 workflow files (LEARN-07).

**Why runtime Read (not `@` include):** The `@` include syntax does NOT work inside agent `.md` files or workflow files. Agents MUST use the `Read` tool to load this reference at runtime. Fallback comments below each variable let an agent continue working even if the Read call fails.

---

## Shell Variable Block (copy-paste into bash)

```bash
# Core tool paths — read from get-shit-done/references/cli-variables.md
CLI="node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs"
RLM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-research.cjs"
TOOLS="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-tools.cjs"
SHUNT="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-shunt.cjs"

# Phase 53 POLISH-05: hydration hook for workflow runner Task() spawn sites.
# Honors GSD_HYDRATE_TASKS=off kill switch (default ON).
HYDRATE_CMD="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-tools.cjs agent-hydrate"

# Artifact paths — reference files agents Read at runtime
LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"
TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"
PRE_EXECUTION_CHECKLIST="/Users/luismogrovejo/.claude/get-shit-done/references/pre-execution-checklist.md"
```

---

## Fallback (if Read fails)

If the agent cannot Read this file for any reason, use these hardcoded fallback paths (mirroring the block above). Log a warning to D-phase output and continue.

```bash
# Fallback — used only if Read of cli-variables.md fails
CLI="node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs"        # fallback: core task CLI
RLM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-rlm.cjs"        # fallback: codebase search
MEM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs"     # fallback: memory/learning
RESEARCH="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-research.cjs"  # fallback: research chain
TOOLS="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-tools.cjs"    # fallback: routing/audit
SHUNT="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-shunt.cjs"    # fallback: cheap bulk-read / code-write worker
LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"  # fallback: D-phase template
TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"                # fallback: tag governance
PRE_EXECUTION_CHECKLIST="/Users/luismogrovejo/.claude/get-shit-done/references/pre-execution-checklist.md"  # fallback: E-phase mandate checklist
```

---

## Variable Reference

| Variable         | Binary                     | Usage                                              |
|------------------|----------------------------|----------------------------------------------------|
| `CLI`            | amauta.cjs                 | Task lifecycle (claim, rpetd, validate, close)     |
| `RLM`            | gsd-rlm.cjs                | Codebase search — find patterns, styles, usages    |
| `MEM`            | gsd-memory.cjs             | Memory queries, learnings, SKB promotion           |
| `RESEARCH`       | gsd-research.cjs           | Research chain (memory -> SKB -> Perplexity)       |
| `TOOLS`          | gsd-tools.cjs              | Routing, performance tiebreaker, audit utilities   |
| `HYDRATE_CMD`    | gsd-tools.cjs agent-hydrate | Phase 47 agent hydration hook for workflow Task() spawn sites. Invoked as `$HYDRATE_CMD "${AGENT_NAME}" --task-id "${TASK_ID:-}" --terse`. Kill switch: `GSD_HYDRATE_TASKS=off` disables (default ON). Returns `## Current context` markdown block. |
| `LEARNING_FORMAT`| references/learning-format.md | WHAT/WHY/WHEN/TAGS template (D-phase reference) |
| `TAG_RULES`      | config/tag-rules.json      | Banned tags, synonyms, vocabulary, tiers           |
| `PRE_EXECUTION_CHECKLIST` | references/pre-execution-checklist.md | E-phase query templates + security checklist (pre-exec mandate) |
| `SHUNT`          | gsd-shunt.cjs              | Cheap Haiku worker: `bulk-read` (understand large files) and `code-write` (pattern-following output) |

---

## Read routing (token discipline — applies to EVERY agent)

Pick the cheapest route that answers the need. Full reference: `get-shit-done/references/shunt.md`.

| Need | Route |
|---|---|
| A section you can already locate | `Read` with `offset`/`limit` (`Grep` first for the line number) |
| "Where does X live?" | `$RLM query "<what>" --paths <file>` — line ranges, no model cost |
| Understand one large file, or several at once (≳400 lines / 40 KB) | `$SHUNT bulk-read --question "<q>" --paths <file>...` → bullets with `path:line`; verify the lines with a targeted read before editing |
| Pattern-following output: tests mirroring a sibling test, config/type stubs, fixtures | `$SHUNT code-write --spec "<spec>" --reference <file> --target <file>` → writes to disk, returns the path; review the diff, then run the tests |

**Never shunt:** debugging, design decisions, security review, or anything safety-critical —
the worker lists locations and says "needs main-model review"; read those ranges yourself.
The file you are actively editing, and your own PLAN.md, are always read in full.

`GSD_SHUNT=on` makes the gate DENY an oversized whole-file read and name these routes; `warn`
only messages; `off` disables. A denied read is not an error — take the route it names.

---

## Agent Integration Pattern

At the start of the RPETD protocol, each agent Reads this file and pastes the shell block. Pattern:

```
1. Read /Users/luismogrovejo/.claude/get-shit-done/references/cli-variables.md
2. Copy the "Shell Variable Block" into the current bash session
3. If Read fails, use the "Fallback" block instead (and log the failure in D-phase)
```

This replaces the previously duplicated inline `CLI="node ..."` / `RLM="node ..."` / etc. blocks across 11 agent files and 6 workflow files.
