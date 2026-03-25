#!/usr/bin/env node
/**
 * Plan 17-03: Full Field Sync + Reconcile Command Tests
 * Structural tests verifying migration 007, task_upsert field mapping,
 * and cmd_reconcile function + argparse wiring.
 *
 * Tests:
 *   1. Migration 007 SQL adds all 7 columns (parse check)
 *   2. DOWN migration drops all 7 columns (grep check)
 *   3. task_upsert INSERT includes all 7 new fields (grep pg_store.py)
 *   4. task_upsert ON CONFLICT UPDATE includes all 7 new fields (grep pg_store.py)
 *   5. task_upsert parameter dict maps all 7 fields (grep pg_store.py)
 *   6. cmd_reconcile function exists in amauta.py (AST check)
 *   7. reconcile argparser includes --fix flag (grep check)
 *   8. reconcile dispatch entry exists in main() (grep check)
 *   9. All 7 field names appear in reconcile compare_fields list (grep check)
 *  10. Migration column types are correct (JSONB, REAL, VARCHAR)
 *  11. JSONB columns default to empty array (parse check)
 *  12. reconcile uses PGStore for --fix mode (grep check)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const PG_STORE_PY = path.join(ROOT, 'services', 'pg_store.py');
const MIG_UP = path.join(ROOT, 'migrations', '007-task-fields.sql');
const MIG_DOWN = path.join(ROOT, 'migrations', '007-task-fields-DOWN.sql');

const AMAUTA_SRC = fs.readFileSync(AMAUTA_PY, 'utf-8');
const PG_STORE_SRC = fs.readFileSync(PG_STORE_PY, 'utf-8');
const MIG_UP_SRC = fs.readFileSync(MIG_UP, 'utf-8');
const MIG_DOWN_SRC = fs.readFileSync(MIG_DOWN, 'utf-8');

const SEVEN_FIELDS = [
  'doc_refs', 'risks', 'validation_checklist',
  'estimated_hours', 'due_date', 'sprint', 'children',
];

function pyExec(code) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

describe('Migration 007 (TASK-06)', () => {
  it('UP migration adds all 7 columns with ADD COLUMN IF NOT EXISTS', () => {
    for (const field of SEVEN_FIELDS) {
      const pattern = `ADD COLUMN IF NOT EXISTS ${field}`;
      assert.ok(
        MIG_UP_SRC.includes(pattern),
        `Migration 007 missing: ${pattern}`
      );
    }
  });

  it('DOWN migration drops all 7 columns', () => {
    for (const field of SEVEN_FIELDS) {
      const pattern = `DROP COLUMN IF EXISTS ${field}`;
      assert.ok(
        MIG_DOWN_SRC.includes(pattern),
        `DOWN migration missing: ${pattern}`
      );
    }
  });

  it('JSONB columns default to empty array', () => {
    const jsonbFields = ['doc_refs', 'risks', 'validation_checklist', 'children'];
    for (const field of jsonbFields) {
      // Find the line for this field and check it has JSONB DEFAULT '[]'::jsonb
      const regex = new RegExp(`${field}\\s+JSONB\\s+DEFAULT\\s+'\\[\\]'::jsonb`, 'i');
      assert.ok(
        regex.test(MIG_UP_SRC),
        `${field} should be JSONB DEFAULT '[]'::jsonb`
      );
    }
  });

  it('estimated_hours is REAL type', () => {
    assert.ok(
      /estimated_hours\s+REAL/i.test(MIG_UP_SRC),
      'estimated_hours should be REAL type'
    );
  });

  it('due_date is VARCHAR(32)', () => {
    assert.ok(
      /due_date\s+VARCHAR\(32\)/i.test(MIG_UP_SRC),
      'due_date should be VARCHAR(32)'
    );
  });

  it('sprint is VARCHAR(64)', () => {
    assert.ok(
      /sprint\s+VARCHAR\(64\)/i.test(MIG_UP_SRC),
      'sprint should be VARCHAR(64)'
    );
  });
});

describe('task_upsert full field sync (TASK-06)', () => {
  // Extract just the task_upsert function text
  const upsertStart = PG_STORE_SRC.indexOf('def task_upsert(self, item)');
  const upsertEnd = PG_STORE_SRC.indexOf('def task_upsert_batch', upsertStart);
  const upsertSrc = PG_STORE_SRC.substring(upsertStart, upsertEnd);

  it('INSERT column list includes all 7 new fields', () => {
    // The INSERT INTO ... (...) section
    const insertMatch = upsertSrc.match(/INSERT INTO gsd_tasks \(([\s\S]*?)\) VALUES/);
    assert.ok(insertMatch, 'Could not find INSERT INTO ... VALUES pattern');
    const insertCols = insertMatch[1];
    for (const field of SEVEN_FIELDS) {
      assert.ok(
        insertCols.includes(field),
        `INSERT column list missing: ${field}`
      );
    }
  });

  it('VALUES clause includes all 7 new field parameters', () => {
    const valuesMatch = upsertSrc.match(/VALUES \(([\s\S]*?)\)\s*ON CONFLICT/);
    assert.ok(valuesMatch, 'Could not find VALUES (...) ON CONFLICT pattern');
    const valuesCols = valuesMatch[1];
    for (const field of SEVEN_FIELDS) {
      const param = `%(${field})s`;
      assert.ok(
        valuesCols.includes(param),
        `VALUES missing parameter: ${param}`
      );
    }
  });

  it('ON CONFLICT UPDATE includes all 7 new fields', () => {
    const conflictMatch = upsertSrc.match(/ON CONFLICT \(id\) DO UPDATE SET([\s\S]*?)"""/);
    assert.ok(conflictMatch, 'Could not find ON CONFLICT ... DO UPDATE SET pattern');
    const updateSet = conflictMatch[1];
    for (const field of SEVEN_FIELDS) {
      const pattern = `${field} = EXCLUDED.${field}`;
      assert.ok(
        updateSet.includes(pattern),
        `ON CONFLICT UPDATE missing: ${pattern}`
      );
    }
  });

  it('parameter dict maps all 7 fields', () => {
    // Extract everything after the triple-quote + comma (params dict) up to return
    const paramsStart = upsertSrc.indexOf('""", {');
    const paramsEnd = upsertSrc.indexOf('return item["id"]', paramsStart);
    assert.ok(paramsStart > 0 && paramsEnd > paramsStart, 'Could not find params dict region');
    const paramsBlock = upsertSrc.substring(paramsStart, paramsEnd);
    for (const field of SEVEN_FIELDS) {
      assert.ok(
        paramsBlock.includes(`"${field}"`),
        `Params dict missing key: "${field}"`
      );
    }
  });

  it('JSONB fields use json.dumps in params', () => {
    const jsonbFields = ['doc_refs', 'risks', 'validation_checklist', 'children'];
    const paramsStart = upsertSrc.indexOf('""", {');
    const paramsEnd = upsertSrc.indexOf('return item["id"]', paramsStart);
    const paramsBlock = upsertSrc.substring(paramsStart, paramsEnd);
    for (const field of jsonbFields) {
      const pattern = `json.dumps(item.get("${field}"`;
      assert.ok(
        paramsBlock.includes(pattern),
        `${field} should use json.dumps() in params`
      );
    }
  });
});

describe('cmd_reconcile (TASK-05)', () => {
  it('cmd_reconcile function is defined in amauta.py (AST check)', () => {
    const out = pyExec(`
import ast
with open('${AMAUTA_PY}') as f:
    tree = ast.parse(f.read())
funcs = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
print('OK' if 'cmd_reconcile' in funcs else 'MISSING')
    `);
    assert.equal(out, 'OK');
  });

  it('reconcile argparser is registered with --fix flag', () => {
    assert.ok(
      AMAUTA_SRC.includes('sub.add_parser("reconcile"'),
      'reconcile subparser not registered'
    );
    assert.ok(
      AMAUTA_SRC.includes('"--fix"'),
      '--fix argument not defined'
    );
  });

  it('reconcile is in the dispatch dict', () => {
    assert.ok(
      AMAUTA_SRC.includes('"reconcile":'),
      'reconcile missing from dispatch dict'
    );
    assert.ok(
      AMAUTA_SRC.includes('cmd_reconcile'),
      'cmd_reconcile not referenced in dispatch'
    );
  });

  it('compare_fields list includes all 7 new fields', () => {
    // Extract the cmd_reconcile function
    const reconcileStart = AMAUTA_SRC.indexOf('def cmd_reconcile(args)');
    const reconcileEnd = AMAUTA_SRC.indexOf('\ndef cmd_archive(args)', reconcileStart);
    const reconcileSrc = AMAUTA_SRC.substring(reconcileStart, reconcileEnd);

    // Find compare_fields list
    assert.ok(
      reconcileSrc.includes('compare_fields'),
      'compare_fields not found in cmd_reconcile'
    );

    for (const field of SEVEN_FIELDS) {
      assert.ok(
        reconcileSrc.includes(`"${field}"`),
        `compare_fields missing: ${field}`
      );
    }
  });

  it('reconcile uses PGStore for fix mode', () => {
    const reconcileStart = AMAUTA_SRC.indexOf('def cmd_reconcile(args)');
    const reconcileEnd = AMAUTA_SRC.indexOf('\ndef cmd_archive(args)', reconcileStart);
    const reconcileSrc = AMAUTA_SRC.substring(reconcileStart, reconcileEnd);

    assert.ok(
      reconcileSrc.includes('from pg_store import PGStore'),
      'fix mode should import PGStore'
    );
    assert.ok(
      reconcileSrc.includes('store.task_upsert(item)'),
      'fix mode should call store.task_upsert()'
    );
  });

  it('reconcile default is dry-run (no --fix required for report)', () => {
    const reconcileStart = AMAUTA_SRC.indexOf('def cmd_reconcile(args)');
    const reconcileEnd = AMAUTA_SRC.indexOf('\ndef cmd_archive(args)', reconcileStart);
    const reconcileSrc = AMAUTA_SRC.substring(reconcileStart, reconcileEnd);

    // fix should be checked via getattr with False default
    assert.ok(
      reconcileSrc.includes('getattr(args, "fix", False)'),
      'default behavior should be dry-run (fix=False)'
    );
  });
});
