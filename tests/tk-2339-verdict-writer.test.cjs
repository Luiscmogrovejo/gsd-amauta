#!/usr/bin/env node
/**
 * TK-2339 — the verdict writer: one location, three verdicts, no `unknown`.
 *
 * Every test here fails against the pre-TK-2339 code. That is the point:
 * the pre-existing suite was 13/13 green against both defects, and one of its
 * assertions (`verdict === 'gaps_found'`) actively blessed the second one.
 *
 * Covered:
 *   01. writeGapsReport files under .planning/phases/<phase>/gaps-reports/
 *   02. writeGapsReport NEVER writes to .planning/milestones/
 *   03. an unresolvable phase throws phase_unresolved and writes nothing
 *   04. a TK- id alone does not resolve a phase (the historic silent path)
 *   05. a numeric plan id still resolves a phase
 *   06. all three SUP-02 verdicts are expressible
 *   07. a non-SUP-02 verdict is refused
 *   08. legacy lowercase verdicts are accepted on READ, never on write
 *   09. a PASS carrying gaps is refused (SUP-03 recovery paths stay apart)
 *   10. task_id is validated — path traversal is refused
 *   11. non-TK ids in the corpus (LANE-A, SUP-11-12) are permitted
 *   12. findGapsReports reads back what writeGapsReport wrote
 *   13. findGapsReports surfaces pre-TK-2339 stragglers, never hides them
 *   14. ROUND-TRIP (C4): CLI writes a PASS, CLI scan finds it, verdict reads
 *       back as PASS — three separate processes, no human moving anything
 *   15. CLI refuses --gaps-found with an unresolvable phase, loudly
 *   16. the allowlist glob in gsd-tools.cjs matches what the writer writes
 *
 * Run: node --test tests/tk-2339-verdict-writer.test.cjs
 *
 * Temp-dir discipline matches tests/13.1-manifest-check.test.cjs: each test
 * gets its own dir under os.tmpdir() and the path is logged and preserved on
 * failure for post-mortem.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_AMAUTA = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

process.env.GSD_AMAUTA_NO_AUTO_START = '1';
process.env.GSD_AMAUTA_PORT = process.env.GSD_AMAUTA_PORT || '19996';

const amauta = require(GSD_AMAUTA);
const {
  writeGapsReport,
  readGapsReport,
  findGapsReports,
  resolveGapsPhase,
  normaliseVerdict,
  CANONICAL_VERDICTS,
  GAPS_REPORT_GLOB,
} = amauta;

const PHASE = '00-foundations-and-baseline';

// ── Helpers ────────────────────────────────────────────────────────────────

// realpathSync: os.tmpdir() resolves through a symlink on macOS, and the
// writer builds its path from process.cwd(), which is already resolved.
function mkTemp(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gsd-tk2339-${label}-`)));
}

function cleanupOrPreserve(tmpDir, err) {
  if (err) {
    console.error(`[preserve] ${tmpDir}`);
    throw err;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Run a function with cwd set to `dir`, restoring cwd unconditionally. */
function inCwd(dir, fn) {
  const orig = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(orig);
  }
}

/** Every file under a directory, as repo-relative POSIX paths. */
function walkRel(root, dir = root, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRel(root, p, acc);
    else acc.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * Run the CLI against a PRIVATE task store on a port no daemon is listening
 * on. Both matter: GSD_AMAUTA_PORT forces the direct (no-daemon) path so the
 * test cannot reach the live daemon this session depends on, and
 * AMAUTA_DATA_DIR keeps every task these tests mint out of the real store.
 */
function runCli(cwd, args, dataDir) {
  return spawnSync(process.execPath, [GSD_AMAUTA, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GSD_AMAUTA_NO_AUTO_START: '1',
      GSD_AMAUTA_PORT: process.env.GSD_AMAUTA_PORT,
      ...(dataDir ? { AMAUTA_DATA_DIR: dataDir } : {}),
    },
  });
}

