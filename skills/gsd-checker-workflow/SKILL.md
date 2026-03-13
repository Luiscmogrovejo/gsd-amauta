# GSD Agent Workflow

## Memory & Context
```bash
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
$MEM search "{topic}" 2>/dev/null || true
$RLM query "{topic}" --dir . --top-k 5 --compact 2>/dev/null || true
```

## Store learnings after completing work
```bash
$MEM learn "{key insight}" 2>/dev/null || true
```

## Rules: Always query memory before starting. Store learnings after finishing. All || true.
