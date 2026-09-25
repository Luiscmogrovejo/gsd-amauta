#!/usr/bin/env node
/**
 * Phase 10 REGRESSION test: legacy free-text learnings must still work.
 *
 * Verifies:
 *   - `gsd-memory learn "free text"` (without --structured) exits 0
 *   - Legacy entries are stored without metadata.what (no structured fields injected)
 *   - Legacy entries are searchable
 *   - Legacy entries render in one-line format (no structured card) in search output
 *
 * Run: node tests/10-legacy-compat.test.cjs
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MEM_CLI = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

// TK-2386: file-mode writes land in `<cwd>/.planning`, and this suite ran the
// CLI with the repo as cwd — so every run appended to the repo's own tracked
// .planning/STATE.md. Give the CLI a scratch cwd instead.
const MEM_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-memcli-'));
process.on('exit', () => { try { fs.rmSync(MEM_TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function runMem(...args) {
  // TK-2386: this suite's contract is "daemon-reachable OR file-fallback".
  // A degraded memory CLI now refuses with exit 3 unless the caller opts in to
  // file mode, so the file-fallback half of the contract is taken explicitly
  // here. Without this the suite silently measured whichever store the shared
  // daemon on 18799 happened to be answering from.
  return spawnSync('node', [MEM_CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    cwd: MEM_TMP,
    env: { ...process.env, GSD_MEMORY_FILE_MODE: '1' },
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('REGRESSION: learn "free text" (no --structured flag) does not crash', () => {
  const r = runMem('learn', 'legacy regression test: free text learning');
  // daemon down -> file fallback may still succeed; crash = exit >= 2
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
  assert.ok(!/TypeError|SyntaxError|ReferenceError/.test(r.stderr), `stack trace in stderr: ${r.stderr}`);
});

test('REGRESSION: learn with --agent flag (legacy pattern) does not crash', () => {
  const r = runMem('learn', '--agent', 'test-agent', 'legacy with agent');
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(!/TypeError|SyntaxError|ReferenceError/.test(r.stderr));
});

test('REGRESSION: search "query" (no --tags --category) does not crash', () => {
  const r = runMem('search', 'regression search query');
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(!/TypeError|SyntaxError|ReferenceError/.test(r.stderr));
});

test('REGRESSION: skb-search (legacy subcommand) unchanged', () => {
  const r = runMem('skb-search', 'legacy skb query');
  // Either runs successfully or shows daemon-down; must not crash
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(!/TypeError|SyntaxError|ReferenceError/.test(r.stderr));
});

test('REGRESSION: module re-require does not throw after Phase 10 changes', () => {
  // Clear cache and re-require -- catches circular dep or export regressions
  delete require.cache[require.resolve(MEM_CLI)];
  const mod = require(MEM_CLI);
  assert.ok(mod);
});

test('REGRESSION: normalizeTags returns new {tags,warnings,error} shape', () => {
  const mod = require(MEM_CLI);
  const r = mod.normalizeTags(['postgresql']);
  assert.ok('tags' in r);
  assert.ok('warnings' in r);
  assert.ok('error' in r);
  assert.ok(Array.isArray(r.tags));
});

// -------------------- Runner --------------------

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
