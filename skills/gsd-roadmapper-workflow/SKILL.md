# Amauta Roadmapper Workflow

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

# 1. RLM: find existing roadmap and architecture context
$RLM query "{roadmap_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past roadmapping learnings and cross-project patterns
$MEM search "{roadmap_topic}" 2>/dev/null || true
$MEM cross-project "{roadmap_topic}" --limit 5 2>/dev/null || true
```

## Task Tracking (if task ID provided)
```bash
$CLI claim TK-XXXX --agent roadmapper 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior roadmaps injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [requirements gathered, constraints identified]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [phase structure approach, milestone groupings]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [ROADMAP.md created, phases defined]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [roadmap validated against requirements]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [roadmap summary]. LEARNING: [phasing insight for similar projects]" 2>/dev/null || true
$MEM learn "{roadmap_insight}" 2>/dev/null || true
```

## Rules
- Check cross-project memory for similar project structures before planning phases
- Store milestone-sizing and phase-grouping insights for future roadmaps
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