// ── 01 / 02 — where the artefact lands ─────────────────────────────────────

test('01. writeGapsReport files under .planning/phases/<phase>/gaps-reports/', () => {
  const tmp = mkTemp('loc');
  let err;
  try {
    const p = inCwd(tmp, () => writeGapsReport(PHASE, 'TK-2339', [], []));
    const rel = path.relative(tmp, p).split(path.sep).join('/');
    assert.equal(path.dirname(rel), `.planning/phases/${PHASE}/gaps-reports`);
    assert.match(path.basename(rel), /^TK-2339-gaps-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('02. writeGapsReport never creates .planning/milestones/', () => {
  const tmp = mkTemp('nomilestones');
  let err;
  try {
    inCwd(tmp, () => {
      writeGapsReport(PHASE, 'TK-2339', [], []);
      writeGapsReport('13.1', '13.1-04-01', [], [], 'PASS');
    });
    const files = walkRel(tmp);
    assert.ok(files.length >= 2, `expected reports, got ${JSON.stringify(files)}`);
    const stray = files.filter((f) => f.includes('.planning/milestones/'));
    assert.deepEqual(stray, [], `writer must not touch .planning/milestones/, found ${JSON.stringify(stray)}`);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

// ── 03 / 04 / 05 — the `unknown` default is gone and loud ──────────────────

test('03. an unresolvable phase throws phase_unresolved and writes nothing', () => {
  const tmp = mkTemp('nophase');
  let err;
  try {
    let thrown = null;
    inCwd(tmp, () => {
      try { writeGapsReport(undefined, 'TK-2339', [], []); } catch (e) { thrown = e; }
    });
    assert.ok(thrown, 'a phase-less write must throw, not succeed into "unknown"');
    assert.equal(thrown.code, 'phase_unresolved');
    // The message must NAME what was missing and how to supply it.
    assert.match(thrown.message, /--phase/, 'message must name the missing input');
    assert.match(thrown.message, /TK-2339/, 'message must quote the id it could not derive from');
    assert.match(thrown.message, /never filed under a directory named "unknown"/);
    assert.deepEqual(walkRel(tmp), [], 'a refused write must leave no files at all');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('04. a TK- id alone does not resolve a phase', () => {
  // This is the exact mechanism behind every misfiled report: phase was only
  // ever derived from a LEADING NUMERIC segment, which no TK- id has.
  assert.throws(() => resolveGapsPhase({ taskId: 'TK-2339' }), (e) => e.code === 'phase_unresolved');
  assert.throws(() => resolveGapsPhase({ taskId: 'LANE-A' }), (e) => e.code === 'phase_unresolved');
  assert.throws(() => resolveGapsPhase({}), (e) => e.code === 'phase_unresolved');
  assert.throws(() => resolveGapsPhase({ phase: '   ' }), (e) => e.code === 'phase_unresolved');
});

test('05. a numeric plan id still resolves a phase, and --phase always wins', () => {
  assert.equal(resolveGapsPhase({ taskId: '13.1-04-01' }), '13.1');
  assert.equal(resolveGapsPhase({ taskId: '9-03-02' }), '9');
  assert.equal(resolveGapsPhase({ taskId: '78' }), '78');
  assert.equal(resolveGapsPhase({ phase: PHASE, taskId: '13.1-04-01' }), PHASE);
});

// ── 06 / 07 / 08 — three verdicts, canonical casing ────────────────────────

test('06. all three SUP-02 verdicts are expressible by the writer', () => {
  const tmp = mkTemp('verdicts');
  let err;
  try {
    assert.deepEqual(CANONICAL_VERDICTS, ['PASS', 'FAIL', 'GAPS-FOUND']);
    const written = inCwd(tmp, () => CANONICAL_VERDICTS.map((v, i) =>
      writeGapsReport(PHASE, `TK-000${i}`, [], [], v)));
    const got = written.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')).verdict);
    assert.deepEqual(got, ['PASS', 'FAIL', 'GAPS-FOUND']);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('07. a verdict outside SUP-02 is refused', () => {
  const tmp = mkTemp('badverdict');
  let err;
  try {
    for (const bad of ['ok', 'passed', 'true', '', null, undefined === undefined ? 'BLOCKED' : '']) {
      let thrown = null;
      inCwd(tmp, () => {
        try { writeGapsReport(PHASE, 'TK-2339', [], [], bad); } catch (e) { thrown = e; }
      });
      assert.ok(thrown, `verdict ${JSON.stringify(bad)} must be refused`);
      assert.equal(thrown.code, 'invalid_verdict');
    }
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('08. legacy lowercase verdicts are accepted on READ, never emitted', () => {
  const tmp = mkTemp('legacyverdict');
  let err;
  try {
    // Exactly the shape of the seven filed reports written before this fix.
    const dir = path.join(tmp, '.planning', 'phases', PHASE, 'gaps-reports');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, 'TK-2211-gaps-2026-08-30T145048Z.json');
    fs.writeFileSync(legacy, JSON.stringify({
      phase: 'unknown', timestamp: '2026-08-30T14:50:48Z', task_id: 'TK-2211',
      verdict: 'gaps_found', gaps: [], non_gaps_observations: [],
    }, null, 2));

    const read = readGapsReport(legacy);
    assert.equal(read.verdict, 'GAPS-FOUND', 'legacy form must normalise on read');
    assert.equal(read.raw_verdict, 'gaps_found', 'the bytes on disk are reported unchanged');
    assert.equal(read.legacy_verdict_form, true);
    // ...and the file itself was not rewritten.
    assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf8')).verdict, 'gaps_found');

    // The writer, given the same legacy string, emits the canonical form.
    const fresh = inCwd(tmp, () => writeGapsReport(PHASE, 'TK-2339', [], [], 'gaps_found'));
    assert.equal(JSON.parse(fs.readFileSync(fresh, 'utf8')).verdict, 'GAPS-FOUND');
    assert.equal(normaliseVerdict('PASS'), 'PASS');
    assert.equal(normaliseVerdict('pass'), 'PASS');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('09. a PASS carrying gaps is refused', () => {
  const tmp = mkTemp('passgaps');
  let err;
  try {
    let thrown = null;
    inCwd(tmp, () => {
      try {
        writeGapsReport(PHASE, 'TK-2339', [{ requirement_id: 'SUP-02', description: 'x' }], [], 'PASS');
      } catch (e) { thrown = e; }
    });
    assert.ok(thrown, 'PASS with gaps must be refused');
    assert.equal(thrown.code, 'pass_with_gaps');
    assert.deepEqual(walkRel(tmp), [], 'a refused write must leave no files');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

// ── 10 / 11 — task_id is now a path segment, so it is validated ────────────

test('10. task_id path traversal is refused', () => {
  const tmp = mkTemp('traversal');
  let err;
  try {
    for (const bad of ['../../../etc/pwn', 'a/b', 'a\\b', '', '   ', '..', 'has space', null, 42]) {
      let thrown = null;
      inCwd(tmp, () => {
        try { writeGapsReport(PHASE, bad, [], []); } catch (e) { thrown = e; }
      });
      assert.ok(thrown, `task_id ${JSON.stringify(bad)} must be refused`);
      assert.ok(['invalid_identifier', 'phase_unresolved'].includes(thrown.code),
        `unexpected code ${thrown.code} for ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(walkRel(tmp), [], 'no refused id may create a file');
    // The same rule applies to phase, which is also a path segment.
    assert.throws(() => resolveGapsPhase({ phase: '../../etc' }), (e) => e.code === 'invalid_identifier');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('11. the non-TK ids already in the corpus are permitted', () => {
  const tmp = mkTemp('nontk');
  let err;
  try {
    // LANE-A and SUP-11-12 are both real, filed task_ids for review units that
    // had no task to name. C6 resolves in favour of permitting the wider form
    // rather than forcing a task to be minted for a lane review.
    for (const id of ['LANE-A', 'SUP-11-12', 'TK-2339', '13.1-04-01', 'lane_g']) {
      const p = inCwd(tmp, () => writeGapsReport(PHASE, id, [], [], 'PASS'));
      assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).task_id, id);
      assert.ok(path.basename(p).startsWith(`${id}-gaps-`));
    }
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

// ── 12 / 13 — the scan ─────────────────────────────────────────────────────

test('12. findGapsReports reads back what writeGapsReport wrote', () => {
  const tmp = mkTemp('scan');
  let err;
  try {
    inCwd(tmp, () => {
      writeGapsReport(PHASE, 'TK-0001', [], [], 'PASS');
      writeGapsReport(PHASE, 'TK-0002', [{ requirement_id: 'SUP-02', description: 'x' }], [], 'GAPS-FOUND');
      writeGapsReport(PHASE, 'TK-0003', [], [], 'FAIL');
      writeGapsReport('13.1', 'TK-0004', [], [], 'PASS'); // different phase — must not leak in
    });
    const scan = findGapsReports(PHASE, { cwd: tmp });
    assert.equal(scan.reports.length, 3, `expected 3 reports in ${PHASE}, got ${scan.reports.length}`);
    assert.deepEqual(
      scan.reports.map((r) => [r.task_id, r.verdict]).sort(),
      [['TK-0001', 'PASS'], ['TK-0002', 'GAPS-FOUND'], ['TK-0003', 'FAIL']],
    );
    for (const r of scan.reports) {
      assert.equal(r.parse_error, null, `report ${r.path} must parse`);
      assert.equal(r.phase, PHASE);
    }
    assert.deepEqual(scan.legacy_unmigrated, []);
    // Unknown phase is an empty result, not a crash and not a fallback.
    assert.deepEqual(findGapsReports('99-nothing-here', { cwd: tmp }).reports, []);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('13. findGapsReports surfaces pre-TK-2339 stragglers instead of hiding them', () => {
  const tmp = mkTemp('legacyscan');
  let err;
  try {
    // Reproduce the two shapes actually found on disk across four repos:
    // milestones/<phase>/ and the milestones/unknown/ sink.
    for (const d of [
      path.join(tmp, '.planning', 'milestones', PHASE),
      path.join(tmp, '.planning', 'milestones', 'unknown'),
    ]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'gaps-report-2026-08-26T13-51-54-731Z.json'),
        JSON.stringify({ phase: 'unknown', verdict: 'gaps_found', task_id: 'TK-9999', gaps: [], non_gaps_observations: [] }));
    }
    const scan = findGapsReports(PHASE, { cwd: tmp });
    assert.equal(scan.reports.length, 0, 'legacy files are NOT read as canonical');
    assert.equal(scan.legacy_unmigrated.length, 2,
      `both stragglers must be reported, got ${JSON.stringify(scan.legacy_unmigrated)}`);
    assert.ok(scan.legacy_unmigrated.some((p) => p.includes(`${path.sep}unknown${path.sep}`)),
      'the milestones/unknown sink must be named explicitly');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

// ── 14 — C4: the round trip, done by the tool, across three processes ──────

test('14. ROUND-TRIP: CLI writes a PASS, CLI scan finds it, verdict reads back PASS', () => {
  const tmp = mkTemp('roundtrip');
  let err;
  try {
    // A private task store: this test must never touch the live one, and the
    // verdict has to be recorded against a task that actually exists or the
    // artefact write is (correctly) never reached.
    const dataDir = path.join(tmp, 'private-store');
    fs.mkdirSync(dataDir, { recursive: true });
    const add = runCli(tmp, ['add', 'task', 'TK-2339 round-trip fixture', '--agent', 'tk-2339-fixture'], dataDir);
    assert.equal(add.status, 0, `fixture task could not be minted: ${add.stderr || add.stdout}`);
    const mintedId = (add.stdout.match(/TK-\d+/) || [])[0];
    assert.ok(mintedId, `could not read the minted task id from: ${add.stdout}`);

    // (1) WRITTEN BY THE TOOL. --force-reason skips the gate flow; the
    // artefact path and verdict are what is under test, not the gates.
    const write = runCli(tmp, [
      'validate', mintedId, '--pass',
      '--phase', PHASE,
      '--validator', 'tk-2339-roundtrip',
      '--force-reason', 'round-trip fixture',
      '--notes', 'independently generated counter-proof',
    ], dataDir);
    assert.equal(write.status, 0,
      `CLI --pass failed (status ${write.status}): ${write.stderr || write.stdout}`);

    // (2) FOUND BY THE SCAN — a separate process, nothing moved by hand.
    const scan = runCli(tmp, ['gaps-reports', PHASE, '--json'], dataDir);
    assert.equal(scan.status, 0, `scan failed: ${scan.stderr}`);
    const parsed = JSON.parse(scan.stdout);

    // (3) READ BACK AS PASS. The success message is not the evidence.
    const mine = parsed.reports.filter((r) => r.task_id === mintedId);
    assert.equal(mine.length, 1,
      `scan must find exactly the report the tool wrote; found ${parsed.reports.length} report(s) ` +
      `in ${parsed.dir}: ${JSON.stringify(parsed.reports.map((r) => r.path))}`);
    assert.equal(mine[0].verdict, 'PASS', 'the verdict must read back as PASS, not as GAPS-FOUND');
    assert.equal(mine[0].phase, PHASE);
    assert.equal(mine[0].legacy_verdict_form, false);
    assert.ok(mine[0].non_gaps_observations.some((o) => o.startsWith('verdict_notes:')));
    // And the file the scan named is really on disk where the writer put it.
    const rel = path.relative(tmp, mine[0].path).split(path.sep).join('/');
    assert.equal(path.dirname(rel), `.planning/phases/${PHASE}/gaps-reports`);
    assert.ok(fs.existsSync(mine[0].path));
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('15. the CLI refuses --gaps-found with an unresolvable phase, loudly', () => {
  const tmp = mkTemp('cli-nophase');
  let err;
  try {
    const r = runCli(tmp, ['validate', 'TK-2339', '--gaps-found', '--gap', 'SUP-02:x'], path.join(tmp, 'private-store'));
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /phase could not be resolved/);
    assert.match(r.stderr, /--phase/);
    assert.deepEqual(walkRel(tmp), [], 'a refused CLI run must write nothing at all');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

// ── 16 — writer and manifest allowlist must not drift apart ────────────────

test('16. the manifest allowlist glob matches what the writer writes', () => {
  const tmp = mkTemp('allowlist');
  let err;
  try {
    const { GLOBAL_ALLOWLIST } = require(GSD_TOOLS);
    assert.ok(GLOBAL_ALLOWLIST.includes(GAPS_REPORT_GLOB),
      `gsd-tools GLOBAL_ALLOWLIST must contain ${GAPS_REPORT_GLOB}; has ${JSON.stringify(GLOBAL_ALLOWLIST)}`);

    // The generated artefact must agree with the constant it is generated from.
    const emitted = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'get-shit-done', 'config', 'hook-allowlists.json'), 'utf8'));
    assert.ok(emitted.global_allowlist.includes(GAPS_REPORT_GLOB),
      'hook-allowlists.json is stale — re-run `gsd-tools hook-config emit`');

    // And a real written path must actually match the glob, not merely
    // resemble it. A glob that agrees with the writer in prose but not in
    // characters would turn every filed verdict into manifest drift.
    const p = inCwd(tmp, () => writeGapsReport(PHASE, 'TK-2339', [], [], 'PASS'));
    const rel = path.relative(tmp, p).split(path.sep).join('/');
    const re = new RegExp('^' + GAPS_REPORT_GLOB
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '(?:[^/]*/)*') + '$');
    assert.ok(re.test(rel), `written path ${rel} does not match allowlist glob ${GAPS_REPORT_GLOB}`);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});
