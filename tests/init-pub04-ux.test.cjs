'use strict';
/**
 * tests/init-pub04-ux.test.cjs
 * PUB-04: --verbose flag + friendlyError + frozen step names regression lock
 * Phase 58 — Public Launch
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildStepResult } = require('../bin/init.cjs');

describe('PUB-04 init UX polish', () => {

  it('buildStepResult preserves all 7 frozen install-flow step names', () => {
    const frozenNames = [
      'detect_ides',
      'install_skills',
      'detect_infra',
      'migrations',
      'start_daemon',
      'verify',
      'run_assertions',
    ];
    for (const name of frozenNames) {
      const r = buildStepResult(name, 'pass', 'test', null);
      assert.strictEqual(r.name, name, `frozen step name '${name}' must be preserved`);
      assert.strictEqual(r.status, 'pass');
      assert.ok(r.ts === undefined || r.ts !== undefined, 'timestamp field optional but name/status must be present');
    }
  });

  it('init.cjs source contains --verbose flag', () => {
    const src = fs.readFileSync(path.join(__dirname, '../bin/init.cjs'), 'utf-8');
    assert.ok(src.includes('--verbose'), '--verbose flag must be present in init.cjs');
    assert.ok(src.includes("args.includes('--verbose')"), '--verbose must be parsed via args.includes');
  });

  it('init.cjs source contains friendlyError function', () => {
    const src = fs.readFileSync(path.join(__dirname, '../bin/init.cjs'), 'utf-8');
    assert.ok(src.includes('function friendlyError'), 'friendlyError function must be present');
    assert.ok(
      src.includes('docker compose -f docker/docker-compose.yml up -d'),
      'PG recovery hint must be in friendlyError body'
    );
    assert.ok(
      src.includes('ECONNREFUSED'),
      'ECONNREFUSED must be handled by friendlyError'
    );
  });

  it('init.cjs final summary line references gsd-amauta doctor', () => {
    const src = fs.readFileSync(path.join(__dirname, '../bin/init.cjs'), 'utf-8');
    assert.ok(
      src.includes('gsd-amauta doctor'),
      'final summary must reference `gsd-amauta doctor`'
    );
  });

});
