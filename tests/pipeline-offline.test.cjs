/**
 * Offline Pipeline Tests
 *
 * Tests the full RPETD pipeline, memory pipeline, and amauta.py task lifecycle
 * in offline mode (no daemon, no PG). Uses direct Python invocation + CLI wrapper.
 *
 * No daemon required — all tests use GSD_AMAUTA_NO_AUTO_START=1.
 *
 * Coverage:
 *   - RPETD full cycle: add → claim → R/P/E/T/D → validate (offline)
 *   - amauta.py direct: add, show, list, claim, rpetd, delete, assign, link, status
 *   - Memory pipeline: store → search → learn → list → count (file mode)
 *   - Agent classification: code vs non-code lane inference
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AMAUTA_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const MEMORY_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const AMAUTA_PY  = path.join(__dirname, '..', 'amauta.py');

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function withTmp(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  try { fn(tmpDir); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
}

/** Run gsd-amauta.cjs in offline mode */
function cli(args, dataDir, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [AMAUTA_CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GSD_AMAUTA_PORT: '19999',
        GSD_AMAUTA_NO_AUTO_START: '1',
        AMAUTA_DATA_DIR: dataDir,
        ...(opts.env || {}),
      },
      cwd: opts.cwd || dataDir,
      timeout: opts.timeout || 12000,
    });
    return { success: true, output: out.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

/** Run gsd-memory.cjs in offline mode */
function mem(args, dataDir, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [MEMORY_CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GSD_AMAUTA_PORT: '19999',
        GSD_AMAUTA_NO_AUTO_START: '1',
        AMAUTA_DATA_DIR: dataDir,
        ...(opts.env || {}),
      },
      cwd: opts.cwd || dataDir,
      timeout: opts.timeout || 12000,
    });
    return { success: true, output: out.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

/** Run amauta.py directly */
function py(args, dataDir, opts = {}) {
  try {
    const out = execFileSync('python3', [AMAUTA_PY, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AMAUTA_DATA_DIR: dataDir,
        NO_COLOR: '1',
        ...(opts.env || {}),
      },
      cwd: opts.cwd || dataDir,
      timeout: opts.timeout || 10000,
    });
    return { success: true, output: out.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

function extractId(output, prefix = 'TK') {
  const m = output.match(new RegExp(`${prefix}-\\d+`));
  return m ? m[0] : null;
}

// ═══════════════════════════════════════════════════════
// amauta.py direct unit tests
// ═══════════════════════════════════════════════════════

describe('amauta.py direct invocation', () => {

  test('add task creates a new task with TK- ID', () => withTmp(dataDir => {
    const r = py(['add', 'task', 'My first offline task', '--agent', 'gsd-executor-general', '--priority', 'high'], dataDir);
    assert.ok(r.success, `add task failed: ${r.error || r.output}`);
    const id = extractId(r.output, 'TK');
    assert.ok(id, `should get TK-XXXX id: ${r.output}`);
  }));

  test('add epic creates a EP- ID', () => withTmp(dataDir => {
    const r = py(['add', 'epic', 'My Epic', '--agent', 'operator'], dataDir);
    assert.ok(r.success, `add epic failed: ${r.error}`);
    assert.ok(extractId(r.output, 'EP'), `should get EP-XXXX: ${r.output}`);
  }));

  test('add story creates a ST- ID', () => withTmp(dataDir => {
    const epic = py(['add', 'epic', 'Parent Epic', '--agent', 'operator'], dataDir);
    const epicId = extractId(epic.output, 'EP');
    assert.ok(epicId, 'epic created');

    const r = py(['add', 'story', 'Child Story', '--parent', epicId, '--agent', 'operator'], dataDir);
    assert.ok(r.success, `add story failed: ${r.error}`);
    assert.ok(extractId(r.output, 'ST'), `should get ST-XXXX: ${r.output}`);
  }));

  test('show displays task details', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Show test task', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = py(['show', id], dataDir);
    assert.ok(r.success, `show failed: ${r.error}`);
    assert.ok(r.output.includes('Show test task'), `should show title: ${r.output.slice(0, 200)}`);
  }));

  test('show --json returns parseable JSON', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'JSON test task', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = py(['show', id, '--json'], dataDir);
    assert.ok(r.success, `show --json failed: ${r.error}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.output); }, `should be valid JSON: ${r.output.slice(0, 200)}`);
    assert.strictEqual(parsed.id, id);
    assert.strictEqual(parsed.title, 'JSON test task');
  }));

  test('list shows all tasks', () => withTmp(dataDir => {
    py(['add', 'task', 'Task A', '--agent', 'gsd-executor-general'], dataDir);
    py(['add', 'task', 'Task B', '--agent', 'gsd-executor-general'], dataDir);

    const r = py(['list'], dataDir);
    assert.ok(r.success, `list failed: ${r.error}`);
    assert.ok(r.output.includes('Task A') || r.output.includes('Task B') || r.output.includes('TK-'),
      `should show tasks: ${r.output.slice(0, 300)}`);
  }));

  test('claim moves task to in-progress', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Claim test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = py(['claim', id, '--agent', 'gsd-executor-general'], dataDir);
    assert.ok(r.success, `claim failed: ${r.error}`);

    const show = py(['show', id, '--json'], dataDir);
    const task = JSON.parse(show.output);
    assert.strictEqual(task.status, 'in-progress', `task should be in-progress: ${task.status}`);
    assert.strictEqual(task.claimed_by, 'gsd-executor-general');
  }));

  test('rpetd logs all 5 phases', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'RPETD test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    py(['claim', id, '--agent', 'gsd-executor-general'], dataDir);

    const phases = [
      ['R', 'R: Research findings here'],
      ['P', 'P: Plan details here'],
      ['E', 'E: Execution on feat/test-branch. PR #1 merged.'],
      ['T', 'T: $ npm test\nPASS 3/3'],
      ['D', 'D: Done. LEARNING: test insight here'],
    ];

    for (const [phase, content] of phases) {
      const r = py(['rpetd', id, '--phase', phase, '--content', content, '--agent', 'gsd-executor-general'], dataDir);
      assert.ok(r.success, `rpetd ${phase} failed: ${r.error || r.output}`);
    }

    const show = py(['show', id, '--json'], dataDir);
    const task = JSON.parse(show.output);
    assert.ok(task.rpetd_phases, 'task should have rpetd_phases');
    assert.ok(task.rpetd_phases.R, 'R-phase should be set');
    assert.ok(task.rpetd_phases.D, 'D-phase should be set');
    assert.ok(task.rpetd_complete === true, `rpetd_complete should be true: ${task.rpetd_complete}`);
  }));

  test('assign changes assigned_to field', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Assign test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = py(['assign', id, 'gsd-executor-backend'], dataDir);
    assert.ok(r.success, `assign failed: ${r.error || r.output}`);

    const show = py(['show', id, '--json'], dataDir);
    const task = JSON.parse(show.output);
    assert.strictEqual(task.assigned_to, 'gsd-executor-backend', `should be reassigned: ${task.assigned_to}`);
  }));

  test('delete removes the task', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Delete test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const del = py(['delete', id], dataDir);
    assert.ok(del.success, `delete failed: ${del.error || del.output}`);

    const show = py(['show', id], dataDir);
    assert.ok(!show.success, `show should fail after delete: ${show.output}`);
  }));

  test('link creates dependency between tasks', () => withTmp(dataDir => {
    // Use distinct titles and different agents to avoid dedup detection
    const a = py(['add', 'task', 'Implement authentication module', '--agent', 'gsd-executor-backend'], dataDir);
    const b = py(['add', 'task', 'Build deployment pipeline', '--agent', 'gsd-executor-infra'], dataDir);
    const idA = extractId(a.output, 'TK');
    const idB = extractId(b.output, 'TK');
    assert.ok(idA, `should get task A id: ${a.output}`);
    assert.ok(idB, `should get task B id: ${b.output}`);
    assert.notStrictEqual(idA, idB, 'A and B should be different tasks');

    const r = py(['link', idB, idA], dataDir);
    assert.ok(r.success, `link failed: ${r.error || r.output}`);

    const show = py(['show', idB, '--json'], dataDir);
    assert.ok(show.success, `show failed: ${show.error}`);
    const task = JSON.parse(show.output);
    assert.ok(
      (task.dependencies || []).includes(idA),
      `task B should depend on task A: ${JSON.stringify(task.dependencies)}`
    );
  }));

  test('status change moves task between valid states', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Status test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    py(['claim', id, '--agent', 'gsd-executor-general'], dataDir);

    // Move to deferred (a non-gated transition — no RPETD required)
    const r = py(['status', id, 'deferred', '--agent', 'gsd-executor-general', '--note', 'test: non-gated transition'], dataDir);
    assert.ok(r.success, `status to deferred should succeed: ${r.error || r.output}`);

    // Verify the status changed
    const show = py(['show', id, '--json'], dataDir);
    if (show.success) {
      const task = JSON.parse(show.output);
      assert.strictEqual(task.status, 'deferred', `status should be deferred: ${task.status}`);
    }
  }));

  test('stats shows task counts', () => withTmp(dataDir => {
    py(['add', 'task', 'Task 1', '--agent', 'gsd-executor-general'], dataDir);
    py(['add', 'task', 'Task 2', '--agent', 'gsd-executor-general'], dataDir);

    const r = py(['stats'], dataDir);
    assert.ok(r.success, `stats failed: ${r.error}`);
    assert.ok(r.output.includes('pending') || r.output.includes('Total') || r.output.match(/\d+/),
      `stats should show counts: ${r.output.slice(0, 200)}`);
  }));

  test('board shows kanban view', () => withTmp(dataDir => {
    py(['add', 'task', 'Board test task', '--agent', 'gsd-executor-general'], dataDir);

    const r = py(['board'], dataDir);
    assert.ok(r.success, `board failed: ${r.error}`);
    assert.ok(r.output.length > 0, 'board should produce output');
  }));
});

// ═══════════════════════════════════════════════════════
// Full offline RPETD cycle via CLI wrapper
// ═══════════════════════════════════════════════════════

describe('Full RPETD pipeline (offline CLI)', () => {

  test('complete cycle: add → claim → RPETD → validate --force', () => withTmp(dataDir => {
    // Step 1: Add task
    const add = cli(['add', 'task', 'Offline RPETD Test', '--agent', 'gsd-executor-general', '--priority', 'low'], dataDir);
    assert.ok(add.success, `add failed: ${add.error || add.output}`);
    const taskId = extractId(add.output, 'TK');
    assert.ok(taskId, `should get task ID: ${add.output}`);

    // Step 2: Claim
    const claim = cli(['claim', taskId, '--agent', 'gsd-executor-general'], dataDir);
    assert.ok(claim.success, `claim failed: ${claim.error || claim.output}`);

    // Step 3: Log all 5 RPETD phases
    const phases = [
      ['R', 'R: Investigated the problem space. Found relevant patterns.'],
      ['P', 'P: Planned implementation on feat/offline-test branch.'],
      ['E', 'E: Implemented the feature on feat/offline-test. PR #7 merged.'],
      ['T', 'T: $ npm test\nPASS 10/10 tests\n✓ all assertions pass'],
      ['D', 'D: Delivered successfully. LEARNING: offline mode requires careful state management.'],
    ];
    for (const [phase, content] of phases) {
      const r = cli(['rpetd', taskId, '--phase', phase, '--content', content, '--agent', 'gsd-executor-general'], dataDir);
      assert.ok(r.success, `rpetd ${phase} failed: ${r.error || r.output}`);
    }

    // Step 4: Validate with --force-reason (bypasses gates)
    const validate = cli(['validate', taskId, '--pass', '--force-reason', 'automated-test-override', '--validator', 'gsd-validator', '--notes', 'E2E offline test pass'], dataDir);
    assert.ok(validate.success, `validate failed: ${validate.error || validate.output}`);

    // Step 5: Verify task is done
    const show = cli(['show', taskId, '--json'], dataDir);
    assert.ok(show.success, `show after validate failed: ${show.error}`);
    let task;
    try { task = JSON.parse(show.output); } catch { task = null; }
    if (task) {
      assert.strictEqual(task.status, 'done', `expected done, got ${task.status}`);
    }
  }));

  test('validate --pass without --force triggers gate checks', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'Gate check test', '--agent', 'gsd-executor-general', '--priority', 'low'], dataDir);
    const taskId = extractId(add.output, 'TK');
    assert.ok(taskId);

    cli(['claim', taskId, '--agent', 'gsd-executor-general'], dataDir);

    // Log only D-phase (missing E, T — should fail gates)
    cli(['rpetd', taskId, '--phase', 'D', '--content', 'D: LEARNING: only D-phase logged'], dataDir);

    // validate without --force should fail (missing E, T phases, no branch, no PR URL)
    const validate = cli(['validate', taskId, '--pass', '--validator', 'gsd-validator', '--notes', 'test'], dataDir);
    // Must NOT succeed — at minimum Gate 1 (branch) and Gate 3 (test evidence) should block
    assert.ok(!validate.success,
      `validate without force MUST fail (gates should block): success=${validate.success} out=${validate.output.slice(0, 200)}`);
  }));

  test('rpetd rejects invalid phase', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'Phase validation test', '--agent', 'gsd-executor-general'], dataDir);
    const taskId = extractId(add.output, 'TK');
    assert.ok(taskId);

    const r = cli(['rpetd', taskId, '--phase', 'Z', '--content', 'test'], dataDir);
    assert.ok(!r.success, 'should reject phase Z');
    assert.ok(r.error.includes('Invalid phase') || r.error.includes('Must be one of'),
      `should mention invalid phase: ${r.error}`);
  }));

  test('show --json after RPETD has phase data', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'JSON show test', '--agent', 'gsd-executor-general'], dataDir);
    const taskId = extractId(add.output, 'TK');
    assert.ok(taskId);

    cli(['claim', taskId, '--agent', 'gsd-executor-general'], dataDir);
    cli(['rpetd', taskId, '--phase', 'R', '--content', 'R: Research found X. LEARNING: use X pattern.'], dataDir);

    const show = cli(['show', taskId, '--json'], dataDir);
    assert.ok(show.success, `show --json failed: ${show.error}`);
    const task = JSON.parse(show.output);
    assert.ok(task.rpetd_phases, 'should have rpetd_phases');
    assert.ok(task.rpetd_phases.R, 'R phase should be set');
    assert.ok(task.rpetd_phases.R.includes('Research found X'), 'R content should be preserved');
  }));
});

// ═══════════════════════════════════════════════════════
// Memory pipeline (file mode)
// ═══════════════════════════════════════════════════════

describe('Memory pipeline (file mode, no daemon)', () => {

  test('store creates entry in .planning/memory/', () => withTmp(dataDir => {
    const r = mem(['store', 'test memory entry for offline pipeline', '--source', 'agent'], dataDir, { cwd: dataDir });
    assert.ok(r.success, `store failed: ${r.error || r.output}`);
    assert.ok(r.output.includes('Stored') || r.output.includes('file mode'),
      `store should confirm: ${r.output}`);

    // Check file was created
    const memDir = path.join(dataDir, '.planning', 'memory');
    if (fs.existsSync(memDir)) {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
      assert.ok(files.length > 0, 'memory file should exist');
      const content = files.map(f => fs.readFileSync(path.join(memDir, f), 'utf-8')).join('\n');
      assert.ok(content.includes('test memory entry'), `content should have entry: ${content.slice(0, 200)}`);
    }
  }));

  test('learn creates STATE.md entry', () => withTmp(dataDir => {
    const planningDir = path.join(dataDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    const r = mem(['learn', 'offline pipeline LEARNING test'], dataDir, { cwd: dataDir });
    assert.ok(r.success, `learn failed: ${r.error || r.output}`);
    assert.ok(r.output.includes('Stored') || r.output.includes('file mode'),
      `learn should confirm: ${r.output}`);

    // Check STATE.md or memory file was created
    const stateFile = path.join(planningDir, 'STATE.md');
    const memDir = path.join(planningDir, 'memory');
    const stateExists = fs.existsSync(stateFile);
    const memExists = fs.existsSync(memDir);
    assert.ok(stateExists || memExists,
      'learn should write to STATE.md or .planning/memory/');
  }));

  test('search returns results from file mode', () => withTmp(dataDir => {
    // Store first
    mem(['store', 'unique searchable entry XYZ123'], dataDir, { cwd: dataDir });

    // Search
    const r = mem(['search', 'XYZ123'], dataDir, { cwd: dataDir });
    assert.ok(r.success, `search failed: ${r.error || r.output}`);
    // In file mode, search may find the entry
    // (depends on whether store was in daemon mode — in offline mode should be in file)
    assert.ok(r.output.length > 0, 'search should produce output');
  }));

  test('count returns a number', () => withTmp(dataDir => {
    mem(['store', 'count test entry 1'], dataDir, { cwd: dataDir });
    mem(['store', 'count test entry 2'], dataDir, { cwd: dataDir });

    const r = mem(['count'], dataDir, { cwd: dataDir });
    assert.ok(r.success, `count failed: ${r.error || r.output}`);
    assert.ok(r.output.match(/\d+/), `count should return a number: ${r.output}`);
  }));

  test('list returns entries', () => withTmp(dataDir => {
    mem(['store', 'list test entry A'], dataDir, { cwd: dataDir });

    const r = mem(['list'], dataDir, { cwd: dataDir });
    assert.ok(r.success, `list failed: ${r.error || r.output}`);
    assert.ok(r.output.length > 0, 'list should produce output');
  }));

  test('skb-search fails gracefully without daemon (exits with error, no crash)', () => withTmp(dataDir => {
    const r = mem(['skb-search', 'test query'], dataDir, { cwd: dataDir });
    // Should fail (SKB requires PG) but NOT crash with unhandled exception
    assert.ok(!r.success, 'skb-search should fail without daemon');
    assert.ok(
      r.error.includes('PostgreSQL') || r.error.includes('Daemon') || r.error.includes('not available') ||
      r.output.includes('PostgreSQL') || r.output.includes('unavailable'),
      `should give clear error about PG requirement: ${r.error || r.output}`
    );
  }));

  test('skb-add fails gracefully without daemon', () => withTmp(dataDir => {
    const r = mem(['skb-add', 'test title', '--content', 'test content'], dataDir, { cwd: dataDir });
    assert.ok(!r.success, 'skb-add should fail without daemon');
    assert.ok(
      r.error.includes('PostgreSQL') || r.error.includes('Daemon') ||
      r.output.includes('PostgreSQL') || r.output.includes('unavailable'),
      `should give clear error: ${r.error || r.output}`
    );
  }));

  test('health reports daemon not running', () => withTmp(dataDir => {
    const r = mem(['health'], dataDir, { cwd: dataDir });
    // health always exits 1 when daemon is down — but should not crash
    assert.ok(r.error.includes('not reachable') || r.output.includes('not reachable') || !r.success,
      `health should report daemon down: ${r.error || r.output}`);
  }));
});

// ═══════════════════════════════════════════════════════
// Agent classification tests (via amauta.py _infer_lane)
// ═══════════════════════════════════════════════════════

describe('Agent classification (amauta.py)', () => {
  // Test by creating tasks with specific agents and checking if validate applies PR gate

  function makeTask(dataDir, agentName, taskType = 'task') {
    const tasks = {
      items: [{
        id: 'TK-AGENT1',
        type: taskType,
        title: 'Agent classification test',
        description: '',
        details: '',
        status: 'in-progress',
        priority: 'low',
        assigned_to: agentName,
        agent: agentName,
        claimed_by: agentName,
        tags: [],
        rpetd_phases: {
          R: 'R: research',
          P: 'P: plan',
          E: 'E: implemented on feat/test-branch',
          T: '$ npm test\nPASS 3/3',
          D: 'D: done. LEARNING: insight',
        },
        rpetd_complete: true,
        notes: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        success_criteria: [],
        deliverables: [],
        dependencies: [],
        importance: 3,
        urgency: 3,
      }],
      sprints: [],
      metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
    return 'TK-AGENT1';
  }

  test('gsd-executor-backend agent requires PR evidence (code lane)', () => withTmp(dataDir => {
    // Task with gsd-executor-backend but no PR URL — Gate 4 should fire
    const tasks = {
      items: [{
        id: 'TK-AGENT2',
        type: 'task',
        title: 'Executor backend test',
        status: 'in-progress',
        priority: 'low',
        assigned_to: 'gsd-executor-backend',
        agent: 'gsd-executor-backend',
        claimed_by: 'gsd-executor-backend',
        tags: [],
        rpetd_phases: {
          R: 'R: researched',
          P: 'P: planned',
          E: 'E: implemented on feat/test',
          T: '$ npm test\nPASS 5/5',
          D: 'D: delivered. LEARNING: always test.',
        },
        rpetd_complete: true,
        notes: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        success_criteria: [],
        deliverables: [],
        dependencies: [],
        importance: 3,
        urgency: 3,
      }],
      sprints: [],
      metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
    };
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));

    // Validate without --force — Gate 4 should block (no PR URL, no "merged")
    const r = py(['validate', 'TK-AGENT2', '--pass', '--validator', 'gsd-validator', '--notes', 'test'], dataDir);
    // Must NOT succeed — PR gate should block for code agents
    assert.ok(!r.success,
      `executor-backend validation must fail without PR evidence: success=${r.success} out=${r.output.slice(0, 200)}`);
  }));

  test('gsd-researcher agent (non-code) skips PR gate', () => withTmp(dataDir => {
    // Task with gsd-researcher (non-code) — Gate 4 should be skipped
    const tasks = {
      items: [{
        id: 'TK-AGENT3',
        type: 'research',
        title: 'Research task',
        status: 'in-progress',
        priority: 'low',
        assigned_to: 'gsd-researcher',
        agent: 'gsd-researcher',
        claimed_by: 'gsd-researcher',
        tags: [],
        rpetd_phases: {
          R: 'R: researched extensively',
          P: 'P: plan to synthesize',
          E: 'E: synthesized findings',
          T: 'T: reviewed findings for accuracy',
          D: 'D: report complete. LEARNING: this domain works X way.',
        },
        rpetd_complete: true,
        notes: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        success_criteria: [],
        deliverables: [],
        dependencies: [],
        importance: 3,
        urgency: 3,
      }],
      sprints: [],
      metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
    };
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));

    const r = py(['validate', 'TK-AGENT3', '--pass', '--validator', 'gsd-validator', '--notes', 'research reviewed'], dataDir);
    // Gate 4 should be SKIPPED for non-code/research tasks — check for FAIL specifically, not just keyword
    const stripped = (r.output || '').replace(/\x1b\[[0-9;]*m/g, '');
    const gate4Failed = stripped.includes('GATE[PR_URL]: FAIL');
    assert.ok(!gate4Failed,
      `researcher should skip PR gate: err=${r.error.slice(0, 200)} out=${r.output.slice(0, 200)}`);
  }));

  test('gsd-debugger agent requires PR evidence (code lane)', () => withTmp(dataDir => {
    // Debugger is now in CODE_AGENTS — should require PR gate
    const tasks = {
      items: [{
        id: 'TK-AGENT4',
        type: 'bug',
        title: 'Bug fix task',
        status: 'in-progress',
        priority: 'high',
        assigned_to: 'gsd-debugger',
        agent: 'gsd-debugger',
        claimed_by: 'gsd-debugger',
        tags: [],
        rpetd_phases: {
          R: 'R: observed bug in login flow',
          P: 'P: hypothesis: null pointer in auth.js:42',
          E: 'E: fixed on fix/login-null-ptr branch',
          T: '$ pytest tests/auth\nPASS 8/8',
          D: 'D: bug fixed. LEARNING: always null-check before dereferencing.',
        },
        rpetd_complete: true,
        notes: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        success_criteria: [],
        deliverables: [],
        dependencies: [],
        importance: 4,
        urgency: 5,
      }],
      sprints: [],
      metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
    };
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));

    // Should fail Gate 4 (no PR URL — only branch name)
    const r = py(['validate', 'TK-AGENT4', '--pass', '--validator', 'gsd-validator', '--notes', 'test'], dataDir);
    // Must NOT succeed — debugger is a code agent, PR gate should block
    assert.ok(!r.success,
      `debugger validation must fail without PR evidence: success=${r.success} out=${r.output.slice(0, 200)}`);
  }));
});

// ═══════════════════════════════════════════════════════
// CLI wrapper correctness
// ═══════════════════════════════════════════════════════

describe('CLI wrapper correctness (offline)', () => {

  test('amauta.cjs delegates to gsd-amauta.cjs (thin wrapper)', () => {
    const amautaCjs = path.join(__dirname, '..', 'get-shit-done', 'bin', 'amauta.cjs');
    const content = fs.readFileSync(amautaCjs, 'utf-8');
    assert.ok(
      content.includes('gsd-amauta.cjs') || content.includes('require'),
      'amauta.cjs should delegate to gsd-amauta.cjs'
    );
    assert.ok(content.length < 500, `amauta.cjs should be a thin wrapper: ${content.length} chars`);
  });

  test('help output says "amauta" not "gsd-amauta.cjs"', () => withTmp(dataDir => {
    const r = cli([], dataDir);
    // No-command invocation shows help
    assert.ok(r.output.includes('amauta') || r.error.includes('amauta'),
      `help should mention amauta: ${(r.output + r.error).slice(0, 300)}`);
  }));

  test('GSD_AMAUTA_NO_AUTO_START prevents daemon auto-start in env', () => withTmp(dataDir => {
    const r = cli(['stats'], dataDir);
    const noAutoStart = !r.error.includes('starting') && !r.error.includes('Started');
    assert.ok(noAutoStart,
      `NO_AUTO_START should prevent daemon start messages: ${r.error.slice(0, 200)}`);
  }));
});

// ═══════════════════════════════════════════════════════
// Search, status, and note routing (offline direct mode)
// ═══════════════════════════════════════════════════════

describe('Command routing correctness (offline)', () => {

  test('search command passes query as positional (not --query flag)', () => withTmp(dataDir => {
    py(['add', 'task', 'Searchable unique test alpha bravo', '--agent', 'gsd-executor-general'], dataDir);
    const r = py(['search', 'alpha bravo'], dataDir);
    // Should succeed — not fail with "unrecognized argument --query"
    const argError = r.error.includes('unrecognized argument') || r.error.includes('argparse');
    assert.ok(!argError, `search should not have argparse error: ${r.error.slice(0, 200)}`);
    // Should find the task or return no results (both valid)
    assert.ok(r.success || r.output.length > 0 || r.error.length > 0,
      'search should produce output');
  }));

  test('status command passes status_to as positional after id', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Status routing test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);
    py(['claim', id, '--agent', 'gsd-executor-general'], dataDir);

    // Move to deferred (a valid non-gated transition)
    const r = py(['status', id, 'deferred', '--agent', 'gsd-executor-general', '--note', 'test: status routing'], dataDir);
    // Should not fail with argparse error about wrong positional ordering
    const argError = r.error.includes('invalid choice') && !r.error.includes('deferred');
    assert.ok(!argError, `status should accept deferred: ${r.error.slice(0, 200)}`);
  }));

  test('note command accepts --content flag', () => withTmp(dataDir => {
    const add = py(['add', 'task', 'Note test task', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = py(['note', id, '--content', 'Test note via --content flag'], dataDir);
    assert.ok(r.success, `note --content should work: ${r.error || r.output}`);

    // Verify note appears in show
    const show = py(['show', id, '--json'], dataDir);
    const task = JSON.parse(show.output);
    const noteFound = (task.notes || []).some(n =>
      (typeof n === 'string' ? n : (n.text || '')).includes('Test note via --content')
    );
    assert.ok(noteFound, `note should appear in task: ${JSON.stringify(task.notes).slice(0, 200)}`);
  }));

  test('note command via CLI wrapper accepts both --content and --text', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'Note CLI test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    // Test --content (canonical)
    const r1 = cli(['note', id, '--content', 'Content flag test'], dataDir);
    assert.ok(r1.success, `note --content failed: ${r1.error || r1.output}`);

    // Test --text (backward compat)
    const r2 = cli(['note', id, '--text', 'Text flag test'], dataDir);
    assert.ok(r2.success, `note --text failed: ${r2.error || r2.output}`);
  }));

  test('delete command works in offline mode', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'Delete offline test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const del = cli(['delete', id], dataDir);
    assert.ok(del.success, `delete should work offline: ${del.error || del.output}`);

    // Show should fail after delete
    const show = cli(['show', id], dataDir);
    assert.ok(!show.success, `show after delete should fail: ${show.output}`);
  }));

  test('assign command works in offline mode', () => withTmp(dataDir => {
    const add = cli(['add', 'task', 'Assign offline test', '--agent', 'gsd-executor-general'], dataDir);
    const id = extractId(add.output, 'TK');
    assert.ok(id);

    const r = cli(['assign', id, '--agent', 'gsd-executor-backend'], dataDir);
    assert.ok(r.success, `assign offline: ${r.error || r.output}`);

    const show = cli(['show', id, '--json'], dataDir);
    if (show.success) {
      const task = JSON.parse(show.output);
      assert.strictEqual(task.assigned_to, 'gsd-executor-backend',
        `should be reassigned: ${task.assigned_to}`);
    }
  }));

  test('link command creates dependency in offline mode', () => withTmp(dataDir => {
    const a = cli(['add', 'task', 'Authentication module implementation', '--agent', 'gsd-executor-backend'], dataDir);
    const b = cli(['add', 'task', 'Deploy infrastructure pipeline', '--agent', 'gsd-executor-infra'], dataDir);
    const idA = extractId(a.output, 'TK');
    const idB = extractId(b.output, 'TK');
    assert.ok(idA && idB);
    assert.notStrictEqual(idA, idB, 'tasks should have different IDs');

    const r = cli(['link', idB, '--dep', idA], dataDir);
    assert.ok(r.success, `link should work offline: ${r.error || r.output}`);
  }));
});

// ═══════════════════════════════════════════════════════
// PG dual-write: pg_store.py task_upsert methods
// ═══════════════════════════════════════════════════════

describe('PG dual-write: task_upsert in pg_store.py', () => {

  test('task_upsert method exists in pg_store.py', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8'
    );
    assert.ok(content.includes('def task_upsert('), 'pg_store.py should have task_upsert method');
    assert.ok(content.includes('def task_upsert_batch('), 'pg_store.py should have task_upsert_batch method');
    assert.ok(content.includes('def task_delete('), 'pg_store.py should have task_delete method');
  });

  test('task_upsert uses INSERT ON CONFLICT DO UPDATE pattern', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8'
    );
    assert.ok(content.includes('ON CONFLICT (id) DO UPDATE'), 'should use upsert pattern');
    assert.ok(content.includes('gsd_tasks'), 'should target gsd_tasks table');
  });

  test('daemon mirrors task mutations to PG (dual-write code path exists)', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'amauta-daemon.py'), 'utf-8'
    );
    assert.ok(content.includes('task_upsert'), 'daemon should call task_upsert');
    assert.ok(content.includes('task_delete'), 'daemon should call task_delete');
    assert.ok(content.includes('TASK_MUTATING_COMMANDS'), 'daemon should identify mutating commands');
  });
});

// ═══════════════════════════════════════════════════════
// Gate config enforcement: verify workflows reference gate fields
// ═══════════════════════════════════════════════════════

describe('Gate config enforcement in workflows', () => {

  test('confirm_project gate wired in new-project.md', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'new-project.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_project'),
      'new-project.md should reference gates.confirm_project');
  });

  test('confirm_roadmap gate wired in new-project.md', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'new-project.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_roadmap'),
      'new-project.md should reference gates.confirm_roadmap');
  });

  test('confirm_phases gate wired in plan-phase.md', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'plan-phase.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_phases'),
      'plan-phase.md should reference gates.confirm_phases');
  });

  test('confirm_breakdown gate wired in plan-phase.md', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'plan-phase.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_breakdown'),
      'plan-phase.md should reference gates.confirm_breakdown');
  });

  test('confirm_plan gate wired in plan-phase.md', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'plan-phase.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_plan'),
      'plan-phase.md should reference gates.confirm_plan');
  });

  test('execute_next_plan gate wired in execute-plan.md (pre-existing)', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'execute-plan.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.execute_next_plan'),
      'execute-plan.md should reference gates.execute_next_plan');
  });

  test('confirm_transition gate wired in transition.md (pre-existing)', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'transition.md'), 'utf-8'
    );
    assert.ok(content.includes('gates.confirm_transition'),
      'transition.md should reference gates.confirm_transition');
  });

  test('confirm_milestone_scope added to config.json template', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'templates', 'config.json'), 'utf-8'
    );
    assert.ok(content.includes('confirm_milestone_scope'),
      'config.json should define confirm_milestone_scope');
  });

  test('all 9 gate fields defined in config.json template', () => {
    const config = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'templates', 'config.json'), 'utf-8'
    ));
    const gates = config.gates;
    const expected = [
      'confirm_project', 'confirm_phases', 'confirm_roadmap',
      'confirm_breakdown', 'confirm_plan', 'confirm_milestone_scope',
      'execute_next_plan', 'issues_review', 'confirm_transition'
    ];
    for (const gate of expected) {
      assert.ok(gate in gates, `config.json should define gates.${gate}`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// Quick task Amauta integration
// ═══════════════════════════════════════════════════════

describe('Quick task Amauta integration', () => {

  test('quick.md has amauta task creation in enrichment block', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'quick.md'), 'utf-8'
    );
    assert.ok(content.includes('amauta.cjs add task'),
      'quick.md should create amauta task');
    assert.ok(content.includes('--tags quick'),
      'quick.md should tag task as quick');
    assert.ok(content.includes('QUICK_TASK_ID'),
      'quick.md should track the task ID');
  });

  test('quick.md logs D-phase on completion', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'quick.md'), 'utf-8'
    );
    assert.ok(content.includes('rpetd "$QUICK_TASK_ID" --phase D'),
      'quick.md should log D-phase for quick task');
  });

  test('quick.md marks task done on completion', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'quick.md'), 'utf-8'
    );
    assert.ok(content.includes('status "$QUICK_TASK_ID" done'),
      'quick.md should mark task done');
  });
});

// ═══════════════════════════════════════════════════════
// gsd- prefix consistency verification
// ═══════════════════════════════════════════════════════

describe('gsd- prefix consistency across all layers', () => {

  test('all 11 agent files exist with gsd- prefix', () => {
    const agents = fs.readdirSync(path.join(__dirname, '..', 'agents'))
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.strictEqual(agents.length, 11, `should have 11 gsd- agents: ${agents.join(', ')}`);
  });

  test('all 11 skill directories exist with gsd-*-workflow naming', () => {
    const skills = fs.readdirSync(path.join(__dirname, '..', 'skills'))
      .filter(f => f.startsWith('gsd-') && f.endsWith('-workflow'));
    assert.strictEqual(skills.length, 11, `should have 11 gsd-*-workflow dirs: ${skills.join(', ')}`);
  });

  test('each agent skills: field resolves to an existing skill directory', () => {
    const agentsDir = path.join(__dirname, '..', 'agents');
    const skillsDir = path.join(__dirname, '..', 'skills');
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));

    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
      const skillMatch = content.match(/skills:\s*\n\s*-\s*(\S+)/);
      if (skillMatch) {
        const skillRef = skillMatch[1];
        assert.ok(fs.existsSync(path.join(skillsDir, skillRef)),
          `${file}: skills: ${skillRef} should exist in skills/`);
      }
    }
  });

  test('CODE_AGENTS and NON_CODE_AGENTS constants defined in amauta.py', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'amauta.py'), 'utf-8');
    assert.ok(content.includes('CODE_AGENTS'), 'amauta.py should define CODE_AGENTS');
    assert.ok(content.includes('NON_CODE_AGENTS'), 'amauta.py should define NON_CODE_AGENTS');
    assert.ok(content.includes('OPENCODE_AGENTS'), 'amauta.py should define OPENCODE_AGENTS');
    // Verify gsd-debugger is in CODE_AGENTS (not NON_CODE_AGENTS)
    assert.ok(content.includes('"gsd-debugger"'),
      'amauta.py should reference gsd-debugger');
  });

  test('MODEL_PROFILES has entries for all gsd- agents', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'core.cjs'), 'utf-8'
    );
    const agents = [
      'gsd-operator', 'gsd-planner', 'gsd-roadmapper', 'gsd-researcher',
      'gsd-executor-frontend', 'gsd-executor-backend', 'gsd-executor-infra',
      'gsd-executor-general', 'gsd-checker', 'gsd-validator', 'gsd-debugger'
    ];
    for (const agent of agents) {
      assert.ok(content.includes(`'${agent}'`) || content.includes(`"${agent}"`),
        `MODEL_PROFILES should have entry for ${agent}`);
    }
  });
});
