/**
 * Phase 88 plan 88-09: the planning-drift verb (FND-06, FND-07).
 *
 * `.planning/` is gitignored, so everything here runs against the committed trees
 * in tests/fixtures/planning-drift/ (contract: that directory's README.md) and
 * against throwaway copies of them. No committed fixture is ever modified in
 * place, no network connection is opened, and nothing reads the operator's real
 * records.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'planning-drift');
const GSD_TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const MODULE = path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'planning-drift.cjs');
const { planningDrift } = require(MODULE);

const TMP_DIRS = [];

/**
 * Copy a fixture tree into a fresh temp directory.
 *
 * @param {string} name - Fixture tree name.
 * @returns {string} Path of the copy.
 * @throws {Error} when the fixture does not exist.
 */
function copyTree(name) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `pd-${name}-`));
  TMP_DIRS.push(dst);
  fs.cpSync(path.join(FIXTURES, name), dst, { recursive: true });
  return dst;
}

/**
 * Replace text in a file of a copied tree, failing loudly when the text is
 * absent so a mutation can never be vacuous.
 *
 * @param {string} dir - Tree root.
 * @param {string} file - Path relative to dir.
 * @param {string|RegExp} from - Text to replace.
 * @param {string} to - Replacement.
 * @returns {void}
 * @throws {assert.AssertionError} when `from` does not occur.
 */
function edit(dir, file, from, to) {
  const p = path.join(dir, file);
  const text = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
  const next = text.replace(from, to);
  assert.notStrictEqual(next, text, `mutation target not found in ${file}: ${from}`);
  fs.writeFileSync(p, next);
}

/**
 * @param {string} dir
 * @returns {string[]} sorted unique finding ids
 */
function ids(dir) {
  return [...new Set(planningDrift(dir).findings.map((f) => f.id))].sort();
}

/**
 * Run the real CLI.
 *
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function cli(args) {
  const r = spawnSync(process.execPath, [GSD_TOOLS, 'planning-drift', ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Parse the per-tree contract out of the fixture README.
 *
 * @returns {Object<string, {ids: string[], exit: number}>}
 */
