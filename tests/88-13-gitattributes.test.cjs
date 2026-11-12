/**
 * Phase 88 plan 88-13 task 03: the repository pins its text files to LF.
 *
 * Git for Windows checks out with core.autocrlf=true, which rewrites every tracked text file to
 * CRLF. The canary and byte-lock tests compare a `git show <sha>` blob (LF) against the working
 * tree, and the agent and skill compilers split on '\n' (88-13-14-RESEARCH.md, group G4: 115 of
 * the 332 Windows failures). `.gitattributes` plus a `core.autocrlf false` step before checkout
 * remove the whole group.
 *
 * These tests fail on any platform when a future change reintroduces a CRLF working-tree file,
 * so the regression shows up on the cell that is fastest to run instead of on Windows only.
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
const GITATTRIBUTES = path.join(ROOT, '.gitattributes');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');

/** @returns {string[]} the lines of a file, CRLF-tolerant */
function readLines(file) {
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/);
}

/**
 * Run git in the repository root.
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, error?: Error}}
 */
function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

const GIT_PROBE = git(['rev-parse', '--is-inside-work-tree']);
const HAS_GIT = !GIT_PROBE.error && GIT_PROBE.status === 0 && GIT_PROBE.stdout.trim() === 'true';

/** @returns {Set<string>} literal paths that .gitattributes marks `-text` */
function minusTextPaths() {
  const out = new Set();
  for (const raw of readLines(GITATTRIBUTES)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.slice(1).includes('-text')) out.add(parts[0]);
  }
  return out;
}

/**
 * Return the lines of a job block in the workflow: from `  <job>:` (two-space indent, directly
 * under `jobs:`) up to the next job key or end of file. Throws when the job cannot be found, so a
 * rename of the job makes this fail loudly instead of passing by default.
 * @param {string[]} lines
 * @param {string} job
 * @returns {string[]}
 */
function jobBlock(lines, job) {
  const start = lines.findIndex((l) => l === '  ' + job + ':');
  assert.ok(start >= 0, 'job "' + job + '" not found in .github/workflows/test.yml');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

describe('88-13 .gitattributes pins the working tree to LF', () => {
  test('.gitattributes exists and its first rule is `* text=auto eol=lf`', () => {
    assert.ok(fs.existsSync(GITATTRIBUTES), '.gitattributes is missing');
    const rules = readLines(GITATTRIBUTES)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    assert.ok(rules.length > 0, '.gitattributes has no rules');
    assert.strictEqual(rules[0], '* text=auto eol=lf');
  });

  test('binary assets are marked binary so they are never translated', () => {
    const rules = new Set(
      readLines(GITATTRIBUTES)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    );
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz']) {
      assert.ok(rules.has('*.' + ext + ' binary'), '*.' + ext + ' is not marked binary');
    }
  });

  test(
    'no tracked blob is CRLF in the working tree except paths marked -text',
    { skip: HAS_GIT ? false : 'no git history: git is unavailable or this is not a work tree' },
    () => {
      const allowed = minusTextPaths();
      const r = git(['ls-files', '--eol']);
      assert.strictEqual(r.status, 0, 'git ls-files --eol failed');
      const offenders = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        // "i/lf    w/crlf  attr/text=auto eol=lf\tpath"
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const meta = line.slice(0, tab);
        const file = line.slice(tab + 1);
        if (/\bw\/crlf\b/.test(meta) && !allowed.has(file)) offenders.push(file + ' (' + meta.trim() + ')');
      }
      assert.deepStrictEqual(offenders, [], 'CRLF working-tree files not marked -text:\n' + offenders.join('\n'));
    },
  );
});

describe('88-13 CI checks out with LF line endings', () => {
  // Method: a line scan (the repository has no YAML parser for Node and a test may not add a
  // dependency). For each job, find the first `uses: actions/checkout` line and require an
  // uncommented `run: git config --global core.autocrlf false` line before it.
  for (const job of ['test', 'pytest']) {
    test('job "' + job + '" sets core.autocrlf false before actions/checkout', () => {
      const block = jobBlock(readLines(WORKFLOW), job);
      const checkout = block.findIndex((l) => /^\s*-?\s*uses:\s*actions\/checkout@/.test(l));
      assert.ok(checkout >= 0, 'job "' + job + '" has no actions/checkout step');
      const before = block.slice(0, checkout);
      const hit = before.some((l) => /^\s*run:\s*git config --global core\.autocrlf false\s*$/.test(l));
      assert.ok(hit, 'job "' + job + '" must run `git config --global core.autocrlf false` before actions/checkout');
    });
  }

  test('the workflow sets neither PYTHONUTF8 nor PYTHONIOENCODING (that would mask G1, not fix it)', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf-8');
    assert.ok(!/PYTHONUTF8/.test(text), 'PYTHONUTF8 appears in test.yml');
    assert.ok(!/PYTHONIOENCODING/.test(text), 'PYTHONIOENCODING appears in test.yml');
  });
});

describe('88-13 the line scan is a detector, not decoration', () => {
  test('a block without the step is rejected', () => {
    const lines = ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@abc # v4', '  other:', '    x: 1'];
    const block = jobBlock(lines, 'test');
    const checkout = block.findIndex((l) => /^\s*-?\s*uses:\s*actions\/checkout@/.test(l));
    assert.ok(checkout >= 0);
    assert.ok(!block.slice(0, checkout).some((l) => /core\.autocrlf false/.test(l)));
    assert.strictEqual(block.length, 3, 'the block must stop at the next job key');
  });

  test('an unknown job fails loudly', () => {
    assert.throws(() => jobBlock(['jobs:', '  test:'], 'nope'), /not found/);
  });
});
