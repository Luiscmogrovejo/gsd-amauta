/**
 * Phase 88 plan 88-13 task 04: the agent, skill and md-to-yaml compilers tolerate CRLF sources.
 *
 * `.gitattributes` (task 03) fixes the CI checkout, but a Windows user who edits an agent in an
 * editor that writes CRLF, or who clones with an inherited `core.autocrlf=true`, still hands the
 * compilers CRLF text. They split on '\n' and used to produce `name: undefined`
 * (88-13-14-RESEARCH.md G4: `canonical[0:43]="---\r\nname: gsd-persona…"` against
 * `generated="---\nname: undefined"`).
 *
 * This is the local repro that stands in for Windows (proof type (a)). It is also the ONLY proof
 * the CRLF-tolerant code works: on the Windows CI cell the checkout is LF, so this code is never
 * exercised there.
 *
 * How the CRLF tree is produced (a comment is required by the plan, and the test prints the method):
 *   1. try `git clone --local --no-hardlinks -c core.autocrlf=true`; it only counts if the clone
 *      really holds CRLF sources;
 *   2. otherwise copy the sources into a temp tree and rewrite every .md/.yaml/.yml to CRLF.
 * With `.gitattributes` `eol=lf` in place the clone is LF (that is the desired production
 * behaviour and the first test below asserts it), so method 2 is what normally runs.
 *
 * Nothing here connects to a port. Every temp directory is removed in `after`.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE_AGENT = 'get-shit-done/agents/gsd-planner/AGENT.yaml';
const TEXT_EXT = new Set(['.md', '.yaml', '.yml']);

let TMP = '';
let LF_TREE = '';
let CRLF_TREE = '';
let METHOD = '';
let CLONE_DIR = '';
let CLONE_IS_CRLF = false;

/**
 * Copy a directory tree, converting every text source (.md/.yaml/.yml) to the requested line ending.
 * @param {string} src
 * @param {string} dst
 * @param {'lf'|'crlf'} eol
 * @returns {void}
 */
function copyTree(src, dst, eol) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, eol);
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      const lf = fs.readFileSync(from, 'utf-8').replace(/\r\n/g, '\n');
      fs.writeFileSync(to, eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Lay out the sources the three compilers read under `root`.
 * @param {string} srcRoot - directory holding get-shit-done/ and agents/
 * @param {string} root - destination
 * @param {'lf'|'crlf'} eol
 * @returns {void}
 */
function layout(srcRoot, root, eol) {
  copyTree(path.join(srcRoot, 'get-shit-done', 'agents'), path.join(root, 'get-shit-done', 'agents'), eol);
  copyTree(path.join(srcRoot, 'get-shit-done', 'skills'), path.join(root, 'get-shit-done', 'skills'), eol);
  copyTree(path.join(srcRoot, 'agents'), path.join(root, 'agents'), eol);
  fs.mkdirSync(path.join(root, 'get-shit-done', 'references'), { recursive: true });
  const pc = fs.readFileSync(path.join(srcRoot, 'get-shit-done', 'references', 'platform-codes.yaml'), 'utf-8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(root, 'get-shit-done', 'references', 'platform-codes.yaml'), eol === 'crlf' ? pc.replace(/\n/g, '\r\n') : pc);
}

/**
 * Run one compiler script and require exit 0.
 * @param {string} script - file name under scripts/
 * @param {string[]} args
 * @param {string} platformCodes - path of the platform-codes.yaml to read
 * @returns {{stdout: string, stderr: string}}
 */
function run(script, args, platformCodes) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: TMP,
    encoding: 'utf-8',
    env: { ...process.env, GSD_TEST_MODE: '1', PLATFORM_CODES_YAML: platformCodes },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.strictEqual(r.status, 0, script + ' ' + args.join(' ') + ' failed:\n' + r.stdout + r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * Map relative path to file bytes for every file under dir.
 * @param {string} dir
 * @returns {Map<string, Buffer>}
 */
function snapshot(dir) {
  const out = new Map();
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  })(dir);
  return out;
}

/**
 * Assert two output directories are byte-identical and non-trivial.
 * @param {string} a
 * @param {string} b
 * @param {number} minFiles - guard against a vacuous comparison of two empty directories
 * @returns {void}
 */
function assertSameBytes(a, b, minFiles) {
  const sa = snapshot(a);
  const sb = snapshot(b);
  assert.ok(sa.size >= minFiles, 'expected at least ' + minFiles + ' output files, got ' + sa.size + ' in ' + a);
  assert.deepStrictEqual([...sa.keys()].sort(), [...sb.keys()].sort(), 'different file sets');
  for (const [rel, buf] of sa) {
    assert.ok(buf.equals(sb.get(rel)), 'output differs between LF and CRLF source for ' + rel);
    assert.ok(!buf.includes('\r'), 'output contains a CR for ' + rel);
  }
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), '88-13-crlf-'));
  LF_TREE = path.join(TMP, 'lf');
  CRLF_TREE = path.join(TMP, 'crlf');

  // Method 1: an autocrlf=true clone. Only usable when the clone really holds CRLF sources.
  CLONE_DIR = path.join(TMP, 'clone');
  const clone = spawnSync('git', ['clone', '-q', '--local', '--no-hardlinks', '-c', 'core.autocrlf=true', ROOT, CLONE_DIR], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (clone.status === 0 && fs.existsSync(path.join(CLONE_DIR, PROBE_AGENT))) {
    CLONE_IS_CRLF = fs.readFileSync(path.join(CLONE_DIR, PROBE_AGENT), 'utf-8').includes('\r\n');
  }

  layout(ROOT, LF_TREE, 'lf');
  if (CLONE_IS_CRLF) {
    METHOD = 'autocrlf-clone';
    fs.mkdirSync(CRLF_TREE, { recursive: true });
    for (const rel of ['get-shit-done', 'agents']) {
      fs.cpSync(path.join(CLONE_DIR, rel), path.join(CRLF_TREE, rel), { recursive: true });
    }
  } else {
    METHOD = 'rewritten-copy (.gitattributes eol=lf overrides core.autocrlf in the clone)';
    layout(ROOT, CRLF_TREE, 'crlf');
  }
});

