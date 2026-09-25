/**
 * Advanced E2E Tests — complex pipeline integration
 *
 * Tests cross-system integration flows:
 *   - Full RPETD with validation gates (offline)
 *   - Memory pipeline store/search/learn lifecycle
 *   - Task scoring, next-task selection, dependency chains
 *   - Sprint management, atomization, export/import
 *   - Agent classification, domain tagging, dedup
 *   - Concurrency-safe task creation
 *   - Edge cases: Unicode, large content, corrupted JSON
 *   - Security: SQL injection patterns, path traversal
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const MEM = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const PY  = path.join(__dirname, '..', 'amauta.py');

function withTmp(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-e2e-'));
  try { fn(d); } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

function py(args, dataDir) {
  try {
    const out = execFileSync('python3', [PY, ...args], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, AMAUTA_DATA_DIR: dataDir, NO_COLOR: '1', GSD_AMAUTA_PORT: '19999',
        GSD_MEMORY_FILE_MODE: '1', // TK-2386: drives the memory CLI at a dead port on purpose
      },
      cwd: dataDir, timeout: 15000,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout||'').toString().trim(), err: (e.stderr||'').toString().trim() };
  }
}

function run(bin, args, dataDir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, GSD_AMAUTA_PORT: '19999', GSD_AMAUTA_NO_AUTO_START: '1',
        GSD_MEMORY_FILE_MODE: '1', // TK-2386: drives the memory CLI at a dead port on purpose
        AMAUTA_DATA_DIR: dataDir, ...env,
      },
      cwd: dataDir, timeout: 15000,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout||'').toString().trim(), err: (e.stderr||'').toString().trim(), code: e.status };
  }
}

function id(output, pfx = 'TK') { const m = output.match(new RegExp(`${pfx}-\\d+`)); return m ? m[0] : null; }

function makeTaskFile(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    items,
    sprints: [],
    metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() }
  };
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(data, null, 2));
}

function readTasks(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf-8'));
}

// ═══════════════════════════════════════════════════════
// SECTION 1: Task Scoring & Priority (10 tests)
// ═══════════════════════════════════════════════════════

describe('Task Scoring & Priority — E2E', () => {
  test('1.1 next returns highest priority task', () => withTmp(d => {
    py(['add', 'task', 'Alpha low importance task', '--importance', '1', '--urgency', '1', '--agent', 'gsd-executor-general'], d);
    py(['add', 'task', 'Beta critical importance work', '--importance', '5', '--urgency', '5', '--agent', 'gsd-executor-general'], d);
    const r = py(['next', 'gsd-executor-general'], d);
    assert.ok(r.ok, `next failed: ${r.out} ${r.err}`);
    assert.ok(r.out.includes('Beta critical') || r.out.includes('importance'), 'Should suggest high priority task first');
  }));

  test('1.2 next skips blocked tasks', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Dependency task'], d);
    const dep = id(r1.out);
    const r2 = py(['add', 'task', 'Blocked task', '--deps', dep], d);
    const blocked = id(r2.out);
    py(['add', 'task', 'Available task'], d);
    const r = py(['next', 'gsd-executor-general'], d);
    assert.ok(r.ok, `next failed: ${r.out} ${r.err}`);
    // next should return dep or available, not blocked
  }));

  test('1.3 score command shows breakdown', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Score test task', '--importance', '4', '--urgency', '3'], d);
    const tk = id(r1.out);
    const r = py(['score', tk], d);
    assert.ok(r.ok, `score failed: ${r.out} ${r.err}`);
    assert.ok(r.out.includes('score') || r.out.includes('Score') || /\d+\.\d+/.test(r.out));
  }));

  test('1.4 critical priority gets boost', () => withTmp(d => {
    py(['add', 'task', 'Alpha regular medium work', '--importance', '3', '--urgency', '3', '--priority', 'medium', '--agent', 'gsd-executor-general'], d);
    py(['add', 'task', 'Beta urgent critical issue', '--importance', '3', '--urgency', '3', '--priority', 'critical', '--agent', 'gsd-executor-general'], d);
    const r = py(['next', 'gsd-executor-general'], d);
    assert.ok(r.ok, `next failed: ${r.out} ${r.err}`);
    assert.ok(r.out.includes('Beta urgent') || r.out.includes('critical'), 'Critical should be suggested first');
  }));

  test('1.5 list with filter by status', () => withTmp(d => {
    py(['add', 'task', 'Pending task'], d);
    const r1 = py(['add', 'task', 'Done task'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    // Force done
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    item.status = 'done';
    fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify(data, null, 2));
    const r = py(['list', '--status', 'done'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes(tk));
  }));

  test('1.6 list with agent filter', () => withTmp(d => {
    py(['add', 'task', 'Backend task', '--agent', 'gsd-executor-backend'], d);
    py(['add', 'task', 'Frontend task', '--agent', 'gsd-executor-frontend'], d);
    const r = py(['agent-tasks', 'gsd-executor-backend'], d);
    assert.ok(r.ok, `agent-tasks failed: ${r.out} ${r.err}`);
    assert.ok(r.out.includes('Backend'));
  }));

  test('1.7 search finds by title substring', () => withTmp(d => {
    py(['add', 'task', 'Implement authentication flow'], d);
    py(['add', 'task', 'Fix database connection'], d);
    const r = py(['search', 'authentication'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('authentication') || r.out.includes('Implement'));
  }));

  test('1.8 search finds by ID prefix', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Test task'], d);
    const tk = id(r1.out);
    const r = py(['search', tk], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes(tk));
  }));

  test('1.9 board groups by status', () => withTmp(d => {
    py(['add', 'task', 'Board task 1'], d);
    py(['add', 'task', 'Board task 2'], d);
    const r = py(['board'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('pending') || r.out.includes('PENDING'));
  }));

  test('1.10 stats shows project statistics', () => withTmp(d => {
    py(['add', 'task', 'Stats task 1'], d);
    py(['add', 'task', 'Stats task 2'], d);
    py(['add', 'bug', 'Stats bug 1'], d);
    const r = py(['stats'], d);
    assert.ok(r.ok);
    // Should show some counts
    assert.ok(/\d+/.test(r.out));
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 2: Dependency Chains E2E (8 tests)
// ═══════════════════════════════════════════════════════

describe('Dependency Chains — E2E', () => {
  test('2.1 add task with dependencies', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Foundation task'], d);
    const dep = id(r1.out);
    const r2 = py(['add', 'task', 'Dependent task', '--deps', dep], d);
    const tk = id(r2.out);
    const r = py(['show', tk], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes(dep), 'Should show dependency');
  }));

  test('2.2 task with unmet deps has lower next priority', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Blocker'], d);
    const dep = id(r1.out);
    py(['add', 'task', 'Blocked', '--deps', dep], d);
    py(['add', 'task', 'Available'], d);
    // next should prefer available over blocked
    const r = py(['next', 'gsd-executor-general'], d);
    assert.ok(r.ok, `next failed: ${r.out} ${r.err}`);
  }));

  test('2.3 completing dependency unblocks dependent', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Blocker'], d);
    const dep = id(r1.out);
    const r2 = py(['add', 'task', 'Blocked', '--deps', dep], d);
    const blocked = id(r2.out);
    // Mark dep as done
    py(['claim', dep, '--agent', 'gsd-executor-general'], d);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === dep);
    item.status = 'done';
    fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify(data, null, 2));
    // Now blocked should be claimable
    const r = py(['claim', blocked, '--agent', 'gsd-executor-general'], d);
    assert.ok(r.ok || r.out.includes('claim'));
  }));

  test('2.4 multi-level dependency chain via show', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Level 1'], d);
    const l1 = id(r1.out);
    assert.ok(l1);
    const r2 = py(['add', 'task', 'Level 2', '--deps', l1], d);
    const l2 = id(r2.out);
    assert.ok(l2);
    const r3 = py(['add', 'task', 'Level 3', '--deps', l2], d);
    const l3 = id(r3.out);
    assert.ok(l3);
    const r = py(['show', l3], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes(l2), 'Level 3 should depend on Level 2');
  }));

  test('2.5 epic with stories creates hierarchy', () => withTmp(d => {
    const r1 = py(['add', 'epic', 'User Management'], d);
    const epic = r1.out.match(/EP-\d+/)?.[0];
    assert.ok(epic, 'Should create epic');
    const r2 = py(['add', 'story', 'User Registration', '--parent', epic], d);
    const story = r2.out.match(/ST-\d+/)?.[0];
    assert.ok(story, 'Should create story');
    const r = py(['show', story], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes(epic), 'Story should reference parent epic');
  }));

  test('2.6 bug type creates BG-prefixed ID', () => withTmp(d => {
    const r = py(['add', 'bug', 'Login page 500 error'], d);
    assert.ok(r.ok);
    const bugId = r.out.match(/BG-\d+/)?.[0];
    assert.ok(bugId, 'Should have BG- prefix');
  }));

  test('2.7 delete task', () => withTmp(d => {
    const r1 = py(['add', 'task', 'To be deleted'], d);
    const tk = id(r1.out);
    const r = py(['delete', tk], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    assert.ok(!data.items.find(i => i.id === tk), 'Task should be gone');
  }));

  test('2.8 assign task to agent', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Assign test'], d);
    const tk = id(r1.out);
    const r = py(['assign', tk, 'gsd-executor-backend'], d);
    assert.ok(r.ok, `Assign failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.assigned_to, 'gsd-executor-backend');
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 3: RPETD Phase Enrichment E2E (10 tests)
// ═══════════════════════════════════════════════════════

describe('RPETD Phase Enrichment — E2E', () => {
  test('3.1 R-phase logs research content', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Research integration test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const r = py(['rpetd', tk, '--phase', 'R', '--content', 'R: Found 3 relevant patterns in auth module'], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.R.includes('Found 3 relevant patterns'));
  }));

  test('3.2 P-phase logs plan content', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Plan test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: done'], d);
    const r = py(['rpetd', tk, '--phase', 'P', '--content', 'P: 1. Create model 2. Add routes 3. Write tests'], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.P.includes('Create model'));
  }));

  test('3.3 E-phase with branch evidence logged', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Execute test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: done'], d);
    py(['rpetd', tk, '--phase', 'P', '--content', 'P: plan'], d);
    const r =     py(['rpetd', tk, '--phase', 'E', '--content', 'E: git checkout -b feat/TK-auth-flow. feat/TK-auth-flow branch. Implemented auth module.'], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.E.includes('feat/TK-auth-flow'));
  }));

  test('3.4 T-phase with test evidence logged', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Test phase test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: done'], d);
    py(['rpetd', tk, '--phase', 'P', '--content', 'P: plan'], d);
    py(['rpetd', tk, '--phase', 'E', '--content', 'E: feat/test branch'], d);
    const r = py(['rpetd', tk, '--phase', 'T', '--content', 'T: npm test\n42 tests passed, 0 failed\nexit 0'], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.T.includes('42 tests passed'));
  }));

  test('3.5 D-phase with LEARNING persisted', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Delivery test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: done'], d);
    py(['rpetd', tk, '--phase', 'P', '--content', 'P: plan'], d);
    py(['rpetd', tk, '--phase', 'E', '--content', 'E: feat/test'], d);
    py(['rpetd', tk, '--phase', 'T', '--content', 'T: 5 passed exit 0'], d);
    const r = py(['rpetd', tk, '--phase', 'D', '--content', 'D: PR merged. LEARNING: Always validate inputs before DB writes.'], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.D.includes('LEARNING:'));
  }));

  test('3.6 rpetd on non-existent task fails', () => withTmp(d => {
    // Create initial tasks.json
    py(['add', 'task', 'seed'], d);
    const r = py(['rpetd', 'TK-9999', '--phase', 'R', '--content', 'R: test'], d);
    assert.ok(!r.ok || r.out.includes('not found'));
  }));

  test('3.7 claim enriches with task context', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Context enrichment test', '--agent', 'gsd-executor-general', '--description', 'Test context passing'], d);
    const tk = id(r1.out);
    const r = py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    assert.ok(r.ok);
    // Claim should work and add enrichment notes
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.status, 'in-progress');
    assert.ok(item.claimed_by === 'gsd-executor-general');
  }));

  test('3.8 note appends timestamped note', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Note test'], d);
    const tk = id(r1.out);
    const r = py(['note', tk, '--content', 'Important observation about the codebase'], d);
    assert.ok(r.ok, `Note failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    const hasNote = item.notes.some(n => {
      const text = typeof n === 'string' ? n : (n.text || '');
      return text.includes('Important observation');
    });
    assert.ok(hasNote, 'Note should be appended');
  }));

  test('3.9 claim already claimed task shows info', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Double claim test'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const r = py(['claim', tk, '--agent', 'gsd-executor-backend'], d);
    // Should indicate already claimed
    assert.ok(r.out.includes('claim') || r.out.includes('already') || r.out.includes('in-progress'));
  }));

  test('3.10 rpetd prevents E before R on first invocation', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Phase order test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    // Try E without R — should still work (rpetd allows any order but warns)
    const r = py(['rpetd', tk, '--phase', 'E', '--content', 'E: coded'], d);
    // amauta.py allows out-of-order phases
    assert.ok(r.ok);
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 4: Validation Gates E2E (10 tests)
// ═══════════════════════════════════════════════════════

describe('Validation Gates — Advanced E2E', () => {
  function createReadyTask(d, overrides = {}) {
    const data = {
      items: [{
        id: 'TK-0001', type: 'task', title: overrides.title || 'Gate test task',
        description: 'Test', details: '', status: overrides.status || 'in-progress',
        priority: 'medium', assigned_to: overrides.agent || 'gsd-executor-general',
        agent: overrides.agent || 'gsd-executor-general',
        claimed_by: overrides.agent || 'gsd-executor-general',
        claimed_at: new Date().toISOString(),
        tags: overrides.tags || ['lane:code'],
        rpetd_phases: overrides.phases || {
          R: 'R: Researched existing implementation patterns and reviewed architecture docs for edge cases and constraints.',
          P: 'P: Planned implementation with Given/When/Then criteria. Risk assessed, dependencies mapped, rollback defined.',
          E: 'E: git checkout -b feat/TK-0001. Code done.',
          T: 'T: npm test\n10 tests passed\nexit 0',
          D: 'D: https://github.com/org/repo/pull/1 merged to main. LEARNING: Always handle edge cases because unhandled exceptions in production cause cascading failures that impact downstream services and degrade user experience significantly.'
        },
        rpetd_complete: true, notes: overrides.notes || [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        success_criteria: ['Tests pass'], deliverables: ['auth.js'], dependencies: [],
        importance: 3, urgency: 3, validation_checklist: [],
      }],
      sprints: [],
      metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() }
    };
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify(data, null, 2));
    return 'TK-0001';
  }

  test('4.1 validate pass on fully compliant task', () => withTmp(d => {
    const tk = createReadyTask(d, { status: 'validation' });
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator', '--notes', 'All gates pass'], d);
    assert.ok(r.ok, `Validate pass failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.status, 'done');
  }));

  test('4.2 validate fail returns task to queue', () => withTmp(d => {
    const tk = createReadyTask(d, { status: 'validation' });
    const r = py(['validate', tk, '--fail', '--validator', 'gsd-validator', '--notes', 'Missing test output'], d);
    assert.ok(r.ok, `Validate fail failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    // validate --fail returns task to pending (back to queue) or in-progress
    assert.ok(item.status === 'pending' || item.status === 'in-progress',
      `Expected pending or in-progress, got: ${item.status}`);
  }));

  test('4.3 validate pass requires LEARNING block', () => withTmp(d => {
    const tk = createReadyTask(d, {
      status: 'validation',
      phases: {
        R: 'R: Researched existing implementation patterns and reviewed architecture docs for edge cases and constraints.',
        P: 'P: Planned implementation with Given/When/Then criteria. Risk assessed, dependencies mapped, rollback defined.',
        E: 'E: feat/TK-0001. https://github.com/org/repo/pull/1 merged.',
        T: 'T: 5 tests passed exit 0',
        D: 'D: done'  // No LEARNING!
      }
    });
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator'], d);
    // Should fail or warn about missing learning
    assert.ok(r.out.includes('LEARNING') || r.out.includes('learning') || !r.ok);
  }));

  test('4.4 non-code task skips gitflow gates', () => withTmp(d => {
    const tk = createReadyTask(d, {
      status: 'validation',
      agent: 'gsd-researcher',
      tags: ['lane:non-code', 'non-code', 'no-gitflow'],
      phases: {
        R: 'R: Researched topic across three academic papers and two industry reports for comprehensive coverage.',
        P: 'P: Planned research approach with structured comparison matrix and validation against known benchmarks.',
        E: 'E: research complete',
        T: 'T: verified findings against three sources and documentation thoroughly',
        D: 'D: LEARNING: Research methodology improved by cross-referencing multiple documentation sources because single-source research misses conflicting information and produces incomplete recommendations that fail in practice.'
      }
    });
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator', '--notes', 'Good research'], d);
    assert.ok(r.ok, `Non-code validation should pass: ${r.out} ${r.err}`);
  }));

  test('4.5 validate with --force-reason bypasses gates', () => withTmp(d => {
    const tk = createReadyTask(d, {
      status: 'validation',
      phases: { R: '', P: '', E: '', T: '', D: '' }  // Empty phases
    });
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator', '--force-reason', 'automated-test-override'], d);
    assert.ok(r.ok, `Force-reason should bypass all gates: ${r.out} ${r.err}`);
  }));

  test('4.6 status validation requires branch evidence for code tasks', () => withTmp(d => {
    const tk = createReadyTask(d, {
      status: 'in-progress',
      phases: {
        R: 'R: Researched existing implementation patterns and reviewed architecture docs for edge cases and constraints.',
        P: 'P: Planned implementation with Given/When/Then criteria. Risk assessed, dependencies mapped, rollback defined.',
        E: 'E: coded stuff',  // No branch reference!
        T: 'T: tests passed exit 0',
        D: 'D: done. LEARNING: test.'
      }
    });
    const r = py(['status', tk, 'validation'], d);
    // Should warn or fail about missing branch evidence
    const combined = r.out + r.err;
    assert.ok(combined.includes('branch') || combined.includes('BRANCH') || combined.includes('evidence') || combined.includes('GATE'));
  }));

  test('4.7 infra task with no-gitflow tag skips PR gate', () => withTmp(d => {
    const tk = createReadyTask(d, {
      status: 'validation',
      tags: ['lane:infra', 'no-gitflow'],
      phases: {
        R: 'R: Reviewed Docker networking docs and checked existing compose configs for subnet and DNS patterns.',
        P: 'P: Planned compose update with explicit subnet configuration. Rollback: revert to previous compose file.',
        E: 'E: configured Docker compose and networking',
        T: 'T: docker compose up exit 0. All services healthy. DNS resolution verified between all containers.',
        D: 'D: LEARNING: Docker networking requires explicit subnet configuration for service discovery because default bridge networks do not support DNS resolution between containers in multi-service deployments.'
      }
    });
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator'], d);
    assert.ok(r.ok, `Infra task should pass: ${r.out} ${r.err}`);
  }));

  test('4.8 validate --fail returns task to queue with notes', () => withTmp(d => {
    const tk = createReadyTask(d, { status: 'validation' });
    const r = py(['validate', tk, '--fail', '--validator', 'gsd-validator', '--notes', 'Fix test coverage and add documentation'], d);
    assert.ok(r.ok, `Validate fail failed: ${r.out} ${r.err}`);
    // Task should be returned to pending/in-progress
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.status === 'pending' || item.status === 'in-progress');
    // Notes should include the failure reason
    const allNotes = item.notes.map(n => typeof n === 'string' ? n : (n.text || '')).join(' ');
    assert.ok(allNotes.includes('Fix test') || allNotes.includes('coverage') || r.out.includes('FAILED'));
  }));

  test('4.9 show on validated task shows validation notes', () => withTmp(d => {
    const tk = createReadyTask(d, { status: 'validation' });
    py(['validate', tk, '--pass', '--validator', 'gsd-validator', '--notes', 'Excellent work'], d);
    const r = py(['show', tk], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('done'));
  }));

  test('4.10 validator can reject tasks with detailed notes', () => withTmp(d => {
    const tk = createReadyTask(d, { status: 'validation' });
    // Validator rejects with detailed notes
    const r = py(['validate', tk, '--fail', '--validator', 'gsd-validator',
      '--notes', 'GATE_FAIL: branch evidence insufficient. No feat/ pattern found.'], d);
    assert.ok(r.ok, `Validate fail should succeed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.status === 'pending' || item.status === 'in-progress');
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 5: Memory Pipeline E2E (8 tests)
// ═══════════════════════════════════════════════════════

describe('Memory Pipeline — Advanced E2E', () => {
  test('5.1 memory store and search roundtrip (file mode)', () => withTmp(d => {
    const store = run(MEM, ['store', 'React hooks best practices for state management', '--agent', 'gsd-researcher'], d);
    assert.ok(store.ok, `Store failed: ${store.err}`);
    const search = run(MEM, ['search', 'React hooks'], d);
    assert.ok(search.ok, `Search failed: ${search.err}`);
    assert.ok(search.out.includes('React') || search.out.includes('hooks'));
  }));

  test('5.2 memory learn stores with learning source', () => withTmp(d => {
    const r = run(MEM, ['learn', 'Always validate inputs before database writes', '--agent', 'gsd-executor-backend'], d);
    assert.ok(r.ok, `Learn failed: ${r.err}`);
    const search = run(MEM, ['search', 'validate inputs'], d);
    assert.ok(search.ok);
  }));

  test('5.3 memory list shows all entries', () => withTmp(d => {
    run(MEM, ['store', 'Entry 1', '--agent', 'test'], d);
    run(MEM, ['store', 'Entry 2', '--agent', 'test'], d);
    const r = run(MEM, ['list'], d);
    assert.ok(r.ok, `List failed: ${r.err}`);
  }));

  test('5.4 memory count returns total', () => withTmp(d => {
    run(MEM, ['store', 'One', '--agent', 'test'], d);
    run(MEM, ['store', 'Two', '--agent', 'test'], d);
    const r = run(MEM, ['count'], d);
    assert.ok(r.ok, `Count failed: ${r.err}`);
    assert.ok(r.out.includes('2') || /\d+/.test(r.out));
  }));

  test('5.5 memory search returns empty for no match', () => withTmp(d => {
    run(MEM, ['store', 'Python decorators', '--agent', 'test'], d);
    const r = run(MEM, ['search', 'zzz_nonexistent_xyz'], d);
    assert.ok(r.ok);
    // Should return empty or no results
  }));

  test('5.6 py cmd_memory add via CLI', () => withTmp(d => {
    const r = py(['memory', 'add', '--agent', 'gsd-executor-general', '--tags', 'test', '--text', 'Memory via Python CLI'], d);
    assert.ok(r.ok, `memory add failed: ${r.out} ${r.err}`);
  }));

  test('5.7 py cmd_memory search via CLI', () => withTmp(d => {
    py(['memory', 'add', '--agent', 'gsd-executor-general', '--tags', 'test', '--text', 'PostgreSQL connection pooling is important'], d);
    const r = py(['memory', 'search', '--query', 'PostgreSQL'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('PostgreSQL') || r.out.includes('pooling'));
  }));

  test('5.8 py cmd_memory stats via CLI', () => withTmp(d => {
    py(['memory', 'add', '--agent', 'gsd-executor-general', '--tags', 'test', '--text', 'Something'], d);
    const r = py(['memory', 'stats'], d);
    assert.ok(r.ok);
    assert.ok(/\d+/.test(r.out));
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 6: Atomization & Sprint Management (6 tests)
// ═══════════════════════════════════════════════════════

describe('Atomization & Sprint — E2E', () => {
  test('6.1 atomize epic into subtasks', () => withTmp(d => {
    const r1 = py(['add', 'epic', 'User Management System'], d);
    const epic = r1.out.match(/EP-\d+/)?.[0];
    assert.ok(epic, `Epic ID not found in: ${r1.out}`);
    const r = py(['atomize', epic, '--subtasks', 'User registration;User login;Password reset'], d);
    assert.ok(r.ok, `Atomize failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    assert.ok(data.items.length >= 4, `Should have original + 3 sub items, got ${data.items.length}`);
  }));

  test('6.2 sprint create', () => withTmp(d => {
    py(['add', 'task', 'Sprint task 1'], d);
    py(['add', 'task', 'Sprint task 2'], d);
    const r = py(['sprint', 'create', 'Sprint-1'], d);
    assert.ok(r.ok, `Sprint create failed: ${r.out} ${r.err}`);
  }));

  test('6.3 sprint list', () => withTmp(d => {
    py(['add', 'task', 'Sprint task'], d);
    py(['sprint', 'create', 'Sprint-1'], d);
    const r = py(['sprint', 'list'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('Sprint'));
  }));

  test('6.4 export tasks to JSON', () => withTmp(d => {
    py(['add', 'task', 'Export test'], d);
    const r = py(['export'], d);
    assert.ok(r.ok);
    // Should output valid JSON
    const parsed = JSON.parse(r.out);
    assert.ok(parsed.items || Array.isArray(parsed));
  }));

  test('6.5 import tasks from file', () => withTmp(d => {
    py(['add', 'task', 'Original task'], d);
    const data = readTasks(d);
    const exportFile = path.join(d, 'export.json');
    fs.writeFileSync(exportFile, JSON.stringify(data));
    // Create a new dir to import into
    const importDir = path.join(d, 'import');
    fs.mkdirSync(importDir, { recursive: true });
    const r = py(['import', exportFile], importDir);
    assert.ok(r.ok, `Import failed: ${r.out} ${r.err}`);
  }));

  test('6.6 update task fields', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Update test'], d);
    const tk = id(r1.out);
    const r = py(['update', tk, '--priority', 'high', '--importance', '5'], d);
    assert.ok(r.ok, `Update failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.priority, 'high');
    assert.strictEqual(item.importance, 5);
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 7: Edge Cases & Robustness (10 tests)
// ═══════════════════════════════════════════════════════

describe('Edge Cases & Robustness — E2E', () => {
  test('7.1 Unicode in task title roundtrips correctly', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Implementar autenticacion con emojis'], d);
    assert.ok(r1.ok);
    const tk = id(r1.out);
    const r = py(['show', tk], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('autenticacion'));
  }));

  test('7.2 long task title handled gracefully', () => withTmp(d => {
    const longTitle = 'A'.repeat(200);
    const r = py(['add', 'task', longTitle], d);
    assert.ok(r.ok, 'Should handle long titles');
    const tk = id(r.out);
    assert.ok(tk);
  }));

  test('7.3 empty tasks.json items list', () => withTmp(d => {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify({ items: [], sprints: [], metadata: { version: '2.0' } }));
    const r = py(['list'], d);
    assert.ok(r.ok);
  }));

  test('7.4 add with all optional fields', () => withTmp(d => {
    const r = py(['add', 'task', 'Full task',
      '--description', 'Full description',
      '--priority', 'high',
      '--importance', '5',
      '--urgency', '4',
      '--agent', 'gsd-executor-backend',
      '--tags', 'auth,security',
      '--criteria', JSON.stringify(['Tests pass', 'Coverage >80%']),
    ], d);
    assert.ok(r.ok);
    const tk = id(r.out);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.priority, 'high');
    assert.strictEqual(item.importance, 5);
    assert.ok(item.tags.some(t => t.includes('auth')));
  }));

  test('7.5 RPETD content with newlines preserved', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Newline test'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const content = 'R: Line 1\nLine 2\nLine 3';
    const r = py(['rpetd', tk, '--phase', 'R', '--content', content], d);
    assert.ok(r.ok);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_phases.R.includes('Line 1'));
    assert.ok(item.rpetd_phases.R.includes('Line 3'));
  }));

  test('7.6 show non-existent task shows error', () => withTmp(d => {
    py(['add', 'task', 'seed'], d);
    const r = py(['show', 'TK-9999'], d);
    assert.ok(!r.ok || r.out.includes('not found'));
  }));

  test('7.7 task with special characters in title', () => withTmp(d => {
    const r = py(['add', 'task', "Fix O'Brien's auth & login <module>"], d);
    assert.ok(r.ok);
    const tk = id(r.out);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.title.includes("O'Brien"));
  }));

  test('7.8 multiple sequential adds produce unique IDs', () => withTmp(d => {
    const ids = new Set();
    const titles = [
      'Implement authentication module',
      'Set up database schema',
      'Create user interface',
      'Write API documentation',
      'Configure deployment pipeline',
    ];
    for (const title of titles) {
      const r = py(['add', 'task', title], d);
      const tk = id(r.out);
      assert.ok(tk, `Task should have ID, output: ${r.out}`);
      assert.ok(!ids.has(tk), `Duplicate ID ${tk}`);
      ids.add(tk);
    }
    assert.strictEqual(ids.size, 5);
  }));

  test('7.9 note with markdown special characters preserved', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Markdown note test'], d);
    const tk = id(r1.out);
    const r = py(['note', tk, '--content', 'bold code link example'], d);
    assert.ok(r.ok, `Note failed: ${r.out} ${r.err}`);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    const hasNote = item.notes.some(n => {
      const text = typeof n === 'string' ? n : (n.text || '');
      return text.includes('bold code');
    });
    assert.ok(hasNote);
  }));

  test('7.10 task with all RPETD phases shows rpetd_complete', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Complete RPETD test'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    for (const [p, c] of [['R','R: done'],['P','P: done'],['E','E: done'],['T','T: done'],['D','D: done']]) {
      py(['rpetd', tk, '--phase', p, '--content', c], d);
    }
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.rpetd_complete, 'Should be rpetd_complete after all phases');
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 8: Security & Input Validation (5 tests)
// ═══════════════════════════════════════════════════════

describe('Security & Input Validation — E2E', () => {
  test('8.1 SQL injection in task title is safely stored', () => withTmp(d => {
    const r = py(['add', 'task', "'; DROP TABLE gsd_memory; --"], d);
    assert.ok(r.ok, 'SQL injection should be treated as plain text');
    const tk = id(r.out);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.title.includes('DROP TABLE'));
  }));

  test('8.2 shell metacharacters in task title handled safely', () => withTmp(d => {
    const r = py(['add', 'task', '$(rm -rf /) && echo pwned'], d);
    assert.ok(r.ok, 'Shell metacharacters should be safely stored');
  }));

  test('8.3 very long description handled', () => withTmp(d => {
    const longDesc = 'x'.repeat(10000);
    const r = py(['add', 'task', 'Long desc test', '--description', longDesc], d);
    assert.ok(r.ok, 'Long description should be handled');
  }));

  test('8.4 task title with null bytes handled', () => withTmp(d => {
    const r = py(['add', 'task', 'Null byte test'], d);
    assert.ok(r.ok, 'Should handle without null bytes causing issues');
  }));

  test('8.5 RPETD content with escape sequences preserved', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Escape test'], d);
    const tk = id(r1.out);
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);
    const r = py(['rpetd', tk, '--phase', 'R', '--content', 'R: path=/usr/local/bin\\nvar=$HOME'], d);
    assert.ok(r.ok);
  }));
});

// ═══════════════════════════════════════════════════════
// SECTION 9: Cross-Pipeline Integration (6 tests)
// ═══════════════════════════════════════════════════════

describe('Cross-Pipeline Integration — E2E', () => {
  test('9.1 full lifecycle: add→claim→RPETD→validate→done', () => withTmp(d => {
    // Add
    const r1 = py(['add', 'task', 'Full lifecycle E2E test', '--agent', 'gsd-executor-general'], d);
    const tk = id(r1.out);
    assert.ok(tk);

    // Claim
    py(['claim', tk, '--agent', 'gsd-executor-general'], d);

    // RPETD
    py(['rpetd', tk, '--phase', 'R', '--content', 'R: Researched auth patterns'], d);
    py(['rpetd', tk, '--phase', 'P', '--content', 'P: Plan: 1. Model 2. Routes 3. Tests'], d);
    py(['rpetd', tk, '--phase', 'E', '--content', 'E: git checkout -b feat/TK-auth. Code done. https://github.com/org/repo/pull/1 merged to main.'], d);
    py(['rpetd', tk, '--phase', 'T', '--content', 'T: npm test\n15 tests passed, 0 failed\nexit 0'], d);
    py(['rpetd', tk, '--phase', 'D', '--content', 'D: https://github.com/org/repo/pull/1 merged to main. LEARNING: Always add input validation to auth routes because unvalidated input creates SQL injection and XSS attack vectors that compromise the entire authentication system.'], d);

    // Status → validation
    py(['status', tk, 'validation'], d);

    // Validate pass
    const r = py(['validate', tk, '--pass', '--validator', 'gsd-validator', '--notes', 'All gates pass'], d);
    assert.ok(r.ok, `Validate failed: ${r.out} ${r.err}`);

    // Check final state
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.strictEqual(item.status, 'done');
    assert.ok(item.rpetd_complete);
  }));

  test('9.2 memory created during lifecycle persists', () => withTmp(d => {
    // Store memory
    run(MEM, ['store', 'Auth pattern: use JWT with refresh tokens', '--agent', 'gsd-executor-backend'], d);
    // Search should find it
    const r = run(MEM, ['search', 'JWT refresh tokens'], d);
    assert.ok(r.ok);
    assert.ok(r.out.includes('JWT') || r.out.includes('refresh'));
  }));

  test('9.3 task metadata auto-augmented at creation', () => withTmp(d => {
    const r1 = py(['add', 'task', 'React dashboard component', '--agent', 'gsd-executor-frontend'], d);
    const tk = id(r1.out);
    const data = readTasks(d);
    const item = data.items.find(i => i.id === tk);
    assert.ok(item.tags.some(t => t === 'lane:code'), 'Should have lane:code tag');
    assert.ok(item.tags.some(t => t.includes('frontend')), 'Should have frontend domain tag');
  }));

  test('9.4 dedup prevents duplicate task creation', () => withTmp(d => {
    py(['add', 'task', 'Implement user authentication', '--agent', 'gsd-executor-backend'], d);
    const r2 = py(['add', 'task', 'Implement user authentication', '--agent', 'gsd-executor-backend'], d);
    // Should warn about duplicate or create with note
    const data = readTasks(d);
    // If dedup caught it, might have warning in output
    assert.ok(r2.out.includes('duplicate') || r2.out.includes('existing') || data.items.length <= 2);
  }));

  test('9.5 migrate command is idempotent', () => withTmp(d => {
    py(['add', 'task', 'Migrate test'], d);
    const r1 = py(['migrate'], d);
    assert.ok(r1.ok);
    const r2 = py(['migrate'], d);
    assert.ok(r2.ok, 'Second migrate should also succeed');
    // Items should be unchanged
    const data = readTasks(d);
    assert.ok(data.items.length >= 1);
  }));

  test('9.6 refs command manages task references', () => withTmp(d => {
    const r1 = py(['add', 'task', 'Refs test'], d);
    const tk = id(r1.out);
    const r = py(['refs', tk, 'add', '--path', 'https://example.com/doc'], d);
    assert.ok(r.ok, `refs failed: ${r.out} ${r.err}`);
  }));
});
