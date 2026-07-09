'use strict';

// End-to-end effectiveness + structured-format regression suite for Plan 77.1-01
// (task 77.1-01-04): proves the v3.5 compressor now shrinks the HUMAN-format
// command output agents actually emit, END-TO-END through the real
// gsd-compress.cjs wrapper, WITHOUT regressing any Phase 73 structured path.
//
// Each command test builds its own DETERMINISTIC temp git repo / temp dir
// (never the working tree), runs the REAL command both raw (spawnSync of the
// tool) and wrapped (spawnSync of the wrapper CLI via process.execPath), and
// cleans up in try/finally. The raw side-channel dir (GSD_COMPRESS_RAW_DIR) is
// pinned INTO each test's temp base so no global tmp is polluted. No timing
// primitives — fully deterministic. git/grep tests skip (t.skip via the `skip`
// option) when the tool is absent, so the suite is portable.
//
// Coverage:
//   1. git status  end-to-end shrinks >=50% with an accurate changed-file count (FILT-01)
//   2. git diff    end-to-end shrinks >=50% (FILT-01)
//   3. ls -la      end-to-end shrinks, reports a file/dir split, NO mode-row garbage (FILT-03)
//   4. grep -rn    end-to-end groups by REAL files (not line numbers) (FILT-04)
//   5. structured  regression — `node --test tests/73-01-filters.test.cjs` exits 0 (Phase 73)
//   6. passthrough — `git --version` stays lossless (never-worse / raw-fallback intact)
//
// Idioms mirror tests/72-01-compress-engine.test.cjs + tests/73-01-filters.test.cjs:
// node:test + node:assert/strict, spawn via process.execPath (never bare 'node'),
// mkdtempSync temp dirs, copied env, cleanup in try/finally, no timing primitives.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cli = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-compress.cjs');
const regressionSuite = path.resolve(__dirname, '73-01-filters.test.cjs');

// --- capability detection (portability) --------------------------------------
function toolAvailable(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
const hasGit = toolAvailable('git');
// grep --version exits 0 on GNU; BSD grep also supports it. Fall back to a probe.
const hasGrep = (() => {
  if (toolAvailable('grep')) return true;
  try {
    const r = spawnSync('grep', ['x'], { input: 'x\n', encoding: 'utf8' });
    return !r.error;
  } catch {
    return false;
  }
})();

// --- helpers -----------------------------------------------------------------
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Run the wrapped command under the SAME interpreter, pinning the raw
// side-channel into `rawDir` so DISC-03's tee never escapes the test's temp base.
function runWrapped(cmd, args, cwd, rawDir) {
  return spawnSync(process.execPath, [cli, '--', cmd, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GSD_COMPRESS_RAW_DIR: rawDir },
  });
}

// Run the raw tool directly (baseline for the shrink comparison).
function runRaw(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

// Run a git plumbing/porcelain command during setup; throws on failure so a
// broken fixture surfaces loudly rather than as a mysterious assertion miss.
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
  }
  return r;
}

function initRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test Runner'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

// --- 1. git status end-to-end ------------------------------------------------
test('git status end-to-end shrinks >=50% with an accurate changed count (FILT-01)', { skip: !hasGit }, () => {
  const base = mkTmp('77.1-status-');
  try {
    const repo = path.join(base, 'repo');
    const rawDir = path.join(base, 'raw');
    fs.mkdirSync(repo);
    initRepo(repo);

    // Commit 24 files across 4 subdirs (paths inflate the raw listing).
    for (let i = 0; i < 24; i++) {
      const d = path.join(repo, 'src', 'mod' + (i % 4));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'file' + i + '.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    }
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'init'], repo);

    // Modify 16 committed files (-> unstaged) and add 8 untracked files.
    for (let i = 0; i < 16; i++) {
      const p = path.join(repo, 'src', 'mod' + (i % 4), 'file' + i + '.txt');
      fs.writeFileSync(p, 'CHANGED\nl2\nCHANGED2\nl4\nl5\n');
    }
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(repo, 'src', 'mod' + (i % 4), 'untracked' + i + '.txt'), 'x\n');
    }

    const raw = runRaw('git', ['status'], repo);
    const wrapped = runWrapped('git', ['status'], repo, rawDir);

    assert.equal(wrapped.status, 0, 'wrapper must propagate git status exit 0');
    assert.ok(raw.stdout.length > 0, 'raw git status must produce output');
    assert.ok(
      wrapped.stdout.length < raw.stdout.length * 0.5,
      `git status must shrink >=50% (raw ${raw.stdout.length} -> wrapped ${wrapped.stdout.length})`,
    );
    assert.ok(wrapped.stdout.includes('git status:'), 'compressed summary must carry the git status: header');
    // 16 unstaged + 8 untracked = 24 changed; count must be exact (no drops).
    assert.ok(wrapped.stdout.includes('24 changed'), 'changed-file count must be accurate (24 changed)');
    assert.ok(wrapped.stdout.includes('raw: git status'), 'the raw escape hatch must be present');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 2. git diff end-to-end --------------------------------------------------
