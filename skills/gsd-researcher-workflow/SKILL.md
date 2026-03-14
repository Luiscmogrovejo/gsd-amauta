# Amauta Researcher Workflow

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. RLM: find existing research and documentation
$RLM query "{research_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past research findings and cross-project learnings
$MEM search "{research_topic}" 2>/dev/null || true
$MEM cross-project "{research_topic}" --limit 5 2>/dev/null || true
```

## Task Tracking (if task ID provided)
```bash
$CLI claim TK-XXXX --agent researcher 2>/dev/null || true
# Read back Layer 1 enrichment (deps, siblings, prior research injected at claim)
$CLI show TK-XXXX 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [memory search results, prior findings, knowledge gaps]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [research approach, sources to investigate]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [research conducted, findings, sources]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [findings verified, contradictions resolved]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [research summary]. LEARNING: [key finding for future tasks]" 2>/dev/null || true
$MEM learn "{key_research_finding}" 2>/dev/null || true
```

## Rules
- Always check cross-project memory before starting — avoid duplicating prior research
- Store research findings so future agents don't repeat the work
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
