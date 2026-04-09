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

# Artifact paths — reference files agents Read at runtime
LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"
TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"
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
LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"  # fallback: D-phase template
TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"                # fallback: tag governance
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
| `LEARNING_FORMAT`| references/learning-format.md | WHAT/WHY/WHEN/TAGS template (D-phase reference) |
| `TAG_RULES`      | config/tag-rules.json      | Banned tags, synonyms, vocabulary, tiers           |

---

## Agent Integration Pattern

At the start of the RPETD protocol, each agent Reads this file and pastes the shell block. Pattern:

```
1. Read /Users/luismogrovejo/.claude/get-shit-done/references/cli-variables.md
2. Copy the "Shell Variable Block" into the current bash session
3. If Read fails, use the "Fallback" block instead (and log the failure in D-phase)
```

This replaces the previously duplicated inline `CLI="node ..."` / `RLM="node ..."` / etc. blocks across 11 agent files and 6 workflow files.
