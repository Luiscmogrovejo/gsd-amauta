/**
 * Phase 88 plan 88-18 task 08: the per-task file-manifest gate.
 *
 * Plan 88-18 fixes the Python suite on macOS and Windows. The failing set did not exist when the
 * plan was written, so the files each task may edit were derived from the measured baseline and
 * frozen in `tests/88-18-file-manifest.json` (a tracked copy of `88-18-FILE-MANIFEST.json`, which
 * lives in the gitignored `.planning/` and cannot be read by CI).
 *
 * The gate walks every commit whose subject ends in `[88-18-0N]` and asserts that each file the
 * commit touched is in task N's OWN manifest entry. It is deliberately not a union check: a union
 * would let the ENCODING task quietly edit a PATHS file, which is the cross-bucket drift the
 * manifest exists to stop. An out-of-manifest edit is a scope_expansion divergence: stop and
 * report, do not widen the manifest afterwards.
 *
 * Nothing here connects to a port or starts a process other than `git`.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, '88-18-file-manifest.json');
const TAG = /\[(88-18-\d\d)\]\s*$/;
/** The bucket tasks whose per-task verdict line is printed, in plan order. */
const REPORTED = ['88-18-02', '88-18-03', '88-18-04', '88-18-05', '88-18-06', '88-18-07', '88-18-08'];

/**
 * Run git in the repository root.
 * @param {string[]} args git arguments
 * @returns {{status: number|null, stdout: string, error?: Error}}
 */
function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Collect the tagged commits of this plan from the current history.
 * @returns {{sha: string, task: string, subject: string, files: string[]}[]}
 */
function taggedCommits() {
  const log = git(['log', '--format=%H%x09%s']);
  assert.strictEqual(log.status, 0, 'git log failed: ' + (log.error || log.stdout));
  const out = [];
  for (const line of log.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const subject = line.slice(tab + 1);
    const m = TAG.exec(subject);
    if (!m) continue;
    const sha = line.slice(0, tab);
    const show = git(['show', '--name-only', '--format=', '--no-renames', sha]);
    assert.strictEqual(show.status, 0, 'git show failed for ' + sha);
    out.push({ sha, task: m[1], subject, files: show.stdout.split('\n').map((s) => s.trim()).filter(Boolean) });
  }
  return out;
}

/**
 * Check every tagged commit against its own task's manifest entry (never the union).
 * @param {{sha: string, task: string, files: string[]}[]} commits tagged commits
 * @param {{tasks: Object<string, string[]>}} manifest the manifest
 * @returns {{perTask: Object<string, {commits: number, files: string[], violations: {file: string, sha: string}[]}>, ok: boolean}}
 */
function evaluate(commits, manifest) {
  const perTask = {};
  for (const task of Object.keys(manifest.tasks)) perTask[task] = { commits: 0, files: [], violations: [] };
  for (const c of commits) {
    const entry = perTask[c.task] || (perTask[c.task] = { commits: 0, files: [], violations: [] });
    entry.commits += 1;
    const allowed = new Set(manifest.tasks[c.task] || []);
    for (const f of c.files) {
      if (!entry.files.includes(f)) entry.files.push(f);
      if (!allowed.has(f)) entry.violations.push({ file: f, sha: c.sha });
    }
  }
  const ok = Object.values(perTask).every((t) => t.violations.length === 0);
  return { perTask, ok };
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

describe('88-18 manifest gate: structure', () => {
  test('the manifest is valid and no file is under two tasks', () => {
    assert.strictEqual(manifest.schema, 1);
    const all = Object.values(manifest.tasks).flat();
    assert.ok(all.length > 0);
    assert.strictEqual(new Set(all).size, all.length, 'a file appears under more than one task');
    for (const f of all) assert.ok(fs.existsSync(path.join(ROOT, f)), 'manifest names a file that does not exist: ' + f);
  });
});

describe('88-18 manifest gate: the gate itself is per task, not a union', () => {
  const fake = { tasks: { 'A-1': ['tests/a.py'], 'A-2': ['tests/b.py'] } };

  test('passes when every file is in its own task entry', () => {
    const r = evaluate([{ sha: 'x', task: 'A-1', files: ['tests/a.py'] }, { sha: 'y', task: 'A-2', files: ['tests/b.py'] }], fake);
    assert.strictEqual(r.ok, true);
  });

  test('FAILS when a file from one task entry is attributed to another (a union check would pass)', () => {
    const commits = [{ sha: 'z', task: 'A-1', files: ['tests/a.py', 'tests/b.py'] }];
    const r = evaluate(commits, fake);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.perTask['A-1'].violations, [{ file: 'tests/b.py', sha: 'z' }]);
    const union = new Set(Object.values(fake.tasks).flat());
    assert.ok(commits[0].files.every((f) => union.has(f)), 'the union check would have let this through');
  });

  test('FAILS on a file that is in no entry at all', () => {
    const r = evaluate([{ sha: 'q', task: 'A-2', files: ['tests/unlisted.py'] }], fake);
    assert.strictEqual(r.ok, false);
  });

  test('passes again once the stray file is restored', () => {
    const r = evaluate([{ sha: 'z', task: 'A-1', files: ['tests/a.py'] }], fake);
    assert.strictEqual(r.ok, true);
  });
});

describe('88-18 manifest gate: this branch', () => {
  const commits = taggedCommits();
  const result = evaluate(commits, manifest);

  test('the history carries this plan (a shallow clone would make the gate vacuous)', () => {
    assert.ok(commits.some((c) => c.task === '88-18-01'), 'no [88-18-01] commit in history: shallow clone?');
    assert.ok(commits.length >= 3, 'expected several tagged commits, found ' + commits.length);
  });

  test('every task touched only files in its own manifest entry', () => {
    const lines = [];
    for (const task of REPORTED) {
      const t = result.perTask[task] || { commits: 0, files: [], violations: [] };
      const verdict = t.violations.length ? 'VIOLATION ' + JSON.stringify(t.violations) : 'OK';
      lines.push(`${task}: ${t.commits} commit(s), ${t.files.length} file(s), ${verdict}`);
    }
    console.log(lines.join('\n'));
    assert.strictEqual(result.ok, true, lines.join('\n'));
    console.log('MANIFEST_OK');
  });

  test('no tagged commit names a task the manifest does not know', () => {
    const known = new Set([...Object.keys(manifest.tasks), '88-18-01']);
    for (const c of commits) assert.ok(known.has(c.task), 'unknown task id in commit ' + c.sha + ': ' + c.subject);
  });
});
