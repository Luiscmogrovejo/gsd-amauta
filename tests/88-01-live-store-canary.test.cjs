/**
 * Phase 88 plan 88-01: the live-store canary detects a change to a watched target.
 *
 * Everything here runs against a temporary tree: the canary is pointed away from
 * the operator's real store with _setLiveCheckoutForTest / _setTargetsForTest.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const canary = require(path.join(__dirname, 'support', 'live-store-canary.cjs'));

describe('live-store canary', () => {
  let dir;
  let tasks;
  let pid;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.mkdirSync(path.join(dir, 'services'));
    tasks = path.join(dir, 'data', 'tasks.json');
    pid = path.join(dir, 'services', 'amauta-daemon.pid');
    fs.writeFileSync(tasks, '{"items":[]}');
    fs.writeFileSync(pid, '123');
    canary._setLiveCheckoutForTest(dir);
    canary._setTargetsForTest([tasks, pid, path.join(dir, 'data') + '/']);
  });

  afterEach(() => {
    canary._setLiveCheckoutForTest(null);
    canary._setTargetsForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a no-op round trip returns zero findings', () => {
    assert.strictEqual(canary.diff(canary.snapshot(), canary.snapshot()).length, 0);
  });

  test('one written byte yields exactly one finding for that path', () => {
    const before = canary.snapshot();
    fs.appendFileSync(tasks, ' ');
    const findings = canary.diff(before, canary.snapshot());
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].path, tasks);
    assert.ok(canary.format(findings).startsWith('LIVE STORE CANARY'));
    assert.ok(canary.format(findings).includes(tasks));
  });

  test('an mtime-only change is not a finding', () => {
    const before = canary.snapshot();
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(tasks, t, t);
    assert.strictEqual(canary.diff(before, canary.snapshot()).length, 0);
  });

  test('a deleted pid file is reported as deleted', () => {
    const before = canary.snapshot();
    fs.unlinkSync(pid);
    const findings = canary.diff(before, canary.snapshot());
    assert.deepStrictEqual(findings, [{ path: pid, reason: 'deleted' }]);
  });

  test('a created file in a watched directory is a finding', () => {
    const before = canary.snapshot();
    fs.writeFileSync(path.join(dir, 'data', 'stray.json'), '{}');
    const findings = canary.diff(before, canary.snapshot());
    assert.deepStrictEqual(findings, [{ path: path.join(dir, 'data'), reason: 'content changed' }]);
  });

  test('default targets follow the live checkout, not the repo the module sits in', () => {
    canary._setTargetsForTest(null);
    const paths = Object.keys(canary.snapshot().paths);
    assert.ok(paths.includes(tasks), paths.join('\n'));
    assert.ok(paths.includes(pid), paths.join('\n'));
  });
});
