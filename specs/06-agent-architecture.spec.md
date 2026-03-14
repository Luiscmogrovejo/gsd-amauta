# SPEC-06: Agent Architecture

## Overview
11 specialist agents with distinct roles, tool sets, and 20 agentic AI patterns. Each agent has a matching skill (SKILL.md) that provides RPETD protocols and CLI tool integration.

## Requirements

### AGT-1: Agent Roster (11 agents)
| Agent | Role | Lane | Tools |
|-------|------|------|-------|
| gsd-operator | Master orchestrator | non-code | Bash Read Write Edit Task Glob Grep |
| gsd-planner | Given/When/Then plans | non-code | Bash Read Write Edit Task Glob Grep |
| gsd-researcher | 4-mode research | non-code | Read Bash Grep Glob WebFetch |
| gsd-roadmapper | ROADMAP + milestones | non-code | Read Write Edit Bash Glob Grep |
| gsd-executor-backend | .py .sql .go .rs | code | Read Write Edit Bash Grep Glob |
| gsd-executor-frontend | .tsx .jsx .css .vue | code | Read Write Edit Bash Grep Glob |
| gsd-executor-infra | Docker CI/CD k8s | code | Read Write Edit Bash Grep Glob |
| gsd-executor-general | Everything else | code | Read Write Edit Bash Grep Glob |
| gsd-checker | Pre/post quality | non-code | Read Bash Grep Glob |
| gsd-validator | External validation | non-code | Read Bash Grep Glob |
| gsd-debugger | Root cause + bisect | code | Read Write Edit Bash Grep Glob |

### AGT-2: CLI Variable Contract
Every agent body defines these 4 variables:
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"
```
Exception: gsd-validator.md omits RLM= (validators don't query code).

### AGT-3: Claim + Show Protocol
Every agent (except gsd-validator) claims its task and reads back Layer 1 enrichment:
```bash
$CLI claim TK-XXXX --agent <agent-name> 2>/dev/null || true
$CLI show TK-XXXX 2>/dev/null || true
```
Validator intentionally does NOT claim (observers, not participants).

### AGT-4: RPETD Protocol
Every agent logs RPETD phases via `$CLI rpetd TK-XXXX --phase R/P/E/T/D --content "..."`.
All 11 skills have full 5-phase RPETD templates.

### AGT-5: Research Chain Integration
Every agent has `RESEARCH=` variable and every skill calls `$RESEARCH search` in its context pipeline. This gives all agents access to current information via Perplexity/WebFetch.

### AGT-6: Agent Classification (CODE_AGENTS vs NON_CODE_AGENTS)
Module-level constants in amauta.py determine:
- Code agents: require PR gate (Gate 4), branch gate (Gate 1), test gate (Gate 3)
- Non-code agents: skip PR and branch gates
- gsd-debugger is in CODE_AGENTS (writes bug-fix code)
- Both `_infer_lane()` and `_needs_gitflow_gate()` use the same constants

### AGT-7: Skill-Agent Mapping
Each agent has a `skills:` frontmatter field pointing to its skill directory:
- `gsd-executor-backend` → `skills/gsd-executor-backend-workflow/SKILL.md`
- Pattern: `skills/{agent-name}-workflow/SKILL.md`
- Skills are installed by Claude Code; embedded in agent body for non-Claude runtimes

### AGT-8: Memory Integration
All agents have `memory: user` in frontmatter.
All agents store learnings via `$MEM learn` after completing work.
