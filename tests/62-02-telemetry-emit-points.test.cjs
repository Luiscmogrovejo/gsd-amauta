'use strict';
/**
 * tests/62-02-telemetry-emit-points.test.cjs — Phase 62 TEL-02 evidence.
 *
 * Asserts each of the 6 Node-side emit points (phase_start, phase_complete,
 * escalation_fired, divergence_filed, validator_verdict, error_class) lands
 * exactly one typed event in the local buffer when telemetry is enabled, and
 * that the same commands produce zero buffer bytes when telemetry is at its
 * default OFF state.
 *
 * TK-1715 / divergence resolution (2026-07-03, orchestrator decision:
 * expand-scope, option A amended): `phase_complete` fires BEFORE
 * `phase.cmdPhaseComplete(...)` returns control (ATTEMPT semantics,
 * mirroring `phase_start`'s established precedent) — because
 * `core.cjs`'s `output()`/`error()` helpers both call `process.exit()`
 * unconditionally, so code placed AFTER `cmdPhaseComplete(...)` never runs.
 * Test case 2 below asserts this attempt-emission behavior directly: a
 * `phase complete` on a NONEXISTENT phase (which errors and exits 1) still
 * buffers exactly one phase_complete event.
 *
 * Sandbox recipe for every case: tmp dir + AMAUTA_DATA_DIR=tmp/data +
 * GSD_TELEMETRY_CONFIG_PATH=tmp/config.json — never the repo's real
 * .planning/config.json or data/. Assert by reading
 * tmp/data/telemetry-buffer.jsonl and filtering on event_type.
 *
 * DEFAULT-OFF regression config (case 7 + the "default-OFF" halves of cases
 * 2 and 5): {"telemetry":{"enabled":false}} — see DISABLED_CONFIG below.
 *
 * Run: node --test tests/62-02-telemetry-emit-points.test.cjs
 *      node scripts/run-tests.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const AMAUTA_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const AMAUTA_PY_EXISTS = fs.existsSync(path.join(ROOT, 'amauta.py'));

// ─── Sandbox + spawn helpers ────────────────────────────────────────────────

/** Fresh sandbox: tmp config.json (written with `initialConfig`) + tmp data dir + tmp project dir. */
function makeSandbox(initialConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-emit-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(initialConfig));
  const dataDir = path.join(dir, 'data');
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  return { dir, configPath, dataDir, projectDir };
}

const ENABLED_CONFIG = Object.freeze({
  telemetry: { enabled: true, consented_at: new Date().toISOString(), salt: 'abcd1234abcd1234', sink_url: null },
});
const DISABLED_CONFIG = Object.freeze({ telemetry: { enabled: false } });

/** Spawn `node <cliPath> <args>` with an isolated telemetry + data env. */
function runCli(cliPath, args, sandbox, extraEnv) {
  const env = {
    ...process.env,
    GSD_TELEMETRY_CONFIG_PATH: sandbox.configPath,
    AMAUTA_DATA_DIR: sandbox.dataDir,
    ...(extraEnv || {}),
  };
  const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 15000 });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: typeof result.status === 'number' ? result.status : 1,
  };
}

function runTools(args, sandbox, extraEnv) { return runCli(TOOLS_CJS, args, sandbox, extraEnv); }
function runAmauta(args, sandbox, extraEnv) { return runCli(AMAUTA_CJS, args, sandbox, extraEnv); }

/**
 * Async (non-blocking) variant of runCli — REQUIRED whenever the parent
 * process itself hosts a listener (e.g. the fake-daemon HTTP server in case
 * 6) that must keep servicing requests WHILE the child runs. spawnSync
 * blocks the parent's event loop for its entire duration, so a same-process
 * HTTP server can never accept the child's connection until the child
 * already gave up and timed out — this async variant avoids that deadlock.
 */
function runCliAsync(cliPath, args, sandbox, extraEnv) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GSD_TELEMETRY_CONFIG_PATH: sandbox.configPath,
      AMAUTA_DATA_DIR: sandbox.dataDir,
      ...(extraEnv || {}),
    };
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ stdout, stderr, status: code === null ? 1 : code }));
  });
}

const BUFFER_FILENAME = 'telemetry-buffer.jsonl';

function bufferPath(sandbox) { return path.join(sandbox.dataDir, BUFFER_FILENAME); }

