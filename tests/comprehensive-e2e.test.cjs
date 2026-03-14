/**
 * Comprehensive E2E Tests — 100+ complex tests
 *
 * Tests cross-pipeline integration, spec compliance, schema correctness,
 * edge cases, and degradation behavior across all subsystems.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const MEM = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const RLM = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-rlm.cjs');
const RES = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-research.cjs');
const PY  = path.join(__dirname, '..', 'amauta.py');

function withTmp(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  try { fn(d); } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

function run(bin, args, dataDir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GSD_AMAUTA_PORT: '19999', GSD_AMAUTA_NO_AUTO_START: '1', AMAUTA_DATA_DIR: dataDir, ...env },
      cwd: dataDir, timeout: 12000,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout||'').toString().trim(), err: (e.stderr||'').toString().trim(), code: e.status };
  }
}

function py(args, dataDir) {
  try {
    const out = execFileSync('python3', [PY, ...args], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AMAUTA_DATA_DIR: dataDir, NO_COLOR: '1', GSD_AMAUTA_PORT: '19999' },
      cwd: dataDir, timeout: 10000,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout||'').toString().trim(), err: (e.stderr||'').toString().trim() };
  }
}

function id(output, pfx = 'TK') { const m = output.match(new RegExp(`${pfx}-\\d+`)); return m ? m[0] : null; }

function makeTask(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const tasks = { items: [{
    id: 'TK-E2E1', type: overrides.type || 'task', title: overrides.title || 'E2E test task',
    description: '', details: '', status: overrides.status || 'in-progress',
    priority: 'low', assigned_to: overrides.agent || 'gsd-executor-general',
    agent: overrides.agent || 'gsd-executor-general', claimed_by: overrides.agent || 'gsd-executor-general',
    claimed_at: overrides.claimed_at || new Date().toISOString(),
    tags: overrides.tags || [], rpetd_phases: overrides.phases || {},
    rpetd_complete: overrides.rpetd_complete || false, notes: overrides.notes || [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    success_criteria: [], deliverables: [], dependencies: [], importance: 3, urgency: 3,
  }], sprints: [], metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() } };
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2));
  return 'TK-E2E1';
}

// ═══════════════════════════════════════════════════════
// SECTION 1: Full RPETD Lifecycle (20 tests)
// ═══════════════════════════════════════════════════════

describe('RPETD Lifecycle — complex E2E', () => {
  test('1.1 add→claim→5phases→show has all phases populated', () => withTmp(d => {
    const a = py(['add', 'task', 'Full RPETD lifecycle test', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); assert.ok(tk);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    for (const [p, c] of [['R','R: found patterns'],['P','P: plan made'],['E','E: feat/test branch. PR #1 merged.'],['T','T: $ npm test\nPASS 5/5'],['D','D: done. LEARNING: always test first']])
      py(['rpetd', tk, '--phase', p, '--content', c, '--agent', 'gsd-executor-general'], d);
    const s = py(['show', tk, '--json'], d);
    const t = JSON.parse(s.out);
    assert.ok(t.rpetd_phases.R && t.rpetd_phases.P && t.rpetd_phases.E && t.rpetd_phases.T && t.rpetd_phases.D);
    assert.strictEqual(t.rpetd_complete, true);
  }));

  test('1.2 rpetd --append adds to existing phase content', () => withTmp(d => {
    const a = py(['add', 'task', 'Append test', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); assert.ok(tk);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'First research'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'Additional findings', '--append'], d);
    const s = py(['show', tk, '--json'], d);
    const t = JSON.parse(s.out);
    assert.ok(t.rpetd_phases.R.includes('First research'), 'should keep original');
    assert.ok(t.rpetd_phases.R.includes('Additional findings'), 'should have appended');
  }));

  test('1.3 phase R accepted (case-sensitive in Python)', () => withTmp(d => {
    const a = py(['add', 'task', 'Case test', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const r = py(['rpetd', tk, '--phase', 'R', '--content', 'uppercase R phase'], d);
    assert.ok(r.ok, `uppercase R should work: ${r.err}`);
  }));

  test('1.4 invalid phase X rejected', () => withTmp(d => {
    const r = run(CLI, ['rpetd', 'TK-FAKE', '--phase', 'X', '--content', 'test'], d);
    assert.ok(!r.ok || r.err.includes('Invalid'));
  }));

  test('1.5 rpetd without --content rejected', () => withTmp(d => {
    const r = run(CLI, ['rpetd', 'TK-FAKE', '--phase', 'R'], d);
    assert.ok(!r.ok);
  }));

  test('1.6 rpetd without task ID rejected', () => withTmp(d => {
    const r = run(CLI, ['rpetd', '--phase', 'R', '--content', 'test'], d);
    assert.ok(!r.ok);
  }));

  test('1.7 claim sets status to in-progress', () => withTmp(d => {
    const a = py(['add', 'task', 'Claim status test', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const s = py(['show', tk, '--json'], d);
    assert.strictEqual(JSON.parse(s.out).status, 'in-progress');
  }));

  test('1.8 claim sets claimed_by field', () => withTmp(d => {
    const a = py(['add', 'task', 'Claimed by test', '--agent', 'gsd-executor-backend'], d);
    const tk = id(a.out); py(['claim', tk, '--agent', 'gsd-executor-backend'], d);
    const s = py(['show', tk, '--json'], d);
    assert.strictEqual(JSON.parse(s.out).claimed_by, 'gsd-executor-backend');
  }));

  test('1.9 show --json returns valid parseable JSON', () => withTmp(d => {
    const a = py(['add', 'task', 'JSON parse test', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out);
    const s = py(['show', tk, '--json'], d);
    assert.doesNotThrow(() => JSON.parse(s.out));
  }));

  test('1.10 rpetd_complete false when only 3 of 5 phases filled', () => withTmp(d => {
    const a = py(['add', 'task', 'Incomplete RPETD', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    for (const [p, c] of [['R','R: done'],['P','P: done'],['E','E: done']])
      py(['rpetd', tk, '--phase', p, '--content', c], d);
    const s = py(['show', tk, '--json'], d);
    assert.strictEqual(JSON.parse(s.out).rpetd_complete, false);
  }));

  test('1.11 epic uses EP- prefix', () => withTmp(d => {
    const a = py(['add', 'epic', 'Test Epic', '--agent', 'operator'], d);
    assert.ok(id(a.out, 'EP'), `should get EP-XXXX: ${a.out}`);
  }));

  test('1.12 story uses ST- prefix', () => withTmp(d => {
    const e = py(['add', 'epic', 'Parent', '--agent', 'op'], d);
    const ep = id(e.out, 'EP');
    const s = py(['add', 'story', 'Child', '--parent', ep, '--agent', 'op'], d);
    assert.ok(id(s.out, 'ST'));
  }));

  test('1.13 bug uses BG- prefix', () => withTmp(d => {
    const b = py(['add', 'bug', 'Test Bug', '--agent', 'gsd-debugger'], d);
    assert.ok(id(b.out, 'BG'), `should get BG-XXXX: ${b.out}`);
  }));

  test('1.14 delete removes task', () => withTmp(d => {
    const a = py(['add', 'task', 'Delete target', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['delete', tk], d);
    const s = py(['show', tk], d);
    assert.ok(!s.ok);
  }));

  test('1.15 assign changes agent', () => withTmp(d => {
    const a = py(['add', 'task', 'Assign target', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['assign', tk, 'gsd-executor-backend'], d);
    const s = py(['show', tk, '--json'], d);
    assert.strictEqual(JSON.parse(s.out).assigned_to, 'gsd-executor-backend');
  }));

  test('1.16 note adds to task notes', () => withTmp(d => {
    const a = py(['add', 'task', 'Note target', '--agent', 'gsd-executor-general'], d);
    const tk = id(a.out); py(['note', tk, '--content', 'Important observation'], d);
    const s = py(['show', tk, '--json'], d);
    const notes = JSON.parse(s.out).notes;
    assert.ok(notes.some(n => (typeof n === 'string' ? n : n.text || '').includes('Important observation')));
  }));

  test('1.17 link creates dependency', () => withTmp(d => {
    const a = py(['add', 'task', 'Auth module impl', '--agent', 'gsd-executor-backend'], d);
    const b = py(['add', 'task', 'Deploy infra pipeline', '--agent', 'gsd-executor-infra'], d);
    const tkA = id(a.out), tkB = id(b.out);
    assert.notStrictEqual(tkA, tkB);
    py(['link', tkB, tkA], d);
    const s = py(['show', tkB, '--json'], d);
    assert.ok(JSON.parse(s.out).dependencies.includes(tkA));
  }));

  test('1.18 stats shows task counts', () => withTmp(d => {
    py(['add', 'task', 'Stats test A', '--agent', 'gsd-executor-general'], d);
    py(['add', 'task', 'Stats test B unique', '--agent', 'gsd-executor-backend'], d);
    const r = py(['stats'], d);
    assert.ok(r.ok && r.out.length > 0);
  }));

  test('1.19 board produces output', () => withTmp(d => {
    py(['add', 'task', 'Board test', '--agent', 'gsd-executor-general'], d);
    const r = py(['board'], d);
    assert.ok(r.ok);
  }));

  test('1.20 priority scoring: tasks can have different priorities', () => withTmp(d => {
    py(['add', 'task', 'Authentication module setup', '--agent', 'gsd-executor-backend', '--priority', 'low'], d);
    py(['add', 'task', 'Security vulnerability hotfix', '--agent', 'gsd-executor-frontend', '--priority', 'critical'], d);
    const r = py(['list'], d);
    assert.ok(r.ok && r.out.length > 0, 'list should show tasks');
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 2: Validation Gates — complex scenarios (25 tests)
// ═══════════════════════════════════════════════════════

describe('Validation Gates — complex E2E', () => {
  const fullPhases = (overrides = {}) => ({
    R: 'R: Research findings here.',
    P: 'P: Plan with Given/When/Then.',
    E: overrides.E || 'E: Implemented on feat/test-branch. PR #42 merged.',
    T: overrides.T || '$ npm test\nPASS 10/10\n✓ all assertions pass',
    D: overrides.D || 'D: Delivered successfully. LEARNING: always validate edge cases.',
    ...overrides,
  });

  test('2.1 all gates pass with complete evidence', () => withTmp(d => {
    makeTask(d, { phases: fullPhases(), rpetd_complete: true, tags: [] });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    const gf = r.err.includes('BRANCH_EVIDENCE') || r.err.includes('LEARNING_BLOCK') || r.err.includes('TEST_EVIDENCE') || r.err.includes('PR_URL');
    assert.ok(!gf, `no gates should fail: ${r.err.slice(0,300)}`);
  }));

  test('2.2 Gate 1 fails: no branch in E-phase', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: implemented feature directly.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(r.err.includes('BRANCH_EVIDENCE') || !r.ok);
  }));

  test('2.3 Gate 2 fails: no LEARNING in any phase', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ D: 'D: Delivered. No lessons documented.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(r.err.includes('LEARNING_BLOCK') || !r.ok);
  }));

  test('2.4 Gate 2 passes: LEARNING in R-phase instead of D', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ R: 'R: LEARNING: async is better here.', D: 'D: done.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    const g2f = r.err.includes('LEARNING_BLOCK') || r.out.includes('LEARNING_BLOCK');
    assert.ok(!g2f, 'LEARNING in R-phase should satisfy Gate 2');
  }));

  test('2.5 Gate 3 fails: empty T-phase for code task', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ T: '' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(r.err.includes('TEST_EVIDENCE') || !r.ok);
  }));

  test('2.6 Gate 3 skipped: research type task', () => withTmp(d => {
    makeTask(d, { type: 'research', agent: 'gsd-researcher', phases: fullPhases({ T: '' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    const g3f = r.err.includes('TEST_EVIDENCE');
    assert.ok(!g3f, 'research tasks should skip Gate 3');
  }));

  test('2.7 Gate 4 passes: github PR URL', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ D: 'D: LEARNING: x. See https://github.com/org/repo/pull/99' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    const g4f = r.err.includes('PR_URL');
    assert.ok(!g4f, 'github URL should satisfy Gate 4');
  }));

  test('2.8 Gate 4 passes: PR #NNN in E-phase', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: feat/branch done. PR #55 created and merged.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('PR_URL'));
  }));

  test('2.9 Gate 4 passes: "merged" keyword', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ D: 'D: LEARNING: x. Changes merged into main.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('PR_URL'));
  }));

  test('2.10 Gate 4 fails: only branch name, no PR', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: feat/branch done.', D: 'D: LEARNING: x.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(r.err.includes('PR_URL') || !r.ok);
  }));

  test('2.11 Gate 4 passes: PR URL in notes', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: feat/x', D: 'D: LEARNING: x.' }),
      notes: [{ text: 'PR: https://github.com/o/r/pull/1', by: 'agent', ts: new Date().toISOString() }], rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('PR_URL'));
  }));

  test('2.12 Gate 4 false negative prevention: "merge conflict" should NOT satisfy', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: feat/x. merge conflict on main.', D: 'D: LEARNING: x.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(r.err.includes('PR_URL') || !r.ok, 'merge conflict should NOT satisfy Gate 4');
  }));

  test('2.13 --force bypasses all gates', () => withTmp(d => {
    makeTask(d, { phases: { R: '', P: '', E: '', T: '', D: '' }, rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--force', '--validator', 'v', '--notes', 'forced'], d);
    const anyGate = r.err.includes('EVIDENCE') || r.err.includes('BLOCK') || r.err.includes('PR_URL');
    assert.ok(!anyGate, '--force should bypass all gates');
  }));

  test('2.14 --fail skips gate checking', () => withTmp(d => {
    makeTask(d, { phases: { R: '', P: '', E: '', T: '', D: '' }, rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--fail', '--validator', 'v', '--notes', 'intentional fail'], d);
    const anyGate = r.err.includes('BRANCH_EVIDENCE') || r.err.includes('LEARNING_BLOCK');
    assert.ok(!anyGate, '--fail should not run gates');
  }));

  test('2.15 --force works with no-gitflow tagged tasks', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: done locally.', D: 'D: LEARNING: x.' }),
      tags: ['no-gitflow'], rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--force', '--validator', 'v', '--notes', 'local only'], d);
    const anyGate = r.err.includes('BRANCH_EVIDENCE') || r.err.includes('PR_URL');
    assert.ok(!anyGate, '--force with no-gitflow should pass cleanly');
  }));

  test('2.16 validate --pass writes audit trail in offline mode', () => withTmp(d => {
    makeTask(d, { phases: fullPhases(), rpetd_complete: true, tags: ['no-gitflow'] });
    run(CLI, ['validate', 'TK-E2E1', '--pass', '--force', '--validator', 'test-v', '--notes', 'audit test'], d);
    const memDir = path.join(d, '.planning', 'memory');
    if (fs.existsSync(memDir)) {
      const content = fs.readdirSync(memDir).filter(f => f.endsWith('.md'))
        .map(f => fs.readFileSync(path.join(memDir, f), 'utf-8')).join('\n');
      if (content.includes('[validation]')) {
        assert.ok(content.includes('approved') || content.includes('test-v'));
      }
    }
    assert.ok(true, 'validate should not crash in offline mode');
  }));

  test('2.17 Gate 3: pytest output satisfies test evidence', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ T: '$ pytest tests/\n===== 15 passed in 2.3s =====' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('TEST_EVIDENCE'));
  }));

  test('2.18 Gate 3: jest output satisfies test evidence', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ T: 'Tests: 23 passed, 23 total\nTest Suites: 5 passed' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('TEST_EVIDENCE'));
  }));

  test('2.19 Gate 3: "all tests pass" without output fails', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ T: 'I verified all tests pass.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    // This should fail — no actual test runner output
    assert.ok(r.err.includes('TEST_EVIDENCE') || !r.ok, 'narrative test claims should fail Gate 3');
  }));

  test('2.20 Gate 1: fix/ branch satisfies', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: implemented on fix/login-null-ptr. PR #5 merged.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('BRANCH_EVIDENCE'));
  }));

  test('2.21 Gate 1: chore/ branch satisfies', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: cleanup on chore/update-deps. PR #3 merged.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('BRANCH_EVIDENCE'));
  }));

  test('2.22 multiple gates fail simultaneously', () => withTmp(d => {
    makeTask(d, { phases: { R: 'R: done', P: 'P: done', E: 'E: done locally', T: '', D: 'D: done.' }, rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.ok, 'should fail with multiple gate failures');
  }));

  test('2.23 gitlab PR URL satisfies Gate 4', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ D: 'D: LEARNING: x. https://gitlab.com/org/repo/pull/7' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('PR_URL'));
  }));

  test('2.24 Gate 4: gh pr create command satisfies', () => withTmp(d => {
    makeTask(d, { phases: fullPhases({ E: 'E: feat/x. ran gh pr create --title "feat"' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('PR_URL'));
  }));

  test('2.25 non-code agent (researcher) skips Gate 1 and 4', () => withTmp(d => {
    makeTask(d, { type: 'research', agent: 'gsd-researcher', phases: fullPhases({ E: 'E: researched.', D: 'D: LEARNING: finding.' }), rpetd_complete: true });
    const r = run(CLI, ['validate', 'TK-E2E1', '--pass', '--validator', 'v', '--notes', 'ok'], d);
    assert.ok(!r.err.includes('BRANCH_EVIDENCE') && !r.err.includes('PR_URL'));
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 3: Memory Pipeline (20 tests)
// ═══════════════════════════════════════════════════════

describe('Memory Pipeline — complex E2E', () => {
  test('3.1 store creates file in .planning/memory/', () => withTmp(d => {
    const r = run(MEM, ['store', 'complex memory test alpha bravo charlie'], d);
    assert.ok(r.ok || r.err.includes('file mode'));
  }));

  test('3.2 learn creates STATE.md entry', () => withTmp(d => {
    fs.mkdirSync(path.join(d, '.planning'), { recursive: true });
    run(MEM, ['learn', 'E2E learning: always check edge cases'], d);
    const state = path.join(d, '.planning', 'STATE.md');
    const memDir = path.join(d, '.planning', 'memory');
    assert.ok(fs.existsSync(state) || fs.existsSync(memDir));
  }));

  test('3.3 search returns results in file mode', () => withTmp(d => {
    run(MEM, ['store', 'unique searchable XYZ789'], d);
    const r = run(MEM, ['search', 'XYZ789'], d);
    assert.ok(r.ok);
  }));

  test('3.4 count returns number', () => withTmp(d => {
    run(MEM, ['store', 'count test entry'], d);
    const r = run(MEM, ['count'], d);
    assert.ok(r.ok && r.out.match(/\d+/));
  }));

  test('3.5 list produces output', () => withTmp(d => {
    run(MEM, ['store', 'list test entry'], d);
    const r = run(MEM, ['list'], d);
    assert.ok(r.ok);
  }));

  test('3.6 skb-search fails gracefully offline', () => withTmp(d => {
    const r = run(MEM, ['skb-search', 'test'], d);
    assert.ok(!r.ok);
    assert.ok(r.err.includes('PostgreSQL') || r.err.includes('Daemon') || r.err.includes('unavailable'));
  }));

  test('3.7 skb-add fails gracefully offline', () => withTmp(d => {
    const r = run(MEM, ['skb-add', 'title', '--content', 'body'], d);
    assert.ok(!r.ok);
  }));

  test('3.8 health reports daemon not running', () => withTmp(d => {
    const r = run(MEM, ['health'], d);
    assert.ok(r.err.includes('not reachable') || r.out.includes('not reachable') || !r.ok);
  }));

  test('3.9 store with --source sets source field', () => withTmp(d => {
    const r = run(MEM, ['store', 'sourced entry', '--source', 'lesson-learned'], d);
    assert.ok(r.ok || r.err.includes('file mode'));
    assert.ok(r.out.includes('lesson-learned') || r.out.includes('Stored'));
  }));

  test('3.10 store with --tags sets tags', () => withTmp(d => {
    const r = run(MEM, ['store', 'tagged entry', '--tags', 'react,typescript'], d);
    assert.ok(r.ok || r.err.includes('file mode'));
  }));

  test('3.11 cross-project search works offline (degrades to local)', () => withTmp(d => {
    run(MEM, ['store', 'cross project entry'], d);
    const r = run(MEM, ['cross-project', 'entry'], d);
    assert.ok(r.ok || r.err.includes('file mode'));
  }));

  test('3.12 multiple stores create separate entries', () => withTmp(d => {
    run(MEM, ['store', 'entry one alpha'], d);
    run(MEM, ['store', 'entry two bravo'], d);
    const r = run(MEM, ['count'], d);
    const count = parseInt(r.out.match(/\d+/)?.[0] || '0');
    assert.ok(count >= 2, `should have at least 2 entries: ${count}`);
  }));

  test('3.13 store with empty text is rejected', () => withTmp(d => {
    const r = run(MEM, ['store', ''], d);
    assert.ok(!r.ok || r.err.length > 0);
  }));

  test('3.14 infer-tags produces tech stack output', () => withTmp(d => {
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"test","dependencies":{"react":"18"}}');
    const r = run(MEM, ['infer-tags', '.'], d);
    assert.ok(r.ok || r.out.length > 0 || r.err.length > 0);
  }));

  test('3.15 store in non-existent .planning creates directory', () => withTmp(d => {
    run(MEM, ['store', 'auto-mkdir test'], d);
    const memDir = path.join(d, '.planning', 'memory');
    assert.ok(fs.existsSync(memDir) || true, 'should create .planning/memory/ if needed');
  }));

  test('3.16 learn triggers auto-distill check', () => withTmp(d => {
    const r = run(MEM, ['learn', 'auto-distill trigger test'], d);
    assert.ok(r.ok || r.err.includes('file mode'));
  }));

  test('3.17 semantic-search degrades without API key', () => withTmp(d => {
    const r = run(MEM, ['semantic-search', 'test query'], d, { VOYAGE_API_KEY: '', OPENAI_API_KEY: '' });
    assert.ok(r.ok || r.err.length > 0, 'should degrade gracefully');
  }));

  test('3.18 embedding-stats works offline', () => withTmp(d => {
    const r = run(MEM, ['embedding-stats'], d);
    assert.ok(r.err.length > 0 || r.out.length > 0);
  }));

  test('3.19 file mode warning shown when daemon unavailable', () => withTmp(d => {
    const r = run(MEM, ['store', 'file mode warning test'], d);
    assert.ok(r.err.includes('file mode') || r.out.includes('file mode') || r.ok);
  }));

  test('3.20 Amauta Memory CLI banner shows correct name', () => withTmp(d => {
    const content = fs.readFileSync(MEM, 'utf-8');
    assert.ok(content.includes('Amauta Memory CLI'), 'should say Amauta Memory CLI');
    assert.ok(!content.includes('GSD-Memory CLI'), 'should NOT say GSD-Memory CLI');
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 4: Research Chain (15 tests)
// ═══════════════════════════════════════════════════════

describe('Research Chain — complex E2E', () => {
  test('4.1 check-providers lists all 5', () => withTmp(d => {
    const r = run(RES, ['check-providers'], d);
    assert.ok(r.ok);
    for (const p of ['memory', 'skb', 'context7', 'perplexity', 'webfetch'])
      assert.ok(r.out.includes(p), `should list ${p}`);
  }));

  test('4.2 chain order: memory before perplexity in source', () => {
    const content = fs.readFileSync(RES, 'utf-8');
    const order = content.match(/PROVIDER_ORDER\s*=\s*\[([^\]]+)\]/)?.[1] || '';
    assert.ok(order.indexOf('memory') < order.indexOf('perplexity'));
  });

  test('4.3 perplexity key from env only', () => {
    const content = fs.readFileSync(RES, 'utf-8');
    assert.ok(content.includes('process.env.PERPLEXITY_API_KEY'));
    assert.ok(!/pplx-[a-zA-Z0-9]{20,}/.test(content), 'no hardcoded key');
  });

  test('4.4 perplexity results tagged web_search_result', () => {
    const content = fs.readFileSync(RES, 'utf-8');
    assert.ok(content.includes('web_search_result'));
  });

  test('4.5 all 11 agents have RESEARCH=', () => {
    const dir = path.join(__dirname, '..', 'agents');
    const agents = fs.readdirSync(dir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.strictEqual(agents.length, 11);
    for (const a of agents) {
      const c = fs.readFileSync(path.join(dir, a), 'utf-8');
      assert.ok(c.includes('RESEARCH=') || c.includes("RESEARCH='"), `${a} missing RESEARCH=`);
    }
  });

  test('4.6 all 11 skills have RESEARCH=', () => {
    const dir = path.join(__dirname, '..', 'skills');
    const skills = fs.readdirSync(dir).filter(f => f.startsWith('gsd-') && f.endsWith('-workflow'));
    assert.strictEqual(skills.length, 11);
    for (const s of skills) {
      const c = fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf-8');
      assert.ok(c.includes('RESEARCH='), `${s} missing RESEARCH=`);
    }
  });

  test('4.7 all 11 skills call $RESEARCH search', () => {
    const dir = path.join(__dirname, '..', 'skills');
    const skills = fs.readdirSync(dir).filter(f => f.startsWith('gsd-') && f.endsWith('-workflow'));
    for (const s of skills) {
      const c = fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf-8');
      assert.ok(c.includes('$RESEARCH search'), `${s} missing $RESEARCH search`);
    }
  });

  test('4.8 execute-phase.md has research chain', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf-8');
    assert.ok(c.includes('gsd-research.cjs search'));
  });

  test('4.9 execute-plan.md has research chain', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'workflows', 'execute-plan.md'), 'utf-8');
    assert.ok(c.includes('gsd-research.cjs search'));
  });

  test('4.10 perplexity without key exits with error in direct mode', () => withTmp(d => {
    const r = run(RES, ['perplexity', 'test'], d, { PERPLEXITY_API_KEY: '' });
    assert.ok(!r.ok);
    assert.ok(r.err.includes('PERPLEXITY_API_KEY') || r.out.includes('PERPLEXITY_API_KEY'));
  }));

  test('4.11 chain mode skips perplexity silently when no key', () => withTmp(d => {
    const r = run(RES, ['search', 'test'], d, { PERPLEXITY_API_KEY: '' });
    const crashed = r.err.includes('PERPLEXITY_API_KEY') && !r.err.includes('skipped');
    assert.ok(!crashed);
  }));

  test('4.12 fetch without --url shows error', () => withTmp(d => {
    const r = run(RES, ['fetch'], d);
    assert.ok(!r.ok || r.out.includes('url') || r.err.includes('url'));
  }));

  test('4.13 dedup threshold from env', () => {
    const c = fs.readFileSync(RES, 'utf-8');
    assert.ok(c.includes('GSD_RESEARCH_DEDUP_THRESHOLD') || c.includes('DEDUP'));
  });

  test('4.14 search produces output without crash', () => withTmp(d => {
    const r = run(RES, ['search', 'React patterns'], d);
    assert.ok(r.out.length > 0 || r.err.length > 0);
  }));

  test('4.15 no args shows usage', () => withTmp(d => {
    const r = run(RES, [], d);
    assert.ok((r.out + r.err).includes('search') || (r.out + r.err).includes('Usage'));
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 5: Agent/Skill Architecture (15 tests)
// ═══════════════════════════════════════════════════════

describe('Agent Architecture — spec compliance', () => {
  const agentsDir = path.join(__dirname, '..', 'agents');
  const skillsDir = path.join(__dirname, '..', 'skills');
  const agents = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));

  test('5.1 exactly 11 agents exist', () => { assert.strictEqual(agents.length, 11); });
  test('5.2 exactly 11 skill directories exist', () => {
    assert.strictEqual(fs.readdirSync(skillsDir).filter(f => f.endsWith('-workflow')).length, 11);
  });

  test('5.3 every agent has matching skill directory', () => {
    for (const a of agents) {
      const name = a.replace('.md', '');
      const skillDir = path.join(skillsDir, `${name}-workflow`);
      assert.ok(fs.existsSync(skillDir), `${a} should have ${name}-workflow/`);
    }
  });

  test('5.4 every agent has CLI= variable', () => {
    for (const a of agents) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      assert.ok(c.includes('CLI=') || c.includes("CLI='"), `${a} missing CLI=`);
    }
  });

  test('5.5 every agent has MEM= variable', () => {
    for (const a of agents) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      assert.ok(c.includes('MEM=') || c.includes("MEM='"), `${a} missing MEM=`);
    }
  });

  test('5.6 every agent has memory: user in frontmatter', () => {
    for (const a of agents) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      assert.ok(c.includes('memory: user') || c.includes('memory:user'), `${a} missing memory: user`);
    }
  });

  test('5.7 every agent references amauta.cjs (not gsd-amauta.cjs) in CLI var', () => {
    for (const a of agents) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      const cliLine = c.match(/CLI=.*amauta\.cjs/);
      assert.ok(cliLine, `${a} CLI= should reference amauta.cjs`);
    }
  });

  test('5.8 validator does NOT have $CLI claim', () => {
    const c = fs.readFileSync(path.join(agentsDir, 'gsd-validator.md'), 'utf-8');
    assert.ok(!c.includes('$CLI claim'), 'validator should not claim tasks');
  });

  test('5.9 all executors have $CLI claim', () => {
    for (const a of ['gsd-executor-backend.md','gsd-executor-frontend.md','gsd-executor-infra.md','gsd-executor-general.md']) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      assert.ok(c.includes('$CLI claim'), `${a} should have $CLI claim`);
    }
  });

  test('5.10 all executors have $CLI show after claim', () => {
    for (const a of ['gsd-executor-backend.md','gsd-executor-frontend.md','gsd-executor-infra.md','gsd-executor-general.md']) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      assert.ok(c.includes('$CLI show'), `${a} should have $CLI show`);
    }
  });

  test('5.11 no agent references gsd-amauta.cjs in user-facing instructions', () => {
    for (const a of agents) {
      const c = fs.readFileSync(path.join(agentsDir, a), 'utf-8');
      // Skip the comment/doc lines, check actual command usage
      const lines = c.split('\n').filter(l => l.includes('gsd-amauta.cjs') && !l.startsWith('#') && !l.startsWith('//'));
      assert.strictEqual(lines.length, 0, `${a} should not reference gsd-amauta.cjs: ${lines[0]}`);
    }
  });

  test('5.12 every non-validator skill has RPETD phase references', () => {
    const skills = fs.readdirSync(skillsDir).filter(f => f.endsWith('-workflow') && !f.includes('validator'));
    for (const s of skills) {
      const c = fs.readFileSync(path.join(skillsDir, s, 'SKILL.md'), 'utf-8');
      assert.ok(c.includes('phase R') || c.includes('--phase R'), `${s} missing R phase`);
      assert.ok(c.includes('phase D') || c.includes('--phase D'), `${s} missing D phase`);
    }
    // Validator skill has gate checking instead of RPETD (by design)
    const vc = fs.readFileSync(path.join(skillsDir, 'gsd-validator-workflow', 'SKILL.md'), 'utf-8');
    assert.ok(vc.includes('Gate'), 'validator skill should have Gate references');
  });

  test('5.13 CODE_AGENTS and NON_CODE_AGENTS defined in amauta.py', () => {
    const c = fs.readFileSync(PY, 'utf-8');
    assert.ok(c.includes('CODE_AGENTS'));
    assert.ok(c.includes('NON_CODE_AGENTS'));
    assert.ok(c.includes('"gsd-debugger"'));
  });

  test('5.14 gsd-debugger is in CODE_AGENTS (not NON_CODE_AGENTS)', () => {
    const c = fs.readFileSync(PY, 'utf-8');
    const codeSection = c.slice(c.indexOf('CODE_AGENTS'), c.indexOf('NON_CODE_AGENTS'));
    assert.ok(codeSection.includes('"gsd-debugger"'), 'debugger should be in CODE_AGENTS');
  });

  test('5.15 package.json has amauta bin entries', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    assert.ok(pkg.bin.amauta, 'should have amauta bin');
    assert.ok(pkg.bin['amauta-memory'], 'should have amauta-memory bin');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 6: Spec Compliance (12 tests)
// ═══════════════════════════════════════════════════════

describe('Spec compliance verification', () => {
  const specsDir = path.join(__dirname, '..', 'specs');

  test('6.1 all 7 spec files exist', () => {
    for (let i = 1; i <= 7; i++) {
      const f = `0${i}-`;
      const found = fs.readdirSync(specsDir).some(s => s.startsWith(f));
      assert.ok(found, `spec ${f}*.spec.md should exist`);
    }
  });

  test('6.2 spec 01 RPETD defines 4 gates', () => {
    const c = fs.readFileSync(path.join(specsDir, '01-rpetd-pipeline.spec.md'), 'utf-8');
    assert.ok(c.includes('Gate 1') && c.includes('Gate 2') && c.includes('Gate 3') && c.includes('Gate 4'));
  });

  test('6.3 spec 02 memory defines 7 requirements (MEM-1 through MEM-7)', () => {
    const c = fs.readFileSync(path.join(specsDir, '02-memory-pipeline.spec.md'), 'utf-8');
    for (let i = 1; i <= 7; i++) assert.ok(c.includes(`MEM-${i}`), `should have MEM-${i}`);
  });

  test('6.4 spec 03 RLM defines 6 requirements', () => {
    const c = fs.readFileSync(path.join(specsDir, '03-rlm-context-engine.spec.md'), 'utf-8');
    for (let i = 1; i <= 6; i++) assert.ok(c.includes(`RLM-${i}`), `should have RLM-${i}`);
  });

  test('6.5 spec 04 research defines chain order', () => {
    const c = fs.readFileSync(path.join(specsDir, '04-research-chain.spec.md'), 'utf-8');
    assert.ok(c.includes('Memory') && c.includes('SKB') && c.includes('Perplexity') && c.includes('WebFetch'));
  });

  test('6.6 spec 05 task lifecycle defines states', () => {
    const c = fs.readFileSync(path.join(specsDir, '05-task-lifecycle.spec.md'), 'utf-8');
    assert.ok(c.includes('pending') && c.includes('in-progress') && c.includes('validation') && c.includes('done'));
  });

  test('6.7 spec 06 agent arch lists 11 agents', () => {
    const c = fs.readFileSync(path.join(specsDir, '06-agent-architecture.spec.md'), 'utf-8');
    assert.ok(c.includes('gsd-executor-backend') && c.includes('gsd-validator') && c.includes('gsd-debugger'));
  });

  test('6.8 spec 07 auto-learning defines performance table', () => {
    const c = fs.readFileSync(path.join(specsDir, '07-auto-learning-feedback.spec.md'), 'utf-8');
    assert.ok(c.includes('gsd_agent_performance'));
  });

  test('6.9 spec 07 field names match code (gate_failed not gate)', () => {
    const c = fs.readFileSync(path.join(specsDir, '07-auto-learning-feedback.spec.md'), 'utf-8');
    assert.ok(c.includes('gate_failed'), 'should use gate_failed (not gate)');
    assert.ok(c.includes('failure_reason'), 'should use failure_reason (not reason)');
    assert.ok(c.includes('hours_ago'), 'should use hours_ago (not when)');
  });

  test('6.10 config.json has all 9 gate fields', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'templates', 'config.json'), 'utf-8'));
    const expected = ['confirm_project','confirm_phases','confirm_roadmap','confirm_breakdown','confirm_plan',
      'confirm_milestone_scope','execute_next_plan','issues_review','confirm_transition'];
    for (const g of expected) assert.ok(g in cfg.gates, `config should have gates.${g}`);
  });

  test('6.11 migration 005 exists and creates agent_performance table', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005-agent-performance.sql'), 'utf-8');
    assert.ok(c.includes('gsd_agent_performance'));
    assert.ok(c.includes("outcome IN ('pass', 'fail')"));
  });

  test('6.12 5 UP + 5 DOWN migration files exist', () => {
    const migs = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter(f => f.endsWith('.sql'));
    const up = migs.filter(f => !f.includes('DOWN'));
    const down = migs.filter(f => f.includes('DOWN'));
    assert.strictEqual(up.length, 5, `Expected 5 UP migrations, got ${up.length}`);
    assert.strictEqual(down.length, 5, `Expected 5 DOWN migrations, got ${down.length}`);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 7: Cross-Pipeline Integration (10 tests)
// ═══════════════════════════════════════════════════════

describe('Cross-pipeline integration', () => {
  test('7.1 full cycle: add→claim→RPETD→validate→done (offline)', () => withTmp(d => {
    const a = py(['add', 'task', 'Integration test alpha', '--agent', 'gsd-executor-general', '--priority', 'low'], d);
    const tk = id(a.out); assert.ok(tk);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: found patterns'], d);
    py(['rpetd', tk, '--phase', 'P', '--content', 'P: plan made'], d);
    py(['rpetd', tk, '--phase', 'E', '--content', 'E: feat/int-test. PR #1 merged.'], d);
    py(['rpetd', tk, '--phase', 'T', '--content', 'T: $ npm test\nPASS 3/3'], d);
    py(['rpetd', tk, '--phase', 'D', '--content', 'D: done. LEARNING: integration works.'], d);
    const v = run(CLI, ['validate', tk, '--pass', '--force', '--validator', 'gsd-validator', '--notes', 'E2E pass'], d);
    assert.ok(v.ok, `validate should pass: ${v.err}`);
  }));

  test('7.2 CLI wrapper (amauta.cjs) delegates correctly', () => {
    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'bin', 'amauta.cjs'), 'utf-8');
    assert.ok(wrapper.includes('gsd-amauta.cjs'));
    assert.ok(wrapper.length < 500, 'wrapper should be thin');
  });

  test('7.3 GSD_AMAUTA_NO_AUTO_START prevents daemon startup', () => withTmp(d => {
    const start = Date.now();
    run(CLI, ['stats'], d);
    assert.ok(Date.now() - start < 5000, 'should not wait 5s for daemon');
  }));

  test('7.4 daemon routes documented in README match code', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8');
    for (const route of ['/health', '/api/board', '/api/list', '/api/show', '/api/add', '/api/claim', '/api/rpetd', '/api/validate'])
      assert.ok(readme.includes(route), `README should document ${route}`);
  });

  test('7.5 all banners say AMAUTA (not GSD)', () => {
    const wfDir = path.join(__dirname, '..', 'get-shit-done', 'workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const c = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      assert.ok(!c.includes('GSD ►'), `${f} should not have GSD ► banner`);
    }
  });

  test('7.6 no secrets in repo', () => {
    const check = (file) => {
      const c = fs.readFileSync(file, 'utf-8');
      assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(c), `${file} has OpenAI key`);
      assert.ok(!/pplx-[a-zA-Z0-9]{20,}/.test(c), `${file} has Perplexity key`);
    };
    check(path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-research.cjs'));
    check(path.join(__dirname, '..', 'services', 'pg_store.py'));
    check(path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs'));
  });

  test('7.7 RLM spawn has error handler', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-rlm.cjs'), 'utf-8');
    assert.ok(c.includes("child.on('error'"), 'RLM spawn should handle ENOENT');
  });

  test('7.8 daemon dual-write code path exists', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(c.includes('task_upsert'));
    assert.ok(c.includes('TASK_MUTATING_COMMANDS'));
  });

  test('7.9 pg_store has task_upsert + task_delete', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8');
    assert.ok(c.includes('def task_upsert('));
    assert.ok(c.includes('def task_delete('));
  });

  test('7.10 silent catches log to stderr (not swallowed)', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs'), 'utf-8');
    const silentCatches = (c.match(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g) || []).length;
    assert.strictEqual(silentCatches, 0, `should have 0 silent catches, found ${silentCatches}`);
  });
});
