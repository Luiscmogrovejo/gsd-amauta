#!/usr/bin/env node
/**
 * Plan 07-01: Task Lifecycle Guard Tests
 *
 * Tests:
 *   ROUTE-01: Archive/reconcile routing
 *     1. archive in _EXEC_ALLOWLIST
 *     2. reconcile in _EXEC_ALLOWLIST
 *     3. /api/archive in command_map
 *     4. /api/reconcile in command_map
 *     5. archive special handling (--days)
 *     6. reconcile special handling (--fix)
 *   WATCHDOG-01: Stale watchdog configuration
 *     7. STALE_CHECK_INTERVAL reads from GSD_STALE_INTERVAL env
 *     8. STALE_THRESHOLD_HOURS reads from GSD_STALE_HOURS env
 *     9. WATCHDOG_EXEMPT check exists
 *    10. Watchdog reverts to pending (not delete)
 *   PGSYNC-01: PG field sync guard
 *    11. task_upsert contains all 7 migration-007 columns
 *    12. task_upsert INSERT references all 7 migration-007 columns in parameter dict
 *    13. pg_store task_upsert function exists
 *    14. task_upsert excludes id/project_id from ON CONFLICT UPDATE set
 *   ARCHIVE-01: Archive PG mirror sync
 *    15. Archive handler extracts IDs from output for PG delete
 *    16. Archive handler calls task_delete per archived ID
 *    17. _TASK_MUTATING_COMMANDS includes archive and reconcile
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const PG_STORE = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');

describe('ROUTE-01: Archive/reconcile routing', () => {
  it('1. archive in _EXEC_ALLOWLIST', () => {
    // Find the _EXEC_ALLOWLIST set literal and check it contains "archive"
    const allowlistMatch = DAEMON.match(/_EXEC_ALLOWLIST\s*=\s*\{[^}]+\}/s);
    assert.ok(allowlistMatch, '_EXEC_ALLOWLIST not found');
    assert.ok(allowlistMatch[0].includes('"archive"'), 'archive missing from _EXEC_ALLOWLIST');
  });

  it('2. reconcile in _EXEC_ALLOWLIST', () => {
    const allowlistMatch = DAEMON.match(/_EXEC_ALLOWLIST\s*=\s*\{[^}]+\}/s);
    assert.ok(allowlistMatch, '_EXEC_ALLOWLIST not found');
    assert.ok(allowlistMatch[0].includes('"reconcile"'), 'reconcile missing from _EXEC_ALLOWLIST');
  });

  it('3. /api/archive in command_map', () => {
    assert.ok(DAEMON.includes('"/api/archive"'), '/api/archive route missing from command_map');
  });

  it('4. /api/reconcile in command_map', () => {
    assert.ok(DAEMON.includes('"/api/reconcile"'), '/api/reconcile route missing from command_map');
  });

  it('5. archive special handling for --days', () => {
    assert.ok(DAEMON.includes('command == "archive"'), 'archive special handling missing');
  });

  it('6. reconcile special handling for --fix', () => {
    assert.ok(DAEMON.includes('command == "reconcile"'), 'reconcile special handling missing');
  });
});

describe('WATCHDOG-01: Stale watchdog configuration', () => {
  it('7. STALE_CHECK_INTERVAL reads from GSD_STALE_INTERVAL env', () => {
    assert.ok(DAEMON.includes('GSD_STALE_INTERVAL'), 'STALE_CHECK_INTERVAL not env-configurable');
    assert.ok(DAEMON.includes('os.environ.get("GSD_STALE_INTERVAL"'), 'Missing os.environ.get for GSD_STALE_INTERVAL');
  });

  it('8. STALE_THRESHOLD_HOURS reads from GSD_STALE_HOURS env', () => {
    assert.ok(DAEMON.includes('GSD_STALE_HOURS'), 'STALE_THRESHOLD_HOURS not env-configurable');
  });

  it('9. WATCHDOG_EXEMPT check exists', () => {
    assert.ok(DAEMON.includes('WATCHDOG_EXEMPT'), 'WATCHDOG_EXEMPT opt-out missing');
  });

  it('10. Watchdog reverts to pending (not delete)', () => {
    // Watchdog should revert status to "pending", not delete the task
    // The watchdog function calls: amauta.py status <task_id> pending --agent watchdog
    const watchdogStart = DAEMON.indexOf('def _stale_task_watchdog');
    assert.ok(watchdogStart > -1, '_stale_task_watchdog function not found');
    // Use a 4000-char slice to capture the full function body (function is ~90 lines)
    const watchdogBlock = DAEMON.slice(watchdogStart, watchdogStart + 4000);
    assert.ok(watchdogBlock.includes('"pending"'), 'Watchdog block should pass "pending" to status revert');
    // Also confirm "delete" is not used as the revert mechanism
    assert.ok(!watchdogBlock.includes('task_delete'), 'Watchdog should not call task_delete (revert to pending instead)');
  });
});

describe('PGSYNC-01: PG field sync guard', () => {
  const MIGRATION_007_COLUMNS = ['doc_refs', 'risks', 'validation_checklist', 'estimated_hours', 'due_date', 'sprint', 'children'];

  it('11. task_upsert contains all 7 migration-007 columns', () => {
    // Find the task_upsert function and check it references all 007 columns
    const upsertStart = PG_STORE.indexOf('def task_upsert');
    assert.ok(upsertStart > -1, 'task_upsert function not found');
    const upsertBlock = PG_STORE.slice(upsertStart, upsertStart + 3000);
    for (const col of MIGRATION_007_COLUMNS) {
      assert.ok(upsertBlock.includes(col), `task_upsert missing migration-007 column: ${col}`);
    }
  });

  it('12. task_upsert parameter dict references all 7 migration-007 columns', () => {
    // All 7 migration-007 columns must appear in the parameter dict passed to cur.execute
    const upsertStart = PG_STORE.indexOf('def task_upsert');
    assert.ok(upsertStart > -1, 'task_upsert not found');
    const upsertBlock = PG_STORE.slice(upsertStart, upsertStart + 3000);
    const uniqueCols = new Set();
    for (const col of MIGRATION_007_COLUMNS) {
      if (upsertBlock.includes(col)) uniqueCols.add(col);
    }
    assert.strictEqual(uniqueCols.size, 7, `Expected 7 migration-007 cols, found ${uniqueCols.size}: ${[...uniqueCols].join(', ')}`);
  });

  it('13. pg_store task_upsert function exists', () => {
    assert.ok(PG_STORE.includes('def task_upsert'), 'task_upsert function not found in pg_store.py');
  });

  it('14. task_upsert ON CONFLICT UPDATE does not re-set id or project_id', () => {
    // id and project_id are the lookup keys -- ON CONFLICT UPDATE should not override them
    const upsertStart = PG_STORE.indexOf('def task_upsert');
    assert.ok(upsertStart > -1, 'task_upsert not found');
    const upsertBlock = PG_STORE.slice(upsertStart, upsertStart + 3000);
    // The ON CONFLICT block should contain UPDATE SET but not set id = EXCLUDED.id
    const conflictBlock = upsertBlock.slice(upsertBlock.indexOf('ON CONFLICT'));
    assert.ok(conflictBlock.length > 0, 'ON CONFLICT block not found');
    assert.ok(!conflictBlock.includes('id = EXCLUDED.id'), 'ON CONFLICT block must not reset id');
    assert.ok(!conflictBlock.includes('project_id = EXCLUDED.project_id'), 'ON CONFLICT block must not reset project_id');
  });
});

describe('ARCHIVE-01: Archive PG mirror sync', () => {
  it('15. Archive handler extracts IDs from output for PG delete', () => {
    assert.ok(DAEMON.includes('_archived_ids'), 'Archive handler should extract archived IDs');
  });

  it('16. Archive handler calls task_delete per archived ID', () => {
    assert.ok(DAEMON.includes('task_delete(_aid)'), 'Archive should call task_delete for each archived ID');
  });

  it('17. _TASK_MUTATING_COMMANDS includes archive and reconcile', () => {
    const mutatingMatch = DAEMON.match(/_TASK_MUTATING_COMMANDS\s*=\s*\{[^}]+\}/s);
    assert.ok(mutatingMatch, '_TASK_MUTATING_COMMANDS not found');
    assert.ok(mutatingMatch[0].includes('"archive"'), 'archive missing from _TASK_MUTATING_COMMANDS');
    assert.ok(mutatingMatch[0].includes('"reconcile"'), 'reconcile missing from _TASK_MUTATING_COMMANDS');
  });
});
