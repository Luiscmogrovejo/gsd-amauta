'use strict';

// ============================================================================
// audit-runner-root.test.cjs — regression for HARN-AUDIT-ROOT (TK-1887).
//
// The engine used to resolve its repo-scope ROOT from the MODULE path
// (path.resolve(__dirname, '..', '..', '..')), so when it ran from the
// installed copy (~/.claude/get-shit-done/bin/lib/) the repo-scope detects
// (AGEN-04 / AGEN-06) audited the INSTALL tree instead of the repo under
// audit (live symptom: AGEN-06 "0 eval sets" when the audited repo has 3).
//
// Contract under test:
//   (a) default audit root = process.cwd() when cwd looks like a repo
//       (has .planning/ or package.json) — NOT the module tree;
//   (b) module-relative fallback ONLY when cwd lacks both repo markers;
//   (c) an explicit opts.root / ctx.root is always honored, regardless of cwd.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENGINE_PATH = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'audit-runner.cjs');
const engine = require(ENGINE_PATH);

// The module-relative root the OLD code hardwired (three levels above bin/lib/).
const MODULE_ROOT = path.resolve(path.dirname(ENGINE_PATH), '..', '..', '..');

// Build a minimal fixture REPO: a package.json marker, ONE agent eval set
// (plus the excluded grader-schemas.json) and a THREE-agent gsd-* roster —
// so AGEN-06 fires with an unmistakable "1 ... vs a 3-agent roster" evidence
// string that can only come from THIS fixture, never from the real tree.
function mkFixtureRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-root-fix-')));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture-repo"}\n');
  fs.mkdirSync(path.join(dir, 'tests', 'evals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'evals', 'gsd-alpha.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'tests', 'evals', 'grader-schemas.json'), '{}\n'); // excluded from the count
  for (const a of ['gsd-alpha', 'gsd-beta', 'gsd-gamma']) {
    fs.mkdirSync(path.join(dir, 'get-shit-done', 'agents', a), { recursive: true });
  }
  return dir;
}

function agen06(findings) {
  return findings.find((f) => f.rule_id === 'AGEN-06');
}

// ───────────────────────────────────────────────────────────────────────────
// (c) explicit root honored — fixture root passed via opts.root, cwd untouched.
// ───────────────────────────────────────────────────────────────────────────
test('repo-scope detects honor an explicit opts.root (fixture repo, cwd untouched)', (t) => {
  const fixture = mkFixtureRepo();
  t.after(() => { try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {} });

  const findings = engine.detect('agentic-flow', [], { root: fixture });
  const f = agen06(findings);
  assert.ok(f, 'AGEN-06 fires on the fixture eval-coverage gap');
  assert.match(
    f.evidence,
    /1 agent eval set\(s\) vs a 3-agent roster/,
    `AGEN-06 counted the FIXTURE tree (got: ${f && f.evidence})`
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (a) DEFAULT root = process.cwd() — the regression proper. chdir into the
// fixture repo, pass NO root, and the repo-scope detect must count the
// FIXTURE's eval sets, not the module tree's.
// ───────────────────────────────────────────────────────────────────────────
test('default audit root is process.cwd() when cwd is a repo (not the module tree)', (t) => {
  const fixture = mkFixtureRepo();
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {}
  });

  process.chdir(fixture);
  assert.equal(engine.defaultRoot(), fixture, 'defaultRoot() resolves to cwd (repo marker: package.json)');
  assert.notEqual(engine.defaultRoot(), MODULE_ROOT, 'defaultRoot() is NOT the module tree');

  const findings = engine.detect('agentic-flow', []); // NO root — must default to cwd
  const f = agen06(findings);
  assert.ok(f, 'AGEN-06 fires on the fixture eval-coverage gap via the DEFAULT root');
  assert.match(
    f.evidence,
    /1 agent eval set\(s\) vs a 3-agent roster/,
    `AGEN-06 with no explicit root counted the CWD repo, not the module tree (got: ${f && f.evidence})`
  );
});

// .planning/ alone (no package.json) is also a repo marker.
test('default audit root: .planning/ alone marks cwd as a repo', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-root-plan-')));
  fs.mkdirSync(path.join(dir, '.planning'));
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  process.chdir(dir);
  assert.equal(engine.defaultRoot(), dir, '.planning/ marker → defaultRoot() = cwd');
});

// ───────────────────────────────────────────────────────────────────────────
// (b) module-relative FALLBACK when cwd has neither .planning/ nor package.json.
// ───────────────────────────────────────────────────────────────────────────
test('default audit root falls back to the module tree when cwd lacks repo markers', (t) => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-root-bare-')));
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(bare, { recursive: true, force: true }); } catch (_) {}
  });

  process.chdir(bare);
  assert.equal(engine.defaultRoot(), MODULE_ROOT, 'bare cwd (no markers) → module-relative fallback');
});
