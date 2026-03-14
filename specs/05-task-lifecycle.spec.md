# SPEC-05: Task Lifecycle

## Overview
Tasks flow through a managed lifecycle: creation, assignment, claim, RPETD phases, validation, and completion. All state persists in tasks.json (primary) with PG dual-write mirror.

## Requirements

### TLC-1: Task Types and IDs
- Epic: `EP-XXXX` — top-level project grouping
- Story: `ST-XXXX` — phase-level grouping (parent must be Epic)
- Task: `TK-XXXX` — atomic work unit (parent must be Story or Epic)
- Bug: `BG-XXXX` — defect report (parent must be Story or Epic)

### TLC-2: Task States
```
pending → in-progress → validation → done
                ↓              ↓
            deferred        failed (→ sub-tasks → pending)
```

### TLC-3: Priority Scoring
`score = importance * 0.4 + urgency * 0.3 + dep_pressure * 0.3`
- importance: 1-5 (business value)
- urgency: 1-5 (time sensitivity)
- dep_pressure: count of blocked downstream tasks

### TLC-4: Agent Routing
- `amauta next <agent>` returns highest-priority pending task for that agent
- File-pattern routing: `.tsx/.jsx` → executor-frontend, `.py/.sql` → executor-backend, etc.

### TLC-5: Claim Enrichment (Layer 1)
When an agent claims a task, `cmd_claim` injects:
- Dependency context (parent task details, sibling task status)
- PG memory search results for the task topic
- SKB policies and best practices
- Prior learnings from related tasks
- Enrichment is printed to stdout AND saved as a task note

### TLC-6: Dual-Write Storage
- Primary: `data/tasks.json` with atomic file locking
- Mirror: `gsd_tasks` PG table via daemon dual-write (best-effort)
- Daemon mirrors after: add, claim, rpetd, status, validate, assign, note, update, delete, link, unlink, atomize

### TLC-7: Deduplication
- On `add`, amauta.py checks title similarity against existing tasks for same agent
- Prevents creating duplicate tasks from repeated agent spawns
