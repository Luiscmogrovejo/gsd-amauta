# GSD Executor Workflow

## Context Pipeline (run BEFORE any work)
```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
$RLM query "{task_topic}" --dir . --top-k 5 --compact 2>/dev/null || true
$MEM search "{task_topic}" 2>/dev/null || true
```

## RPETD (log every phase)
```bash
$CLI claim TK-XXXX --agent {agent_name} 2>/dev/null || true
$CLI rpetd TK-XXXX --phase R --content "R: [findings]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase P --content "P: [approach]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase E --content "E: [built, branch]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase T --content "T: [test output]" 2>/dev/null || true
$CLI rpetd TK-XXXX --phase D --content "D: [summary]. LEARNING: [insight]" 2>/dev/null || true
$MEM learn "{insight}" 2>/dev/null || true
```

## Rules: Never validate own work. Use Write tool. Commit atomically. All || true.
