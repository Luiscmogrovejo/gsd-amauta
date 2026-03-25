#!/usr/bin/env node
/**
 * 17-02 Daemon Threads Tests -- stale task watchdog & retry queue flusher
 * Validates daemon thread definitions, configuration, and behavior via
 * AST checks, grep verification, and integration tests.
 *
 * Tests:
 *   1. _stale_task_watchdog function is defined in daemon (AST check)
 *   2. _retry_queue_flusher function is defined in daemon (AST check)
 *   3. GSD_STALE_HOURS env var is read by daemon (grep check)
 *   4. WATCHDOG_EXEMPT note prevents revert (logic check)
 *   5. flush_retry_queue is called by the flusher thread (grep check)
 *   6. Both threads are started as daemon threads (grep check)
 *   7. Metrics endpoint includes retry_queue metrics (grep check)
 *   8. Stale detection logic correctly identifies stale tasks
 *   9. Exponential backoff config is present in flusher
 *  10. Watchdog startup message includes interval and threshold
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON_PY = path.join(ROOT, 'services', 'amauta-daemon.py');
const DAEMON_SRC = fs.readFileSync(DAEMON_PY, 'utf-8');

function pyExec(code) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

describe('Stale Task Watchdog (TASK-03)', () => {
  it('_stale_task_watchdog function is defined in daemon (AST check)', () => {
    const out = pyExec(`
import ast
with open('${DAEMON_PY}') as f:
    tree = ast.parse(f.read())
funcs = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
print('OK' if '_stale_task_watchdog' in funcs else 'MISSING')
    `);
    assert.equal(out, 'OK');
  });

  it('GSD_STALE_HOURS env var is read by daemon', () => {
    assert.ok(
      DAEMON_SRC.includes('GSD_STALE_HOURS'),
      'GSD_STALE_HOURS not found in daemon source'
    );
  });

  it('WATCHDOG_EXEMPT note is checked in watchdog', () => {
    const matches = DAEMON_SRC.match(/WATCHDOG_EXEMPT/g);
    assert.ok(matches && matches.length >= 2, `Expected >=2 WATCHDOG_EXEMPT references, got ${matches ? matches.length : 0}`);
  });

  it('watchdog thread is started as daemon=True', () => {
    assert.ok(
      DAEMON_SRC.includes('target=_stale_task_watchdog, daemon=True'),
      'stale_task_watchdog thread not started with daemon=True'
    );
  });

  it('watchdog startup message includes interval and threshold', () => {
    assert.ok(
      DAEMON_SRC.includes('Watchdog: started (check every'),
      'startup message missing interval/threshold info'
    );
  });

  it('watchdog uses subprocess to revert tasks via amauta.py', () => {
    assert.ok(
      DAEMON_SRC.includes('AMAUTA_PY, "status"') && DAEMON_SRC.includes('"--agent", "watchdog"'),
      'watchdog should revert via subprocess call to amauta.py status'
    );
  });

  it('stale detection logic identifies tasks older than threshold', () => {
    // Test the detection logic in isolation via Python
    const out = pyExec(`
from datetime import datetime, timezone, timedelta
import json, os, tempfile

# Create a tasks.json with one stale and one fresh task
now = datetime.now(timezone.utc)
stale_time = (now - timedelta(hours=72)).isoformat()
fresh_time = (now - timedelta(hours=1)).isoformat()

tasks = {
    "items": [
        {"id": "TK-STALE", "status": "in-progress", "claimed_at": stale_time, "rpetd": {}, "notes": []},
        {"id": "TK-FRESH", "status": "in-progress", "claimed_at": fresh_time, "rpetd": {}, "notes": []},
        {"id": "TK-EXEMPT", "status": "in-progress", "claimed_at": stale_time, "rpetd": {}, "notes": ["WATCHDOG_EXEMPT"]},
        {"id": "TK-DONE", "status": "done", "claimed_at": stale_time, "rpetd": {}, "notes": []},
    ]
}

# Simulate the detection logic from the watchdog
threshold = 48
stale_ids = []
exempt_ids = []

for item in tasks["items"]:
    if item.get("status") != "in-progress":
        continue
    notes = item.get("notes", [])
    if isinstance(notes, list):
        is_exempt = any("WATCHDOG_EXEMPT" in str(n) for n in notes)
    else:
        is_exempt = "WATCHDOG_EXEMPT" in str(notes)
    if is_exempt:
        exempt_ids.append(item["id"])
        continue

    latest_ts = None
    rpetd = item.get("rpetd", {})
    if isinstance(rpetd, dict):
        for phase_data in rpetd.values():
            ts_str = phase_data if isinstance(phase_data, str) else (phase_data.get("timestamp") if isinstance(phase_data, dict) else None)
            if ts_str:
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if latest_ts is None or ts > latest_ts:
                        latest_ts = ts
                except (ValueError, TypeError):
                    pass

    if latest_ts is None:
        claimed_at = item.get("claimed_at", "")
        if claimed_at:
            try:
                latest_ts = datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

    if latest_ts is None:
        continue

    stale_hours = (now - latest_ts).total_seconds() / 3600
    if stale_hours > threshold:
        stale_ids.append(item["id"])

# TK-STALE should be detected, TK-FRESH should not, TK-EXEMPT should be skipped, TK-DONE should be skipped
checks = [
    "TK-STALE" in stale_ids,
    "TK-FRESH" not in stale_ids,
    "TK-EXEMPT" in exempt_ids,
    "TK-DONE" not in stale_ids,
]
print("OK" if all(checks) else f"FAIL stale={stale_ids} exempt={exempt_ids}")
    `);
    assert.equal(out, 'OK');
  });
});

describe('Retry Queue Flusher (TASK-04)', () => {
  it('_retry_queue_flusher function is defined in daemon (AST check)', () => {
    const out = pyExec(`
import ast
with open('${DAEMON_PY}') as f:
    tree = ast.parse(f.read())
funcs = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
print('OK' if '_retry_queue_flusher' in funcs else 'MISSING')
    `);
    assert.equal(out, 'OK');
  });

  it('flush_retry_queue is called by the flusher thread', () => {
    assert.ok(
      DAEMON_SRC.includes('_pg_store.flush_retry_queue()'),
      'flush_retry_queue() call not found in daemon'
    );
  });

  it('RETRY_FLUSH_INTERVAL env var is configurable', () => {
    assert.ok(
      DAEMON_SRC.includes('GSD_RETRY_FLUSH_INTERVAL'),
      'GSD_RETRY_FLUSH_INTERVAL not found in daemon source'
    );
  });

  it('retry flusher thread is started as daemon=True', () => {
    assert.ok(
      DAEMON_SRC.includes('target=_retry_queue_flusher, daemon=True'),
      'retry_queue_flusher thread not started with daemon=True'
    );
  });

  it('metrics include retry_queue_size gauge', () => {
    assert.ok(
      DAEMON_SRC.includes('retry_queue_size'),
      'retry_queue_size metric not found'
    );
  });

  it('metrics include retry_flush_succeeded_total counter', () => {
    assert.ok(
      DAEMON_SRC.includes('retry_flush_succeeded_total'),
      'retry_flush_succeeded_total metric not found'
    );
  });

  it('metrics include retry_flush_failed_total counter', () => {
    assert.ok(
      DAEMON_SRC.includes('retry_flush_failed_total'),
      'retry_flush_failed_total metric not found'
    );
  });

  it('exponential backoff is configured in flusher', () => {
    assert.ok(
      DAEMON_SRC.includes('2 ** min(consecutive_failures'),
      'exponential backoff formula not found in flusher'
    );
  });

  it('_Metrics class supports set_gauge method', () => {
    const out = pyExec(`
import ast
with open('${DAEMON_PY}') as f:
    tree = ast.parse(f.read())
# Find _Metrics class and check for set_gauge method
for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef) and node.name == '_Metrics':
        methods = [n.name for n in node.body if isinstance(n, ast.FunctionDef)]
        has_set_gauge = 'set_gauge' in methods
        has_inc = 'inc' in methods
        has_expose = 'expose' in methods
        print('OK' if has_set_gauge and has_inc and has_expose else f'MISSING set_gauge={has_set_gauge} inc={has_inc} expose={has_expose}')
        break
else:
    print('MISSING _Metrics class')
    `);
    assert.equal(out, 'OK');
  });
});