function readContract() {
  const text = fs.readFileSync(path.join(FIXTURES, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
  const out = {};
  for (const block of text.split(/^### tree: /m).slice(1)) {
    const name = block.match(/^`([\w-]+)`/)[1];
    const idLine = block.match(/^- expected-ids: (.+)$/m)[1].trim();
    const exit = parseInt(block.match(/^- expected-exit: (\d)$/m)[1], 10);
    out[name] = { ids: idLine === '(none)' ? [] : idLine.split(',').map((s) => s.trim()).sort(), exit };
  }
  return out;
}

const CONTRACT = readContract();
const TREES = ['agree', 'disagree', 'exceptions', 'archived-milestone', 'unreadable-goal'];

test.after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

describe('88-09 per-tree contract (README is the single source)', () => {
  test('README declares all five trees', () => {
    assert.deepStrictEqual(Object.keys(CONTRACT).sort(), [...TREES].sort());
  });

  for (const name of TREES) {
    test(`${name}: finding ids match the README`, () => {
      assert.deepStrictEqual(ids(path.join(FIXTURES, name)), CONTRACT[name].ids);
    });
  }

  test('agree: a Not started phase with no directory is silent and decimal numbers parse', () => {
    const r = planningDrift(path.join(FIXTURES, 'agree'));
    assert.strictEqual(r.findings.length, 0);
    assert.strictEqual(r.exit_code, 0);
    assert.ok(fs.readFileSync(path.join(FIXTURES, 'agree', 'ROADMAP.md'), 'utf-8').includes('Phase 94.1'));
    assert.ok(!fs.existsSync(path.join(FIXTURES, 'agree', 'phases', '94.1-delta')));
  });

  test('unreadable-goal: exactly two findings and no cascade into DRIFT_PHASE_NOT_IN_ROADMAP', () => {
    const r = planningDrift(path.join(FIXTURES, 'unreadable-goal'));
    assert.strictEqual(r.findings.length, 2);
    assert.ok(!r.findings.some((f) => f.id === 'DRIFT_PHASE_NOT_IN_ROADMAP'));
    assert.ok(!r.findings.some((f) => f.id === 'DRIFT_ROADMAP_PHASE_MISSING_DIR'));
    const heading = r.findings.find((f) => f.id === 'DRIFT_ROADMAP_HEADING_UNPARSEABLE');
    assert.ok(heading.message.includes('## Phase 91 — Alpha Name'), 'message carries the literal heading line');
    const field = r.findings.find((f) => f.id === 'DRIFT_ROADMAP_FIELD_UNREADABLE');
    assert.ok(field.message.includes('Phase 92') && field.message.includes('Goal'), field.message);
  });

  test('archived-milestone: no spurious findings (the 64 W007 warnings of validate health)', () => {
    // Phase 20 is listed only in milestones/v3.4-ROADMAP.md and phase 21 only in the
    // collapsed Earlier Work block. `validate health` reports 64 W007 warnings for
    // exactly this shape on the real records; planning-drift must report none.
    const r = planningDrift(path.join(FIXTURES, 'archived-milestone'));
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.exit_code, 0);
  });
});

describe('88-09 exit codes', () => {
  for (const name of TREES) {
    test(`${name}: function and CLI exit ${CONTRACT[name].exit}`, () => {
      const dir = path.join(FIXTURES, name);
      assert.strictEqual(planningDrift(dir).exit_code, CONTRACT[name].exit);
      assert.strictEqual(cli(['--root', dir]).status, CONTRACT[name].exit);
      assert.strictEqual(cli(['--root', dir, '--json']).status, CONTRACT[name].exit);
    });
  }

  test('usage errors exit 2, not 1', () => {
    assert.strictEqual(cli(['--root', path.join(FIXTURES, 'does-not-exist')]).status, 2);
    assert.strictEqual(cli(['--root']).status, 2);
  });

  test('human report: summary line and per-finding line shape', () => {
    const agree = cli(['--root', path.join(FIXTURES, 'agree')]);
    assert.match(agree.stdout.trim().split('\n').pop(), /^planning-drift: records agree \(0 excepted\)$/);
    const bad = cli(['--root', path.join(FIXTURES, 'exceptions')]);
    const lines = bad.stdout.trim().split('\n');
    assert.match(lines[lines.length - 1], /^planning-drift: 7 findings \(1 excepted\)$/);
    assert.ok(lines.some((l) => /^(error|warning) DRIFT_PLAN_WITHOUT_SUMMARY \S+: .* \[excepted\]$/.test(l)), lines.join('\n'));
  });

  test('--help lists the verb', () => {
    const r = spawnSync(process.execPath, [GSD_TOOLS, '--help'], { encoding: 'utf-8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /planning-drift \[--root <dir>\] \[--json\]/);
  });
});

describe('88-09 --json shape', () => {
  test('stdout is exactly one JSON object with the documented keys', () => {
    const r = cli(['--root', path.join(FIXTURES, 'exceptions'), '--json']);
    const obj = JSON.parse(r.stdout);
    assert.deepStrictEqual(Object.keys(obj).sort(), ['counts', 'excepted', 'exit_code', 'findings', 'root']);
    assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'no text besides the object');
    assert.strictEqual(obj.exit_code, 1);
    assert.deepStrictEqual(Object.keys(obj.counts).sort(), ['error', 'excepted', 'warning']);
    assert.strictEqual(obj.counts.excepted, 1);
    for (const f of obj.findings) {
      for (const k of ['id', 'severity', 'files', 'message', 'excepted']) assert.ok(k in f, `finding lacks ${k}`);
      assert.ok(['error', 'warning'].includes(f.severity));
      assert.ok(Array.isArray(f.files) && f.files.length > 0);
    }
    assert.strictEqual(obj.excepted.length, obj.findings.filter((f) => f.excepted).length);
  });
});

describe('88-09 exceptions list', () => {
  test('an excepted finding is shown, flagged, and does not drive the exit code alone', () => {
    const r = planningDrift(path.join(FIXTURES, 'exceptions'));
    assert.strictEqual(r.excepted.length, 1);
    assert.strictEqual(r.excepted[0].id, 'DRIFT_PLAN_WITHOUT_SUMMARY');
    assert.ok(r.findings.some((f) => f.id === 'DRIFT_PLAN_WITHOUT_SUMMARY' && f.excepted === true));
    // six other findings still fail the run
    assert.strictEqual(r.exit_code, 1);

    // alone, the same excepted finding exits 0
    const dir = copyTree('agree');
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-01-SUMMARY.md'));
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
      { target: '10-01-PLAN.md', phase: '10-alpha', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'MILESTONES.md#x', date: '2026-11-11' },
    ] }));
    const solo = planningDrift(dir);
    assert.strictEqual(solo.excepted.length, 1);
    assert.strictEqual(solo.exit_code, 0);
  });

  test('no exceptions file: empty list, no throw', () => {
    const r = planningDrift(path.join(FIXTURES, 'agree'));
    assert.strictEqual(r.excepted.length, 0);
    assert.strictEqual(r.exit_code, 0);
  });

  test('an exception matches on phase too: the same file name in another phase does not borrow it', () => {
    const dir = copyTree('agree');
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-01-SUMMARY.md'));
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
      { target: '10-01-PLAN.md', phase: '11-beta', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'x', date: '2026-11-11' },
    ] }));
    const r = planningDrift(dir);
    assert.strictEqual(r.exit_code, 1);
    assert.ok(r.findings.some((f) => f.id === 'DRIFT_PLAN_WITHOUT_SUMMARY' && f.excepted === false));
  });

  test('stale exception: the plan has a summary now -> error, exit 1, exact message', () => {
    const dir = copyTree('agree');
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
      { target: '10-01-PLAN.md', phase: '10-alpha', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'x', date: '2026-11-11' },
    ] }));
    const r = planningDrift(dir);
    const stale = r.findings.find((f) => f.id === 'DRIFT_EXCEPTION_STALE');
    assert.ok(stale);
    assert.strictEqual(stale.severity, 'error');
    assert.strictEqual(stale.message, 'exception for 10-01-PLAN.md no longer applies: DRIFT_PLAN_WITHOUT_SUMMARY did not fire; remove it from drift-exceptions.json');
    assert.strictEqual(r.exit_code, 1);
  });

  test('unmatched exception: target is nowhere on disk -> reported separately from stale', () => {
    const dir = copyTree('agree');
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
      { target: '55-01-PLAN.md', phase: '55-ghost', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'x', date: '2026-11-11' },
    ] }));
    const r = planningDrift(dir);
    assert.deepStrictEqual(ids(dir), ['DRIFT_EXCEPTION_UNMATCHED']);
    assert.strictEqual(r.exit_code, 1);
  });

  test('malformed exception: a missing field is reported and the entry is not honoured', () => {
    const dir = copyTree('agree');
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-01-SUMMARY.md'));
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
      { target: '10-01-PLAN.md', phase: '10-alpha', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', recorded_in: 'x', date: '2026-11-11' },
    ] }));
    const r = planningDrift(dir);
    const bad = r.findings.find((f) => f.id === 'DRIFT_EXCEPTION_MALFORMED');
    assert.ok(bad && bad.message.includes('reason'), bad && bad.message);
    assert.ok(r.findings.some((f) => f.id === 'DRIFT_PLAN_WITHOUT_SUMMARY' && f.excepted === false));
    assert.strictEqual(r.exit_code, 1);
  });

  test('invalid JSON is a malformed finding, not a throw', () => {
    const dir = copyTree('agree');
    fs.writeFileSync(path.join(dir, 'drift-exceptions.json'), '{ not json');
    assert.deepStrictEqual(ids(dir), ['DRIFT_EXCEPTION_MALFORMED']);
  });
});

