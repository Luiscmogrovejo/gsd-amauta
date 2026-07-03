'use strict';
/**
 * tests/62-01-telemetry-consent.test.cjs — Phase 62 TEL-01 evidence.
 *
 * Consent gating, zero pre-consent collection, first-run notice, preview
 * disclosure, env seams. Every test uses an fs.mkdtempSync sandbox wired
 * through GSD_TELEMETRY_CONFIG_PATH + AMAUTA_DATA_DIR (never the repo's
 * real .planning/config.json or data/).
 *
 * Run: node --test tests/62-01-telemetry-consent.test.cjs
 *      node scripts/run-tests.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const TELEMETRY_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'telemetry.cjs');

/** Fresh sandbox: tmp config.json (written with `initialConfig`) + tmp data dir. */
function makeSandbox(initialConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-consent-'));
  const configPath = path.join(dir, 'config.json');
  if (initialConfig !== null) {
    fs.writeFileSync(configPath, JSON.stringify(initialConfig === undefined ? {} : initialConfig));
  }
  const dataDir = path.join(dir, 'data');
  return { dir, configPath, dataDir };
}

/** Spawn `node gsd-amauta.cjs <args>` with an isolated telemetry env.
 * Uses spawnSync (not execFileSync) so stdout AND stderr are both captured
 * regardless of exit code — execFileSync discards stderr on success. */
function runCli(args, sandbox, extraEnv) {
  const env = {
    ...process.env,
    GSD_TELEMETRY_CONFIG_PATH: sandbox.configPath,
    AMAUTA_DATA_DIR: sandbox.dataDir,
    ...(extraEnv || {}),
  };
  const result = spawnSync(process.execPath, [AMAUTA_CJS, ...args], {
    env,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: typeof result.status === 'number' ? result.status : 1,
  };
}

/** In-process require of telemetry.cjs with a fresh module cache, so
 * process.env mutations (GSD_TELEMETRY, GSD_TELEMETRY_CONFIG_PATH,
 * AMAUTA_DATA_DIR) are re-read on each require. */
function freshTelemetry() {
  delete require.cache[require.resolve(TELEMETRY_CJS)];
  return require(TELEMETRY_CJS);
}

// ─── Case 1: DEFAULT OFF + ZERO COLLECTION ─────────────────────────────────

describe('[TEL-01] Default OFF + zero pre-consent collection', () => {
  test('spawned `telemetry status` reports enabled:false with config {}', () => {
    const sandbox = makeSandbox({});
    const { stdout, status } = runCli(['telemetry', 'status', '--json'], sandbox);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.enabled, false);
  });

  test('in-process emit() no-ops and never creates the buffer file', () => {
    const sandbox = makeSandbox({});
    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevData = process.env.AMAUTA_DATA_DIR;
    const prevFlag = process.env.GSD_TELEMETRY;
    process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
    process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
    delete process.env.GSD_TELEMETRY;
    try {
      const t = freshTelemetry();
      const result = t.emit('phase_start', {});
      assert.equal(result.emitted, false);
      assert.equal(result.reason, 'disabled');
      assert.equal(fs.existsSync(path.join(sandbox.dataDir, 'telemetry-buffer.jsonl')), false);
      assert.equal(fs.existsSync(sandbox.dataDir), false, 'dataDir itself must not be created pre-consent');
    } finally {
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
      if (prevData === undefined) delete process.env.AMAUTA_DATA_DIR; else process.env.AMAUTA_DATA_DIR = prevData;
      if (prevFlag === undefined) delete process.env.GSD_TELEMETRY; else process.env.GSD_TELEMETRY = prevFlag;
    }
  });
});

// ─── Case 2: FIRST-RUN NOTICE ONCE ──────────────────────────────────────────

