'use strict';

// Behavioral suite for Plan 73-01 (task 73-01-07): the six starter command
// filters (git, test, list, search, docker, generic) wired into the Phase 72
// compression engine via compress-registry.json.
//
// Proves, end-to-end THROUGH the real registry + wrapper:
//   1. registry shape  — v1.1, six entries, each filter file exists, heads globally disjoint
//   2. selectChain wiring — every registered head resolves to its filter (length-1 chain) and
//      shrinks a compressible sample; an unregistered head resolves to _passthrough identity
//   3. reduction + raw-fallback per filter — >=60% shrink on a structured sample AND byte-identical
//      return on a garbage sample (raw fallback)
//   4. test-filter failure-line preservation — TAP `not ok … CRITICAL` and pytest `path:line`
//      survive verbatim in the compressed output
//   5. end-to-end pipe integrity — spawn gsd-compress.cjs on a real `git --version`; the git
//      filter raw-falls-back on non-porcelain output so the pipe stays lossless
//
// Idioms mirror tests/72-01-compress-engine.test.cjs: node:test + node:assert/strict, spawn the
// CLI via process.execPath (never a bare 'node'), copied env, no timing primitives.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const registryPath = path.resolve(ROOT, 'get-shit-done', 'config', 'compress-registry.json');
const filtersDir = path.resolve(ROOT, 'get-shit-done', 'bin', 'lib', 'compress-filters');
const indexPath = path.join(filtersDir, 'index.cjs');
const compressCli = path.resolve(ROOT, 'get-shit-done', 'bin', 'gsd-compress.cjs');

// --- structured (compressible) sample builders, one per filter format --------
// (reused from the six filter tasks' acceptance criteria).
const samples = {
  git() {
    const h = '1'.repeat(40);
    const rec = (i) => ['1', '.M', 'N...', '100644', '100644', '100644', h, h, 'src/mod/file' + i + '.js'].join(' ');
    return Array.from({ length: 60 }, (_, i) => rec(i)).join('\n') + '\n';
  },
  tap() {
    const ok = Array.from({ length: 100 }, (_, i) => 'ok ' + (i + 1) + ' - passing test number ' + i).join('\n');
    return 'TAP version 13\n1..102\n' + ok +
      '\nnot ok 101 - CRITICAL failure here\n  ---\n  error: boom\n  ...\nnot ok 102 - second failure alpha\n';
  },
  pytest() {
    return Array.from({ length: 60 }, () => '.').join('') +
      '\ntests/test_mod.py:42: AssertionError: expected 3\n' +
      '=========================== 5 failed, 120 passed, 2 error in 3.14s ============================\n';
  },
  cargo() {
    return Array.from({ length: 40 }, (_, i) => 'test tests::case_' + i + ' ... ok').join('\n') +
      '\ntest tests::broken ... FAILED\ntest result: FAILED. 40 passed; 2 failed; 0 ignored\n';
  },
  goJson() {
    const ev = [];
    for (let i = 0; i < 50; i++) ev.push(JSON.stringify({ Action: 'pass', Package: 'p', Test: 'TestOk' + i }));
    ev.push(JSON.stringify({ Action: 'fail', Package: 'p', Test: 'TestBoom' }));
    ev.push(JSON.stringify({ Action: 'fail', Package: 'p' }));
    return ev.join('\n') + '\n';
  },
  list() {
    return Array.from({ length: 200 }, (_, i) => 'src/mod' + (i % 8) + '/file' + i + '.js').join('\n') + '\n';
  },
  rgJson() {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({
        type: 'match',
        data: { path: { text: 'src/file' + (i % 3) + '.js' }, lines: { text: '  const x = foo(' + i + ');\n' }, line_number: i },
      }));
    }
    return lines.join('\n') + '\n';
  },
  grepText() {
    return Array.from({ length: 100 }, () => 'src/foo.js:12:duplicate match line').join('\n') + '\n';
  },
  docker() {
    const big = 'k=v;'.repeat(60);
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({
      Names: 'svc' + i, Image: 'img:latest', State: 'running', Status: 'Up 3m',
      Labels: big, Mounts: '/data:/data;/x:/y', Networks: 'bridge',
    }));
    return lines.join('\n') + '\n';
  },
  generic() {
    return Array.from({ length: 300 }, () => 'Downloading package foo...').join('\n') + '\nerror: build failed at step 4\n';
  },
};

// A head -> compressible-sample map covering EVERY registered head.
const headSample = {
  git: samples.git(),
  node: samples.tap(),
  pytest: samples.pytest(),
  go: samples.goJson(),
  cargo: samples.cargo(),
  ls: samples.list(),
  find: samples.list(),
  grep: samples.grepText(),
  rg: samples.rgJson(),
  docker: samples.docker(),
  npm: samples.generic(),
};

// Per-filter: a >=60%-reducible structured sample + a garbage sample that must raw-fall-back.
const perFilter = {
  git: { big: samples.git(), garbage: 'git version 2.53.0\nsome unrelated human text\n' },
  test: { big: samples.tap(), garbage: '{"build":"ok","artifacts":3}\nBuild complete in 2s\n' },
  list: { big: samples.list(), garbage: 'a.txt\nb.txt\n' },
  search: { big: samples.rgJson(), garbage: 'just some prose without colons\nanother line here\n' },
  docker: { big: samples.docker(), garbage: 'abc123def456\nfeed0feed01\n' },
  generic: { big: samples.generic(), garbage: 'line one\nline two\nline three\n' },
};

