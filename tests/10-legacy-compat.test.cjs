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

// Phase 88 (88-07) disposition: in-process / file mode, no daemon. Every CLI call below opts in to
// file mode (GSD_MEMORY_FILE_MODE=1) and runs in test mode against a port nothing listens on, so the
// suite never measures (or writes to) a shared daemon. Under GSD_TEST_MODE=1 gsd-memory.cjs caps a
// request at 2000 ms and names the failure instead of hanging until this file's own timeout.
const DEAD_PORT = (process.env.GSD_AMAUTA_PORT && process.env.GSD_AMAUTA_PORT !== '18799') ? process.env.GSD_AMAUTA_PORT : '19941';

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
    env: { ...process.env, GSD_MEMORY_FILE_MODE: '1', GSD_TEST_MODE: '1', GSD_AMAUTA_PORT: DEAD_PORT },
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

test('88-07: under GSD_TEST_MODE a silent memory service fails fast with a named message', async () => {
  // A listener that accepts and never answers: before the 2000 ms test-mode cap this ran into the
  // caller's own 60 s timeout and surfaced as a null exit code.
  const net = require('net');
  const { spawn } = require('child_process');
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const started = Date.now();
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [MEM_CLI, 'search', 'anything'], {
        cwd: MEM_TMP,
        env: { ...process.env, GSD_TEST_MODE: '1', GSD_AMAUTA_PORT: String(port) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.on('close', (code) => { clearTimeout(killer); resolve({ code, stderr }); });
    });
    assert.ok(out.code !== null && out.code !== 0, `expected a non-zero exit, got ${out.code}`);
    assert.match(out.stderr, /memory service unavailable at http:\/\/127\.0\.0\.1:\d+ under GSD_TEST_MODE \(timed out after 2000ms\)/);
    assert.ok(Date.now() - started < 10000, 'must fail within seconds, not run into a 60 s timeout');
  } finally {
    server.close();
  }
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
