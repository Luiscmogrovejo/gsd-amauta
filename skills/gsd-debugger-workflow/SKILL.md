# Amauta Debugger Workflow

## Context Pipeline (run BEFORE any work)

```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

# 1. RLM: find relevant existing code around the bug area
$RLM query "{bug_description}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past similar failures and fixes
$MEM search "{bug_description}" 2>/dev/null || true
```

## RPETD Protocol (Observe/Hypothesize/Fix/Verify/Learn)

```bash
$CLI claim TK-XXXX --agent debugger 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior failures, SKB context injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [Observe — symptoms, stack traces, RLM findings]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [Hypothesize — root cause, affected components]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [Fix — what was changed, files modified, branch name]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [Verify — paste actual test output confirming fix]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [summary]. LEARNING: [failure pattern to avoid in future]" 2>/dev/null || true
$MEM learn "{failure_pattern}" --source lesson-learned 2>/dev/null || true
```

## Rules
- Never validate your own work — return to operator after D-phase
- Store failure patterns with `lesson-learned` source for future agents
- RLM gives targeted chunks, not whole files — token-efficient by design
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
