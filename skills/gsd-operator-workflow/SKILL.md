# Amauta Operator Workflow

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. RLM: find relevant project context
$RLM query "{task_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past operational learnings
$MEM search "{task_topic}" 2>/dev/null || true
```

## Task Tracking (if task ID provided)
```bash
$CLI claim TK-XXXX --agent operator 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior context injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [context gathered, relevant history]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [approach, coordination plan]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [actions taken, agents spawned]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [verification of outcomes]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [summary]. LEARNING: [operational insight]" 2>/dev/null || true
$MEM learn "{key_insight}" 2>/dev/null || true
```

## Rules
- Coordinate agents, don't execute directly — spawn specialists for code work
- Query memory before routing to find relevant prior context
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