/** Read + parse every buffered event line, or [] when the buffer is absent. */
function readBufferedEvents(sandbox) {
  try {
    const raw = fs.readFileSync(bufferPath(sandbox), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function eventsOfType(sandbox, eventType) {
  return readBufferedEvents(sandbox).filter((e) => e.event_type === eventType);
}

function extractId(output, prefix = 'TK') {
  const m = output.match(new RegExp(`${prefix}-\\d+`));
  return m ? m[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Case 1: phase_start — fires BEFORE the handler (attempt semantics)
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] phase_start emits before init.cmdInitExecutePhase runs', () => {
  test('enabled: exactly one phase_start event, payload.phase == "62"', () => {
    const sandbox = makeSandbox(ENABLED_CONFIG);
    runTools(['init', 'execute-phase', '62', '--cwd', sandbox.projectDir], sandbox);
    const events = eventsOfType(sandbox, 'phase_start');
    assert.equal(events.length, 1, `expected exactly one phase_start event, got ${events.length}`);
    assert.equal(events[0].payload.phase, '62');
    assert.equal(events[0].schema_version, '1.1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 2: phase_complete — ATTEMPT semantics (divergence resolution, TK-1715)
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] phase_complete: attempt semantics (fires even when the phase does not exist)', () => {
  test('enabled: `phase complete` on a NONEXISTENT phase still buffers one phase_complete event', () => {
    const sandbox = makeSandbox(ENABLED_CONFIG);
    // No .planning/phases/999-* directory exists in this fixture — cmdPhaseComplete
    // will call error('Phase 999 not found') and process.exit(1). The emit is
    // placed BEFORE the phase.cmdPhaseComplete(...) call, so it must still fire.
    const r = runTools(['phase', 'complete', '999', '--cwd', sandbox.projectDir], sandbox);
    assert.notEqual(r.status, 0, 'phase 999 should not exist — command should error-exit');
    const events = eventsOfType(sandbox, 'phase_complete');
    assert.equal(events.length, 1, `expected exactly one phase_complete event even on error-exit, got ${events.length}`);
    assert.equal(events[0].payload.phase, '999');
  });

  test('default-OFF: same nonexistent-phase command buffers nothing, same exit code as enabled run', () => {
    const enabledSandbox = makeSandbox(ENABLED_CONFIG);
    const enabledRun = runTools(['phase', 'complete', '999', '--cwd', enabledSandbox.projectDir], enabledSandbox);

    const disabledSandbox = makeSandbox(DISABLED_CONFIG);
    const disabledRun = runTools(['phase', 'complete', '999', '--cwd', disabledSandbox.projectDir], disabledSandbox);

    assert.equal(disabledRun.status, enabledRun.status, 'exit code must be byte-identical regardless of telemetry state');
    assert.equal(fs.existsSync(bufferPath(disabledSandbox)), false, 'buffer file must not exist when telemetry is disabled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 3: escalation_fired — graceful degradation path (no daemon)
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] escalation_fired: graceful-degradation (daemon-down) path', () => {
  test('enabled: one escalation_fired event with payload.task_id "TK-0001"', () => {
    const sandbox = makeSandbox(ENABLED_CONFIG);
    const r = runTools(
      ['complexity-escalate', 'TK-0001', '--workflow', 'execute-phase'],
      sandbox,
      { GSD_AMAUTA_PORT: '19998', AMAUTA_PORT: '19998' } // unreachable — forces daemon-down banner path
    );
    assert.equal(r.status, 0, `escalate should degrade gracefully: ${r.stderr}`);
    const events = eventsOfType(sandbox, 'escalation_fired');
    assert.equal(events.length, 1, `expected exactly one escalation_fired event, got ${events.length}`);
    assert.equal(events[0].payload.task_id, 'TK-0001');
    assert.equal(events[0].payload.workflow, 'execute-phase');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 4: divergence_filed — in-process _diffPlanVsAmauta (plan_amauta_drift)
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] divergence_filed: plan/amauta drift construction site', () => {
  test('enabled: one divergence_filed event, numeric diff_count, NO "diffs" key', () => {
    const { _diffPlanVsAmauta } = require(TOOLS_CJS);
    const sandbox = makeSandbox(ENABLED_CONFIG);

    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevData = process.env.AMAUTA_DATA_DIR;
    process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
    process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
    try {
      const planTasks = [{
        id: 'X-01',
        title: 'Plan-side title',
        agent: 'executor-backend',
        filesExpected: { modify: [], create: [], delete: [] },
        dependsOn: [],
      }];
      const amautaTasks = [{ id: 'X-01', title: 'Amauta-side title (drifted)', assigned_to: 'executor-backend' }];
      const result = _diffPlanVsAmauta(planTasks, amautaTasks);
      assert.equal(result.drifted, true, 'title mismatch must register as drift');
      assert.equal(result.divergence_type, 'plan_amauta_drift');
    } finally {
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
      if (prevData === undefined) delete process.env.AMAUTA_DATA_DIR; else process.env.AMAUTA_DATA_DIR = prevData;
    }

    const events = eventsOfType(sandbox, 'divergence_filed');
    assert.equal(events.length, 1, `expected exactly one divergence_filed event, got ${events.length}`);
    assert.equal(events[0].payload.divergence_type, 'plan_amauta_drift');
    assert.equal(typeof events[0].payload.diff_count, 'number');
    assert.ok(events[0].payload.diff_count >= 1);
    assert.equal('diffs' in events[0].payload, false, 'payload must NEVER carry the diffs array');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 5: validator_verdict — direct-mode (daemon-down) file fallback
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] validator_verdict: direct-mode (daemon-down) --fail path', () => {
  (AMAUTA_PY_EXISTS ? test : test.skip)('enabled: one validator_verdict event with verdict "fail", no path-bearing keys', () => {
    const sandbox = makeSandbox(ENABLED_CONFIG);
    const noDaemonEnv = { GSD_AMAUTA_NO_AUTO_START: '1', GSD_AMAUTA_PORT: '19997' };

    const add = runAmauta(['add', 'task', 't62', '--agent', 'gsd-executor-general', '--json'], sandbox, noDaemonEnv);
    const taskId = extractId(add.stdout, 'TK');
    assert.ok(taskId, `add should return a task id: ${add.stdout} ${add.stderr}`);

    // NOTE: intentionally `status ... in-progress` here, NOT `claim` — `claim`
    // triggers Layer 1 PG-memory enrichment which routinely exceeds
    // execFileSync's 30s timeout under concurrent-session load (same
    // ETIMEDOUT documented for TK-1715 in 62-02-SUMMARY.md); `status` performs
    // the identical pending->in-progress transition without the enrichment
    // side-call, so validate's status-precondition gate is satisfied fast
    // and deterministically.
    runAmauta(['status', taskId, 'in-progress', '--agent', 'gsd-executor-general', '--json'], sandbox, noDaemonEnv);

    const validate = runAmauta(
      ['validate', taskId, '--fail', '--validator', 'gsd-validator', '--notes', 'test', '--json'],
      sandbox,
      noDaemonEnv
    );
    assert.equal(validate.status, 0, `validate --fail should succeed (record the rejection): ${validate.stderr}`);

    const events = eventsOfType(sandbox, 'validator_verdict');
    assert.equal(events.length, 1, `expected exactly one validator_verdict event, got ${events.length}`);
    assert.equal(events[0].payload.verdict, 'fail');
    assert.equal(events[0].payload.task_id, taskId);
    for (const key of Object.keys(events[0].payload)) {
      assert.doesNotMatch(key, /\//, 'payload keys must never carry path fragments');
      const val = events[0].payload[key];
      if (typeof val === 'string') assert.doesNotMatch(val, /\//, `payload.${key} must not carry a path fragment`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 6: error_class — main().catch FATAL handler
// ═══════════════════════════════════════════════════════════════════════════
//
// gsd-amauta.cjs's dispatch is defensively try/catch-guarded at nearly every
// call site (fail-open by design) except ONE: `cmdBoard`'s
// `await httpRequest('GET', '/api/board')` when useDaemon is true is NOT
// wrapped, and httpRequest()'s `req.on('error', reject)` propagates a raw
// socket error straight through main()'s un-guarded switch to
// `main().catch(...)` — the FATAL handler under test. A local fake "daemon"
// that answers /health with 200 (forcing ensureDaemon()->true) but destroys
// the socket for any other path deterministically reaches this handler
// without depending on OS/network flake.

function withFakeDaemon(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      Promise.resolve()
        .then(() => fn(port))
        .then((v) => server.close(() => resolve(v)), (err) => server.close(() => reject(err)));
    });
  });
}

describe('[TEL-02] error_class: main().catch FATAL handler', () => {
  test('enabled: one error_class event, error_class + code set, NO "message" key', async () => {
    const sandbox = makeSandbox(ENABLED_CONFIG);
    await withFakeDaemon(
      (req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', pid: 1 }));
          return;
        }
        req.socket.destroy(); // deterministic ECONNRESET on the client's httpRequest()
      },
      async (port) => {
        const r = await runCliAsync(AMAUTA_CJS, ['board'], sandbox, {
          GSD_AMAUTA_HOST: '127.0.0.1',
          GSD_AMAUTA_PORT: String(port),
          GSD_AMAUTA_NO_AUTO_START: '1',
        });
        assert.notEqual(r.status, 0, 'a FATAL should exit non-zero');
        assert.match(r.stderr, /FATAL:/);
      }
    );

    const events = eventsOfType(sandbox, 'error_class');
    assert.equal(events.length, 1, `expected exactly one error_class event, got ${events.length}`);
    assert.ok(events[0].payload.error_class, 'error_class must be set');
    assert.equal('message' in events[0].payload, false, 'payload must NEVER carry err.message');
    assert.equal(events[0].payload.verb, 'board');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 7: DEFAULT-OFF regression — phase_start, escalation_fired, validator_verdict
// ═══════════════════════════════════════════════════════════════════════════

describe('[TEL-02] DEFAULT-OFF regression: enabled:false buffers nothing, byte-identical exit codes', () => {
  test('phase_start (init execute-phase): no buffer file, same exit code as enabled', () => {
    const enabledSandbox = makeSandbox(ENABLED_CONFIG);
    const enabledRun = runTools(['init', 'execute-phase', '62', '--cwd', enabledSandbox.projectDir], enabledSandbox);

    const disabledSandbox = makeSandbox(DISABLED_CONFIG);
    const disabledRun = runTools(['init', 'execute-phase', '62', '--cwd', disabledSandbox.projectDir], disabledSandbox);

    assert.equal(disabledRun.status, enabledRun.status);
    assert.equal(fs.existsSync(bufferPath(disabledSandbox)), false);
  });

  test('escalation_fired (complexity-escalate, daemon-down): no buffer file, same exit code as enabled', () => {
    const noDaemonEnv = { GSD_AMAUTA_PORT: '19996', AMAUTA_PORT: '19996' };
    const enabledSandbox = makeSandbox(ENABLED_CONFIG);
    const enabledRun = runTools(['complexity-escalate', 'TK-0001', '--workflow', 'execute-phase'], enabledSandbox, noDaemonEnv);

    const disabledSandbox = makeSandbox(DISABLED_CONFIG);
    const disabledRun = runTools(['complexity-escalate', 'TK-0001', '--workflow', 'execute-phase'], disabledSandbox, noDaemonEnv);

    assert.equal(disabledRun.status, enabledRun.status);
    assert.equal(fs.existsSync(bufferPath(disabledSandbox)), false);
  });

  (AMAUTA_PY_EXISTS ? test : test.skip)('validator_verdict (validate --fail, direct mode): no buffer file, same exit code as enabled', () => {
    const noDaemonEnv = { GSD_AMAUTA_NO_AUTO_START: '1', GSD_AMAUTA_PORT: '19995' };

    const enabledSandbox = makeSandbox(ENABLED_CONFIG);
    const addEnabled = runAmauta(['add', 'task', 't62off', '--agent', 'gsd-executor-general', '--json'], enabledSandbox, noDaemonEnv);
    const taskIdEnabled = extractId(addEnabled.stdout, 'TK');
    runAmauta(['status', taskIdEnabled, 'in-progress', '--agent', 'gsd-executor-general', '--json'], enabledSandbox, noDaemonEnv);
    const enabledRun = runAmauta(['validate', taskIdEnabled, '--fail', '--validator', 'gsd-validator', '--notes', 'test', '--json'], enabledSandbox, noDaemonEnv);

    const disabledSandbox = makeSandbox(DISABLED_CONFIG);
    const addDisabled = runAmauta(['add', 'task', 't62off', '--agent', 'gsd-executor-general', '--json'], disabledSandbox, noDaemonEnv);
    const taskIdDisabled = extractId(addDisabled.stdout, 'TK');
    runAmauta(['status', taskIdDisabled, 'in-progress', '--agent', 'gsd-executor-general', '--json'], disabledSandbox, noDaemonEnv);
    const disabledRun = runAmauta(['validate', taskIdDisabled, '--fail', '--validator', 'gsd-validator', '--notes', 'test', '--json'], disabledSandbox, noDaemonEnv);

    assert.equal(disabledRun.status, enabledRun.status);
    assert.equal(fs.existsSync(bufferPath(disabledSandbox)), false);
  });
});