describe('[TEL-01] First-run consent notice fires at most once', () => {
  test('first spawn notices, writes prompted_at+salt (enabled still false), second spawn is silent', () => {
    const sandbox = makeSandbox({});

    const first = runCli(['telemetry', 'status'], sandbox);
    assert.match(first.stderr, /telemetry/i);

    const cfgAfterFirst = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));
    assert.equal(cfgAfterFirst.telemetry.enabled, false);
    assert.ok(cfgAfterFirst.telemetry.prompted_at, 'prompted_at must be set after first spawn');
    assert.match(cfgAfterFirst.telemetry.salt, /^[0-9a-f]{16}$/);

    const second = runCli(['telemetry', 'status'], sandbox);
    assert.doesNotMatch(second.stderr, /telemetry is OFF by default/);
  });
});

// ─── Case 3: NO CONFIG FILE → no notice, no file created ───────────────────

describe('[TEL-01] No config file: non-project cwd safety', () => {
  test('missing config.json produces no notice and no file is created', () => {
    const sandbox = makeSandbox(null); // do not write config.json at all
    assert.equal(fs.existsSync(sandbox.configPath), false);

    const { stderr } = runCli(['telemetry', 'status'], sandbox);
    assert.doesNotMatch(stderr, /telemetry is OFF by default/);
    assert.equal(fs.existsSync(sandbox.configPath), false, 'config.json must never be scaffolded by telemetry code');
  });
});

// ─── Case 4: ENABLE ─────────────────────────────────────────────────────────

describe('[TEL-01] telemetry enable --yes', () => {
  test('writes enabled:true + ISO consented_at + 16-hex salt; discloses all 8 event types', () => {
    const sandbox = makeSandbox({});
    const { stdout, status } = runCli(['telemetry', 'enable', '--yes'], sandbox);
    assert.equal(status, 0);

    const EVENT_TYPES = [
      'phase_start', 'phase_complete', 'validator_verdict',
      'divergence_filed', 'divergence_resolved', 'escalation_fired',
      'party_session', 'error_class',
    ];
    for (const evt of EVENT_TYPES) {
      assert.ok(stdout.includes(evt), `disclosure output must name event type '${evt}'`);
    }

    const cfg = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));
    assert.equal(cfg.telemetry.enabled, true);
    assert.ok(!Number.isNaN(Date.parse(cfg.telemetry.consented_at)));
    assert.match(cfg.telemetry.salt, /^[0-9a-f]{16}$/);
  });
});

// ─── Case 5: GLOBAL FLAG ────────────────────────────────────────────────────

describe('[TEL-01] --enable-telemetry global flag', () => {
  test('spawned alone: same consent state as `telemetry enable --yes`, exit 0', () => {
    const sandbox = makeSandbox({});
    const { status } = runCli(['--enable-telemetry'], sandbox);
    assert.equal(status, 0);

    const cfg = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));
    assert.equal(cfg.telemetry.enabled, true);
    assert.ok(!Number.isNaN(Date.parse(cfg.telemetry.consented_at)));
    assert.match(cfg.telemetry.salt, /^[0-9a-f]{16}$/);
  });
});

// ─── Case 6: HARD KILL ──────────────────────────────────────────────────────

describe('[TEL-01] GSD_TELEMETRY=off hard-kills regardless of config', () => {
  test('enabled:true in config but env=off -> isEnabled() false, emit() records nothing', () => {
    const sandbox = makeSandbox({
      telemetry: { enabled: true, consented_at: new Date().toISOString(), salt: 'abcdef0123456789', sink_url: null },
    });
    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevData = process.env.AMAUTA_DATA_DIR;
    const prevFlag = process.env.GSD_TELEMETRY;
    process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
    process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
    process.env.GSD_TELEMETRY = 'off';
    try {
      const t = freshTelemetry();
      assert.equal(t.isEnabled(), false);
      const result = t.emit('phase_start', {});
      assert.equal(result.emitted, false);
      assert.equal(result.reason, 'disabled');
    } finally {
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
      if (prevData === undefined) delete process.env.AMAUTA_DATA_DIR; else process.env.AMAUTA_DATA_DIR = prevData;
      if (prevFlag === undefined) delete process.env.GSD_TELEMETRY; else process.env.GSD_TELEMETRY = prevFlag;
    }
  });
});