describe('88-09 rules recorded in 88-CONTEXT.md and 88-09-PLAN.md', () => {
  test('unstarted statuses stay silent in any case and spacing; In progress fires', () => {
    for (const status of ['not started', '  TBD ', 'Planned']) {
      const dir = copyTree('agree');
      edit(dir, 'ROADMAP.md', '| Not started |', `| ${status} |`);
      assert.deepStrictEqual(ids(dir), [], `status "${status}"`);
    }
    const dir = copyTree('agree');
    edit(dir, 'ROADMAP.md', '| Not started |', '| In progress |');
    const r = planningDrift(dir);
    const f = r.findings.find((x) => x.id === 'DRIFT_ROADMAP_PHASE_MISSING_DIR');
    assert.ok(f, 'In progress with no directory fires');
    assert.ok(f.message.includes('In progress') && f.message.includes('94.1'), f.message);
    assert.strictEqual(r.exit_code, 1);
  });

  test('without a progress row the ticked checkbox decides, then STATE.md', () => {
    const boxed = copyTree('agree');
    edit(boxed, 'ROADMAP.md', /\| 94\.1\. Delta[^\n]*\n/, '');
    edit(boxed, 'ROADMAP.md', '- [ ] **Phase 94.1', '- [x] **Phase 94.1');
    assert.ok(ids(boxed).includes('DRIFT_ROADMAP_PHASE_MISSING_DIR'));

    const unticked = copyTree('agree');
    edit(unticked, 'ROADMAP.md', /\| 94\.1\. Delta[^\n]*\n/, '');
    assert.ok(!ids(unticked).includes('DRIFT_ROADMAP_PHASE_MISSING_DIR'));

    // with neither a row nor a checkbox, STATE.md decides
    const current = copyTree('agree');
    edit(current, 'ROADMAP.md', /\| 94\.1\. Delta[^\n]*\n/, '');
    edit(current, 'ROADMAP.md', /- \[ \] \*\*Phase 94\.1[^\n]*\n/, '');
    edit(current, 'STATE.md', '# Project State\n', '# Project State\n\nPhase: 94.1 of 4\n');
    assert.ok(ids(current).includes('DRIFT_ROADMAP_PHASE_MISSING_DIR'));
  });

  test('the STATE.md current phase is in flight: unsummarised plans are not drift, until STATE moves on', () => {
    const dir = copyTree('agree');
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-01-SUMMARY.md'));
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-VERIFICATION.md'));
    edit(dir, 'STATE.md', '# Project State\n', '# Project State\n\nPhase: 10 of 4\n');
    assert.deepStrictEqual(ids(dir), []);
    edit(dir, 'STATE.md', 'Phase: 10 of 4', 'Phase: 11 of 4');
    assert.deepStrictEqual(ids(dir), ['DRIFT_PLAN_WITHOUT_SUMMARY']);
  });

  test('a phase is not due a VERIFICATION while one of its plans has no summary', () => {
    const dir = copyTree('agree');
    fs.rmSync(path.join(dir, 'phases', '10-alpha', '10-VERIFICATION.md'));
    fs.writeFileSync(path.join(dir, 'phases', '10-alpha', '10-02-PLAN.md'), '# Plan 10-02\n');
    assert.deepStrictEqual(ids(dir), ['DRIFT_PLAN_WITHOUT_SUMMARY']);
  });

  test('requirement totals: file, stated and counted are named; old-milestone counts are not totals', () => {
    const dir = copyTree('agree');
    edit(dir, 'PROJECT.md', '(4 requirements: FIX)', '(7 requirements: FIX)');
    const f = planningDrift(dir).findings.find((x) => x.id === 'DRIFT_REQUIREMENT_TOTAL');
    assert.ok(f, 'PROJECT.md total disagrees');
    assert.ok(f.message.includes('PROJECT.md') && f.message.includes('7') && f.message.includes('4'), f.message);

    const hist = copyTree('agree');
    fs.appendFileSync(path.join(hist, 'PROJECT.md'), '\nv3.0 shipped 10 phases, 24 plans, 55 requirements.\n');
    assert.deepStrictEqual(ids(hist), []);

    const rows = copyTree('agree');
    edit(rows, 'REQUIREMENTS.md', /\| FIX-04 \|[^\n]*\n/, '');
    assert.ok(planningDrift(rows).findings.some((x) => x.id === 'DRIFT_REQUIREMENT_TOTAL' && /traceability/.test(x.message)));
  });

  test('CRLF checkouts (Windows autocrlf) read the same as LF ones', () => {
    for (const name of ['agree', 'disagree']) {
      const dir = copyTree(name);
      for (const f of ['ROADMAP.md', 'STATE.md', 'REQUIREMENTS.md', 'PROJECT.md']) {
        const p = path.join(dir, f);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace(/\n/g, '\r\n'));
      }
      assert.deepStrictEqual(ids(dir), CONTRACT[name].ids, name);
    }
  });

  test('a decimal phase directory (94.1-*) is matched to its heading, not to 94', () => {
    const dir = copyTree('agree');
    edit(dir, 'ROADMAP.md', '| Not started |', '| In progress |');
    fs.mkdirSync(path.join(dir, 'phases', '94.1-delta'));
    fs.writeFileSync(path.join(dir, 'phases', '94.1-delta', '94.1-CONTEXT.md'), '# c\n');
    assert.deepStrictEqual(ids(dir), []);
  });
});