after(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

describe('88-13 the CRLF repro is real', () => {
  test('with .gitattributes at HEAD an autocrlf=true clone holds LF text sources (G4 repro, proof a)', (t) => {
    t.diagnostic('clone holds CRLF: ' + CLONE_IS_CRLF);
    assert.ok(fs.existsSync(path.join(CLONE_DIR, PROBE_AGENT)), 'the clone did not produce ' + PROBE_AGENT);
    assert.strictEqual(CLONE_IS_CRLF, false, 'an autocrlf=true clone is CRLF: .gitattributes is not pinning eol=lf');
  });

  test('the CRLF tree really is CRLF and the LF tree really is LF', (t) => {
    t.diagnostic('CRLF-forcing method: ' + METHOD);
    const crlf = fs.readFileSync(path.join(CRLF_TREE, PROBE_AGENT), 'utf-8');
    const lf = fs.readFileSync(path.join(LF_TREE, PROBE_AGENT), 'utf-8');
    assert.ok(crlf.includes('\r\n'), 'CRLF tree has no CRLF: the repro is void');
    assert.ok(!lf.includes('\r'), 'LF tree contains a CR');
    assert.strictEqual(crlf.replace(/\r\n/g, '\n'), lf);
    const agentMd = fs.readFileSync(path.join(CRLF_TREE, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(agentMd.includes('\r\n'), 'CRLF agents/gsd-planner.md has no CRLF');
    const skill = fs.readFileSync(path.join(CRLF_TREE, 'get-shit-done', 'skills', 'plan-phase', 'SKILL.md'), 'utf-8');
    assert.ok(skill.includes('\r\n'), 'CRLF SKILL.md has no CRLF');
  });
});

describe('88-13 agent-compiler: CRLF AGENT.yaml compiles byte-identically to LF', () => {
  for (const target of ['claude-code', 'opencode']) {
    test('target ' + target, () => {
      const outLf = path.join(TMP, 'out-agent-lf-' + target);
      const outCrlf = path.join(TMP, 'out-agent-crlf-' + target);
      const pcLf = path.join(LF_TREE, 'get-shit-done', 'references', 'platform-codes.yaml');
      const pcCrlf = path.join(CRLF_TREE, 'get-shit-done', 'references', 'platform-codes.yaml');
      run('agent-compiler.cjs', ['--target=' + target, '--source=' + path.join(LF_TREE, 'get-shit-done', 'agents'), '--out=' + outLf], pcLf);
      run('agent-compiler.cjs', ['--target=' + target, '--source=' + path.join(CRLF_TREE, 'get-shit-done', 'agents'), '--out=' + outCrlf], pcCrlf);
      assertSameBytes(outLf, outCrlf, 30);
    });
  }

  test('a CRLF AGENT.yaml still has its name parsed (the original `name: undefined` symptom)', () => {
    const out = path.join(TMP, 'out-agent-name');
    const pcCrlf = path.join(CRLF_TREE, 'get-shit-done', 'references', 'platform-codes.yaml');
    run('agent-compiler.cjs', ['--target=claude-code', '--agent=gsd-planner', '--source=' + path.join(CRLF_TREE, 'get-shit-done', 'agents'), '--out=' + out], pcCrlf);
    const text = fs.readFileSync(path.join(out, 'gsd-planner.md'), 'utf-8');
    assert.ok(text.startsWith('---\nname: gsd-planner\n'), 'unexpected frontmatter: ' + JSON.stringify(text.slice(0, 60)));
    assert.ok(!text.includes('undefined'));
  });

  test('validate() accepts a CRLF agent directory', () => {
    const { validate } = require(path.join(ROOT, 'scripts', 'agent-compiler.cjs'));
    const r = validate(path.join(CRLF_TREE, 'get-shit-done', 'agents', 'gsd-planner'));
    assert.deepStrictEqual(r, { ok: true, errors: [] });
  });
});

describe('88-13 skill-compiler: CRLF SKILL.md compiles byte-identically to LF', () => {
  for (const target of ['claude', 'opencode']) {
    test('target ' + target, () => {
      const outLf = path.join(TMP, 'out-skill-lf-' + target);
      const outCrlf = path.join(TMP, 'out-skill-crlf-' + target);
      const pcLf = path.join(LF_TREE, 'get-shit-done', 'references', 'platform-codes.yaml');
      const pcCrlf = path.join(CRLF_TREE, 'get-shit-done', 'references', 'platform-codes.yaml');
      run('skill-compiler.cjs', ['--target=' + target, '--source=' + path.join(LF_TREE, 'get-shit-done', 'skills'), '--out=' + outLf], pcLf);
      run('skill-compiler.cjs', ['--target=' + target, '--source=' + path.join(CRLF_TREE, 'get-shit-done', 'skills'), '--out=' + outCrlf], pcCrlf);
      assertSameBytes(outLf, outCrlf, 3);
    });
  }

  test('validate() accepts a CRLF skill directory', () => {
    const { validate } = require(path.join(ROOT, 'scripts', 'skill-compiler.cjs'));
    const r = validate(path.join(CRLF_TREE, 'get-shit-done', 'skills', 'plan-phase'));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });
});

describe('88-13 agent-md-to-yaml: CRLF agents/*.md converts byte-identically to LF', () => {
  test('single file agents/gsd-planner.md', () => {
    const outLf = path.join(TMP, 'out-m2y-lf');
    const outCrlf = path.join(TMP, 'out-m2y-crlf');
    run('agent-md-to-yaml.cjs', [path.join(LF_TREE, 'agents', 'gsd-planner.md'), outLf], '');
    run('agent-md-to-yaml.cjs', [path.join(CRLF_TREE, 'agents', 'gsd-planner.md'), outCrlf], '');
    assertSameBytes(outLf, outCrlf, 1);
    const yaml = fs.readFileSync(path.join(outCrlf, 'gsd-planner', 'AGENT.yaml'), 'utf-8');
    assert.ok(/^ {2}name: gsd-planner$/m.test(yaml), 'name was not preserved from the CRLF source');
  });

  test('batch over the whole agents/ directory', () => {
    const outLf = path.join(TMP, 'out-m2y-batch-lf');
    const outCrlf = path.join(TMP, 'out-m2y-batch-crlf');
    run('agent-md-to-yaml.cjs', ['--batch', path.join(LF_TREE, 'agents'), outLf], '');
    run('agent-md-to-yaml.cjs', ['--batch', path.join(CRLF_TREE, 'agents'), outCrlf], '');
    assertSameBytes(outLf, outCrlf, 30);
  });
});