// ─── Case 7: EXCLUSIVE SEAM ─────────────────────────────────────────────────

describe('[TEL-01] GSD_TELEMETRY_CONFIG_PATH is authoritative-exclusive', () => {
  test('nonexistent override path never falls through to a real cwd config', () => {
    const cwdSandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-consent-cwd-'));
    fs.writeFileSync(
      path.join(cwdSandboxDir, '.planning-config-marker.json'), // not read by anything, just proves the dir exists
      '{}'
    );
    const planningDir = path.join(cwdSandboxDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: null, consented_at: new Date().toISOString() } })
    );

    const nonexistentOverride = path.join(cwdSandboxDir, 'nope', 'does-not-exist.json');
    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevCwd = process.cwd();
    process.env.GSD_TELEMETRY_CONFIG_PATH = nonexistentOverride;
    try {
      process.chdir(cwdSandboxDir);
      const t = freshTelemetry();
      assert.equal(t.isEnabled(), false, 'exclusive seam must not fall through to cwd config even when override path is missing');
    } finally {
      process.chdir(prevCwd);
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
    }
  });
});

// ─── Case 8: PREVIEW ────────────────────────────────────────────────────────

describe('[TEL-01] telemetry preview / show-payload disclosure', () => {
  test('with one buffered event, preview stdout deep-equals the buffered event', () => {
    const sandbox = makeSandbox({
      telemetry: { enabled: true, consented_at: new Date().toISOString(), salt: 'abcdef0123456789', sink_url: null },
    });

    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevData = process.env.AMAUTA_DATA_DIR;
    process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
    process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
    let emitted;
    try {
      const t = freshTelemetry();
      const r = t.emit('phase_start', { sample: 'x' });
      assert.equal(r.emitted, true);
      emitted = t.readLastEvent();
    } finally {
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
      if (prevData === undefined) delete process.env.AMAUTA_DATA_DIR; else process.env.AMAUTA_DATA_DIR = prevData;
    }

    const { stdout, status } = runCli(['telemetry', 'preview'], sandbox);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, emitted);
  });

  test('with an empty buffer, preview synthesizes a 6-key sample and mentions it on stderr', () => {
    const sandbox = makeSandbox({
      telemetry: { enabled: true, consented_at: new Date().toISOString(), salt: 'abcdef0123456789', sink_url: null },
    });
    const { stdout, stderr, status } = runCli(['telemetry', 'preview'], sandbox);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    const keys = Object.keys(parsed).sort().join(',');
    assert.equal(keys, 'event_id,event_type,payload,project_hash,schema_version,ts');
    assert.match(stderr, /sample/i);
  });
});

// ─── Case 9: PRIVACY SHAPE ──────────────────────────────────────────────────

describe('[TEL-01] Privacy shape: project_hash never leaks the raw repo name', () => {
  test('project_hash is 16 hex chars and does not contain the repo basename', () => {
    const sandbox = makeSandbox({
      telemetry: { enabled: true, consented_at: new Date().toISOString(), salt: 'abcdef0123456789', sink_url: null },
    });
    const prevCfg = process.env.GSD_TELEMETRY_CONFIG_PATH;
    const prevData = process.env.AMAUTA_DATA_DIR;
    process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
    process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
    try {
      const t = freshTelemetry();
      const event = t.buildEvent('phase_start', {});
      assert.match(event.project_hash, /^[0-9a-f]{16}$/);
      const repoBasename = path.basename(ROOT);
      assert.equal(event.project_hash.includes(repoBasename), false);
    } finally {
      if (prevCfg === undefined) delete process.env.GSD_TELEMETRY_CONFIG_PATH; else process.env.GSD_TELEMETRY_CONFIG_PATH = prevCfg;
      if (prevData === undefined) delete process.env.AMAUTA_DATA_DIR; else process.env.AMAUTA_DATA_DIR = prevData;
    }
  });
});