describe('88-09 parser parity with `roadmap analyze`', () => {
  // planning-drift restates the roadmap parser's regexes (roadmap.cjs exports no pure
  // parser). This test keeps the two honest: a phase has an unreadable Goal here exactly
  // when `roadmap analyze` returns goal === null for it, and a heading is unparseable
  // exactly when analyze does not list the phase.
  for (const name of ['agree', 'unreadable-goal']) {
    test(`${name}: drift findings agree with roadmap analyze`, () => {
      const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-parity-'));
      TMP_DIRS.push(holder);
      fs.cpSync(path.join(FIXTURES, name), path.join(holder, '.planning'), { recursive: true });
      const r = spawnSync(process.execPath, [GSD_TOOLS, 'roadmap', 'analyze', '--cwd', holder], { encoding: 'utf-8' });
      assert.strictEqual(r.status, 0, r.stderr);
      const analysed = JSON.parse(r.stdout).phases;
      const drift = planningDrift(path.join(holder, '.planning')).findings;
      const nullGoal = analysed.filter((p) => p.goal === null).map((p) => p.number).sort();
      const flaggedGoal = drift
        .filter((f) => f.id === 'DRIFT_ROADMAP_FIELD_UNREADABLE' && /Goal/.test(f.message))
        .map((f) => f.message.match(/^Phase (\S+):/)[1]).sort();
      assert.deepStrictEqual(flaggedGoal, nullGoal);
      const nullDepends = analysed.filter((p) => p.depends_on === null).length;
      assert.strictEqual(drift.filter((f) => f.id === 'DRIFT_ROADMAP_FIELD_UNREADABLE' && /Depends on/.test(f.message)).length, nullDepends);
      const headings = fs.readFileSync(path.join(FIXTURES, name, 'ROADMAP.md'), 'utf-8').match(/^#{2,4}\s*Phase\s+\d+/gm).length;
      assert.strictEqual(drift.filter((f) => f.id === 'DRIFT_ROADMAP_HEADING_UNPARSEABLE').length, headings - analysed.length);
    });
  }
});

describe('88-09 mutation checks: every finding id fires, nothing is dead code', () => {
  // Each row introduces exactly the defect its id describes into a copy of the
  // `agree` tree. Adding a check to planning-drift.cjs without a row here fails
  // the coverage test below.
  const MUTATIONS = [
    { id: 'DRIFT_PHASE_NOT_IN_ROADMAP', mutate: (d) => { fs.mkdirSync(path.join(d, 'phases', '99-orphan')); } },
    { id: 'DRIFT_ROADMAP_PHASE_MISSING_DIR', mutate: (d) => edit(d, 'ROADMAP.md', '| Not started |', '| In progress |') },
    { id: 'DRIFT_STATE_PROGRESS', mutate: (d) => edit(d, 'STATE.md', 'completed_phases: 3', 'completed_phases: 2') },
    { id: 'DRIFT_STATE_PHASE_MAP', mutate: (d) => edit(d, 'STATE.md', /\| 11 \| Beta[^\n]*\n/, '') },
    { id: 'DRIFT_REQUIREMENT_TOTAL', mutate: (d) => edit(d, 'REQUIREMENTS.md', 'v1 requirements: 4 total', 'v1 requirements: 5 total') },
    { id: 'DRIFT_PLAN_WITHOUT_SUMMARY', mutate: (d) => fs.rmSync(path.join(d, 'phases', '10-alpha', '10-01-SUMMARY.md')) },
    { id: 'DRIFT_SUMMARY_WITHOUT_PLAN', mutate: (d) => fs.rmSync(path.join(d, 'phases', '10-alpha', '10-01-PLAN.md')) },
    { id: 'DRIFT_SUMMARY_WITHOUT_VERIFICATION', mutate: (d) => fs.rmSync(path.join(d, 'phases', '10-alpha', '10-VERIFICATION.md')) },
    { id: 'DRIFT_ROADMAP_HEADING_UNPARSEABLE', mutate: (d) => edit(d, 'ROADMAP.md', '### Phase 12: Gamma', '### Phase 12 - Gamma') },
    { id: 'DRIFT_ROADMAP_FIELD_UNREADABLE', mutate: (d) => edit(d, 'ROADMAP.md', '**Goal:** Gamma works.', '**Goal**: Gamma works.') },
    {
      id: 'DRIFT_EXCEPTION_MALFORMED',
      mutate: (d) => fs.writeFileSync(path.join(d, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [{ target: 'x' }] })),
    },
    {
      id: 'DRIFT_EXCEPTION_STALE',
      mutate: (d) => fs.writeFileSync(path.join(d, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
        { target: '10-01-PLAN.md', phase: '10-alpha', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'x', date: '2026-11-11' },
      ] })),
    },
    {
      id: 'DRIFT_EXCEPTION_UNMATCHED',
      mutate: (d) => fs.writeFileSync(path.join(d, 'drift-exceptions.json'), JSON.stringify({ schema: 1, exceptions: [
        { target: 'nothing-here.md', phase: '10-alpha', finding: 'DRIFT_PLAN_WITHOUT_SUMMARY', reason: 'r', recorded_in: 'x', date: '2026-11-11' },
      ] })),
    },
  ];

  test('the unmutated agree tree emits nothing', () => {
    assert.deepStrictEqual(ids(path.join(FIXTURES, 'agree')), []);
  });

  for (const row of MUTATIONS) {
    test(`${row.id} fires and exits 1`, () => {
      const dir = copyTree('agree');
      row.mutate(dir);
      const r = planningDrift(dir);
      assert.ok(r.findings.some((f) => f.id === row.id && f.excepted === false), `${row.id} not emitted; got ${ids(dir)}`);
      assert.strictEqual(r.exit_code, 1);
      assert.strictEqual(cli(['--root', dir]).status, 1);
    });
  }

  test('an unparseable heading yields its own finding and does not cascade', () => {
    const dir = copyTree('agree');
    edit(dir, 'ROADMAP.md', '### Phase 12: Gamma', '### Phase 12 - Gamma');
    assert.deepStrictEqual(ids(dir), ['DRIFT_ROADMAP_HEADING_UNPARSEABLE']);
  });

  test('the table covers every finding id the implementation can emit', () => {
    const source = fs.readFileSync(MODULE, 'utf-8');
    const prefix = 'DRIFT';
    const emitted = [...new Set(source.match(new RegExp(`${prefix}_[A-Z_]*[A-Z]`, 'g')))].sort();
    assert.deepStrictEqual(MUTATIONS.map((m) => m.id).sort(), emitted);
  });

  test('no committed fixture was modified in place', () => {
    const r = spawnSync('git', ['status', '--porcelain', '--', 'tests/fixtures/planning-drift'], { cwd: ROOT, encoding: 'utf-8' });
    if (r.status !== 0) return; // not a git checkout (npm tarball): nothing to compare
    assert.strictEqual(r.stdout.trim(), '');
  });
});