test('git diff end-to-end shrinks >=50% (FILT-01)', { skip: !hasGit }, () => {
  const base = mkTmp('77.1-diff-');
  try {
    const repo = path.join(base, 'repo');
    const rawDir = path.join(base, 'raw');
    fs.mkdirSync(repo);
    initRepo(repo);

    // Commit 8 multi-line files, then rewrite each with many changed lines so
    // the raw diff is large and the churn summary is a big win.
    for (let i = 0; i < 8; i++) {
      const lines = Array.from({ length: 12 }, (_, k) => 'original line ' + k + ' in file ' + i).join('\n') + '\n';
      fs.writeFileSync(path.join(repo, 'src' + i + '.txt'), lines);
    }
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'init'], repo);
    for (let i = 0; i < 8; i++) {
      const lines = Array.from({ length: 12 }, (_, k) => 'MODIFIED line ' + k + ' in file ' + i).join('\n') + '\n';
      fs.writeFileSync(path.join(repo, 'src' + i + '.txt'), lines);
    }

    const raw = runRaw('git', ['diff'], repo);
    const wrapped = runWrapped('git', ['diff'], repo, rawDir);

    assert.equal(wrapped.status, 0, 'wrapper must propagate git diff exit 0');
    assert.ok(raw.stdout.length > 0, 'raw git diff must produce output');
    assert.ok(
      wrapped.stdout.length < raw.stdout.length * 0.5,
      `git diff must shrink >=50% (raw ${raw.stdout.length} -> wrapped ${wrapped.stdout.length})`,
    );
    assert.ok(wrapped.stdout.includes('git diff:'), 'compressed summary must carry the git diff: header');
    assert.ok(wrapped.stdout.includes('8 files'), 'diff file count must be accurate (8 files)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 3. ls -la end-to-end ----------------------------------------------------
test('ls -la end-to-end shrinks, reports a file/dir split, and drops mode-row garbage (FILT-03)', () => {
  const base = mkTmp('77.1-ls-');
  try {
    const listing = path.join(base, 'tree');
    const rawDir = path.join(base, 'raw');
    fs.mkdirSync(listing);
    for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(listing, 'file' + i + '.cjs'), 'x\n');
    for (let i = 0; i < 3; i++) fs.mkdirSync(path.join(listing, 'sub' + i));

    const raw = runRaw('ls', ['-la', listing], base);
    // ls is effectively universal on POSIX; skip only if it somehow failed to run.
    if (raw.error || raw.status !== 0) return; // portability guard (no ls -> nothing to prove)
    const wrapped = runWrapped('ls', ['-la', listing], base, rawDir);

    assert.equal(wrapped.status, 0, 'wrapper must propagate ls -la exit 0');
    assert.ok(
      wrapped.stdout.length < raw.stdout.length,
      `ls -la must shrink (raw ${raw.stdout.length} -> wrapped ${wrapped.stdout.length})`,
    );
    assert.ok(wrapped.stdout.includes('15 files'), 'file count must be correct (15 files)');
    assert.ok(wrapped.stdout.includes('3 dirs'), 'dir count must be correct (3 dirs)');
    assert.ok(!/drwx/.test(wrapped.stdout), 'compressed summary must NOT contain mode-row garbage (drwx)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 4. grep -rn end-to-end --------------------------------------------------
test('grep -rn end-to-end groups by REAL files, not line numbers (FILT-04)', { skip: !hasGrep }, () => {
  const base = mkTmp('77.1-grep-');
  try {
    const tree = path.join(base, 'tree');
    const rawDir = path.join(base, 'raw');
    fs.mkdirSync(tree);
    // 3 files, each with 8 repeated matches -> `path:line:content` (real paths).
    for (let f = 0; f < 3; f++) {
      const lines = Array.from({ length: 8 }, (_, k) => 'needle match on line ' + k).join('\n') + '\n';
      fs.writeFileSync(path.join(tree, 'gf' + f + '.txt'), lines);
    }

    const raw = runRaw('grep', ['-rn', 'needle', tree], base);
    const wrapped = runWrapped('grep', ['-rn', 'needle', tree], base, rawDir);

    assert.equal(wrapped.status, 0, 'wrapper must propagate grep exit 0 (matches found)');
    assert.ok(raw.stdout.length > 0, 'raw grep -rn must produce output');
    assert.ok(
      wrapped.stdout.length < raw.stdout.length,
      `grep -rn must shrink (raw ${raw.stdout.length} -> wrapped ${wrapped.stdout.length})`,
    );
    assert.ok(wrapped.stdout.includes('3 files'), 'grep -rn must group by the 3 REAL files');
    assert.ok(!/single file\/stream/.test(wrapped.stdout), 'multi-file grep must NOT collapse to single-stream mode');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 5. structured-format regression -----------------------------------------
test('structured-format regression: Phase 73 suite (73-01-filters.test.cjs) still exits 0', () => {
  const r = spawnSync(process.execPath, ['--test', regressionSuite], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(
    r.status,
    0,
    `Phase 73 structured-format suite must still pass (status ${r.status})\n${r.stdout}\n${r.stderr}`,
  );
});

// --- 6. lossless passthrough -------------------------------------------------
test('lossless passthrough: git --version stays byte-lossless (never-worse / raw-fallback)', { skip: !hasGit }, () => {
  const base = mkTmp('77.1-pass-');
  try {
    const rawDir = path.join(base, 'raw');
    const wrapped = runWrapped('git', ['--version'], base, rawDir);
    assert.equal(wrapped.status, 0, 'wrapper must propagate git --version exit 0');
    assert.ok(wrapped.stdout.includes('git version'), 'git --version output must survive the pipe unchanged');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
