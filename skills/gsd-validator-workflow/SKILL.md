# Amauta Validator Workflow

## Context Pipeline (run BEFORE validating)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

# 3. Research chain — current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
$RESEARCH search "{task_topic}" 2>/dev/null || true

# 1. Show full task (all 5 RPETD phases)
$CLI show TK-XXXX 2>/dev/null || true

# 2. Memory: find past validation patterns for this domain
$MEM search "{task_topic}" 2>/dev/null || true
```

## 4-Gate Validation Checklist
```
Gate 1 — Branch Evidence (E-phase): feat/*, fix/*, chore/*, refactor/* branch name visible
Gate 2 — LEARNING Block (D-phase or any phase): at least one LEARNING: statement present
Gate 3 — Test Evidence (T-phase): raw terminal output with $ prompt, PASS/FAIL, test counts
Gate 4 — PR URL (D-phase, E-phase, or notes): github.com/.../pull/NNN or "merged" or "PR #NNN"
         NOTE: branch name alone does NOT satisfy Gate 4 — a PR URL is required
```

## Validate Command
```bash
# Pass (all gates met):
$CLI validate TK-XXXX --pass --validator validator --notes "PASS: All 4 gates met." 2>/dev/null || true

# Fail (gate violation):
$CLI validate TK-XXXX --fail --validator validator --notes "FAIL: [gate] — [reason]." 2>/dev/null || true

# Force override (legitimate exceptions only):
$CLI validate TK-XXXX --pass --force --validator validator --notes "PASS: [reason for override]." 2>/dev/null || true
```

## Store learnings after validating
```bash
$MEM learn "{validation insight}" 2>/dev/null || true
```

## Rules
- Never validate your own work — you must be a different agent from the executor
- Gate 4 requires a PR URL, not just a branch name
- Use --force only for: local-only tasks, scaffolding, non-code tasks without PRs
- All commands wrapped in `|| true` — never block on service unavailability
