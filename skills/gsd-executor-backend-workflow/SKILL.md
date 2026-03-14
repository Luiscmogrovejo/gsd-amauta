# Amauta Executor Workflow — Backend

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. RLM: find relevant existing code (targeted, not whole files)
$RLM query "{task_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past learnings (avoids repeating work)
$MEM search "{task_topic}" 2>/dev/null || true
```

## RPETD Protocol (log every phase)
```bash
$CLI claim TK-XXXX --agent executor-backend 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior failures, SKB context injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [RLM findings + memory matches]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [approach, files to change]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [what was done, files changed, branch name]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [paste actual test output — $ prompt or PASS/FAIL lines]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [summary]. LEARNING: [reusable insight]" 2>/dev/null || true
$MEM learn "{key_insight}" 2>/dev/null || true
```

## Rules
- Never validate your own work — return to operator after D-phase
- Use Write tool for files, never `Bash(cat << EOF)`
- Commit each task atomically with meaningful message
- RLM gives targeted chunks, not whole files — token-efficient by design
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