test('registry shape: v1.1, six entries, every filter file exists, heads globally disjoint', () => {
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(reg.registry_version, '1.1', 'registry_version must be bumped to 1.1');
  assert.ok(Array.isArray(reg.entries), 'entries must be an array');
  assert.equal(reg.entries.length, 6, 'exactly six filter entries expected');

  for (const e of reg.entries) {
    assert.equal(e.enabled, true, `entry ${e.name} must be enabled`);
    assert.ok(Array.isArray(e.heads) && e.heads.length > 0, `entry ${e.name} must list heads`);
    const file = path.join(filtersDir, e.filter + '.cjs');
    assert.ok(fs.existsSync(file), `filter file for ${e.name} must exist: ${file}`);
  }

  // Heads globally disjoint — no argv-head maps to two filters (cargo->test only).
  const heads = reg.entries.flatMap((e) => e.heads);
  assert.equal(new Set(heads).size, heads.length, 'heads must be disjoint across all entries');
  assert.ok(heads.includes('cargo'), 'cargo must be a registered head');
  const cargoEntries = reg.entries.filter((e) => e.heads.includes('cargo'));
  assert.equal(cargoEntries.length, 1, 'cargo must map to exactly one filter');
  assert.equal(cargoEntries[0].filter, 'test', 'cargo must route to the test filter, not generic');
});

test('selectChain wiring: each registered head resolves to a length-1 chain that shrinks its sample', () => {
  const { selectChain } = require(indexPath);
  for (const head of Object.keys(headSample)) {
    const chain = selectChain(head);
    assert.ok(Array.isArray(chain), `selectChain('${head}') must return an array`);
    assert.equal(chain.length, 1, `selectChain('${head}') must be a single-transform chain`);
    const sample = headSample[head];
    const out = chain[0](sample, '', 0);
    assert.equal(typeof out, 'string', `filter for '${head}' must return a string`);
    assert.ok(out.length < sample.length, `filter for '${head}' must shrink its compressible sample`);
  }
});

test('selectChain wiring: an unregistered head resolves to _passthrough identity', () => {
  const { selectChain } = require(indexPath);
  const chain = selectChain('totally-unknown-cmd');
  assert.ok(Array.isArray(chain) && chain.length === 1, 'unknown head must still return a length-1 chain');
  const sample = 'keep me verbatim\nsecond line\n';
  assert.equal(chain[0](sample, '', 0), sample, 'unknown head must pass output through unchanged (identity)');
});

test('per-filter: >=60% reduction on a structured sample AND byte-identical raw-fallback on garbage', () => {
  for (const [id, { big, garbage }] of Object.entries(perFilter)) {
    const mod = require(path.join(filtersDir, id + '.cjs'));
    assert.equal(typeof mod.transform, 'function', `${id} must export a transform fn`);
    assert.equal(mod.id, id, `${id}.cjs must self-identify id='${id}'`);

    const out = mod.transform(big, '', 0);
    assert.equal(typeof out, 'string', `${id} transform must return a string`);
    assert.ok(out.length <= big.length * 0.4, `${id} must shrink its structured sample by >=60%`);

    const rawBack = mod.transform(garbage, '', 0);
    assert.equal(rawBack, garbage, `${id} must return garbage input byte-identical (raw fallback)`);
  }
});

test('per-filter: no transform ever throws and every result is a string (incl. garbage inputs)', () => {
  const ids = ['git', 'test', 'list', 'search', 'docker', 'generic'];
  const inputs = [null, '', 123, {}, '\n\n\n', 'random\ntext\n'];
  for (const id of ids) {
    const mod = require(path.join(filtersDir, id + '.cjs'));
    for (const x of inputs) {
      let r;
      assert.doesNotThrow(() => { r = mod.transform(x, '', 0); }, `${id} must never throw on ${JSON.stringify(x)}`);
      assert.equal(typeof r, 'string', `${id} must always return a string for ${JSON.stringify(x)}`);
    }
  }
});

test('test-filter preserves every failure/error line verbatim (TAP + pytest)', () => {
  const mod = require(path.join(filtersDir, 'test.cjs'));

  const tapOut = mod.transform(samples.tap(), '', 0);
  assert.ok(tapOut.length <= samples.tap().length * 0.4, 'TAP output must be reduced >=60%');
  assert.ok(tapOut.includes('CRITICAL failure here'), 'TAP first failure line must survive verbatim');
  assert.ok(tapOut.includes('second failure alpha'), 'TAP second failure line must survive verbatim');

  const pyOut = mod.transform(samples.pytest(), '', 0);
  assert.ok(pyOut.includes('5 failed'), 'pytest failure count must be reported');
  assert.ok(pyOut.includes('tests/test_mod.py:42'), 'pytest path:line failure must survive verbatim');
});

test('search-filter deduplicates identical grep match lines with a (xN) marker', () => {
  const mod = require(path.join(filtersDir, 'search.cjs'));
  const out = mod.transform(samples.grepText(), '', 0);
  assert.ok(out.length <= samples.grepText().length * 0.4, 'grep dedup must reduce >=60%');
  assert.ok(/[x×]\s*\d/.test(out), 'grep dedup must annotate repeats with a (xN) count');
});

test('docker-filter drops Labels/Mounts while keeping Names/Image/State/Status', () => {
  const mod = require(path.join(filtersDir, 'docker.cjs'));
  const out = mod.transform(samples.docker(), '', 0);
  assert.ok(out.includes('svc0'), 'container Names must be kept');
  assert.ok(out.includes('img:latest'), 'container Image must be kept');
  assert.ok(!out.includes('k=v;k=v'), 'the Labels token-hog string must be dropped');
});

test('end-to-end pipe integrity: gsd-compress on a real `git --version` stays lossless', () => {
  const r = spawnSync(process.execPath, [compressCli, '--', 'git', '--version'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(r.status, 0, 'wrapper must propagate git --version exit code 0');
  assert.ok(r.stdout.includes('git version'), 'git filter raw-falls-back on non-porcelain output; pipe stays lossless');
});
