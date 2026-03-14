# Amauta Checker Workflow

## Context Pipeline (run BEFORE reviewing)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. RLM: find relevant code and patterns to review against
$RLM query "{plan_topic}" --dir . --top-k 5 --compact 2>/dev/null || true

# 2. Memory: find past review findings for this domain
$MEM search "{plan_topic}" 2>/dev/null || true
```

## Review Protocol
```bash
# Claim the checker task and read back Layer 1 enrichment
$CLI claim TK-XXXX --agent checker 2>/dev/null || true
$CLI show TK-XXXX 2>/dev/null || true

# Log findings to RPETD (if checker task assigned)
$CLI rpetd TK-XXXX --phase R --content "R: [RLM findings, plan analysis, risk areas]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [review approach, criteria applied]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [issues found, recommendations made]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [verification that suggestions are actionable]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [review summary]. LEARNING: [common issue to watch for]" 2>/dev/null || true
$MEM learn "{review_finding}" 2>/dev/null || true
```

## Rules
- Never approve your own work — review is always independent
- Query memory for known pitfalls before reviewing
- All amauta/memory commands wrapped in `|| true` — never block on service unavailability
