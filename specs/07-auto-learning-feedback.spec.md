# SPEC-07: Auto-Learning Feedback Loop

## Overview
Agents improve over time by tracking task outcomes. When validation passes or fails, the system records WHY and injects that history into future task enrichment. This creates a feedback loop where agents learn from past mistakes without human intervention.

## Architecture

```
  Agent completes task → Validator judges → PASS/FAIL recorded
                                                    │
                                                    ▼
                                          gsd_agent_performance (PG)
                                          ┌─────────────────────────┐
                                          │ agent_id, task_type,    │
                                          │ outcome, failure_reason,│
                                          │ gate_failed, duration   │
                                          └───────────┬─────────────┘
                                                      │
                              Future task claim ◄─────┘
                                     │
                                     ▼
                          Layer 1 enrichment injects:
                          "gsd-executor-backend: 87% pass rate.
                           Common failures: missing test evidence (3x),
                           no PR URL (2x). Last failure: forgot to run
                           pytest after changing models.py"
```

## Requirements

### ALF-1: Performance Tracking Table
```sql
CREATE TABLE IF NOT EXISTS gsd_agent_performance (
    id SERIAL PRIMARY KEY,
    agent_id VARCHAR(64) NOT NULL,
    task_id VARCHAR(32) NOT NULL,
    task_type VARCHAR(32),
    project_id VARCHAR(128),
    outcome VARCHAR(16) NOT NULL,  -- 'pass' or 'fail'
    gate_failed VARCHAR(32),       -- which gate blocked (NULL if pass)
    failure_reason TEXT,           -- validator notes on failure
    duration_minutes INTEGER,      -- time from claim to validate
    learning_captured TEXT,        -- LEARNING block extracted
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### ALF-2: Recording Outcomes
On every `validate --pass` or `validate --fail`:
- Extract agent_id from task's `claimed_by` field
- Calculate duration from `claimed_at` to now
- Extract gate_failed from validation gate failure message
- Store to gsd_agent_performance via pg_store.py

### ALF-3: Performance Summary Query
`pg_store.agent_performance_summary(agent_id)` returns:
```json
{
  "agent_id": "gsd-executor-backend",
  "total_tasks": 47,
  "pass_count": 41,
  "fail_count": 6,
  "pass_rate": 0.872,
  "common_failures": [
    {"gate_failed": "TEST_EVIDENCE", "count": 3},
    {"gate_failed": "PR_URL", "count": 2},
    {"gate_failed": "LEARNING_BLOCK", "count": 1}
  ],
  "recent_failures": [
    {"task_id": "TK-0042", "failure_reason": "Missing pytest output", "hours_ago": 2.0}
  ],
  "avg_duration_minutes": 23
}
```

### ALF-4: Enrichment Injection
During `cmd_claim` Layer 1 enrichment (`_enrich_task_context`):
- Query `agent_performance_summary` for the claiming agent
- If pass_rate < 1.0, inject failure patterns:
  ```
  [AGENT PERFORMANCE] gsd-executor-backend: 87% pass rate (41/47).
  Common issues: TEST_EVIDENCE (3x), PR_URL (2x).
  Last failure: TK-0042 — "Missing pytest output after model changes."
  TIP: Always run test suite and paste raw output into T-phase.
  ```
- If pass_rate == 1.0, inject confidence note:
  ```
  [AGENT PERFORMANCE] gsd-executor-backend: 100% pass rate (12/12). Keep it up.
  ```

### ALF-5: Graceful Degradation
- No PG: performance tracking silently skipped (no file fallback needed — this is analytics)
- Empty history: no performance section injected (first-time agents get no history)
- Table missing: pg_store methods return None/empty (never crash)
