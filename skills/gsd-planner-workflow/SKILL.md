# Amauta Planner Workflow

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. RLM: find existing patterns and architecture context
$RLM query "{planning_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past planning learnings and pitfalls
$MEM search "{planning_topic}" 2>/dev/null || true
```

## Task Tracking (if task ID provided)
```bash
$CLI claim TK-XXXX --agent planner 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior decisions injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [RLM findings, memory matches, codebase analysis]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [planning approach, phase structure, risks]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [plans created, PLAN.md files written]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [plan review, checker findings addressed]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [summary]. LEARNING: [planning insight for future phases]" 2>/dev/null || true
$MEM learn "{key_planning_insight}" 2>/dev/null || true
```

## Rules
- Query memory for prior work on this topic before planning
- Store planning insights and pitfalls for future agents
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
