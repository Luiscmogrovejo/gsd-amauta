'use strict';

// ============================================================================
// Phase 83 — Trigger & Loop Integration CAPSTONE behavioral test
// (plan 83-01, task 83-01-04, LOOP-01 + LOOP-02 + LOOP-03). The FINAL v3.6 test.
//
// Proves the immune loop is RUNNABLE and CLOSES end-to-end against the live
// substrate, across the three trigger/integration requirements:
//
//   LOOP-01  `/amauta:audit [domain]` on-demand — the shared read-only engine
//            (get-shit-done/bin/lib/audit-runner.cjs) runs each of the 9 domain
//            auditors' documented headline detects, fires on a seeded/real
//            violation and NOT on a clean control (deterministic-before-
//            behavioral SC1 proxy), and the `gsd-tools audit` verb reports them.
//   LOOP-02  on-phase-close trigger — ADVISORY, config-gated, NON-BLOCKING:
//            source-analysis proves the hook sits BEFORE the process.exit()ing
//            cmdPhaseComplete, is try/catch-guarded, reads audit.on_phase_close
//            with a default, delegates to the engine, and never calls
//            error(/process.exit( on the audit path (it never blocks a phase).
//   LOOP-03  THE CAPSTONE — the full loop demonstrated end-to-end against the
//            live substrate: the engine files a REAL finding on a seeded fixture
//            -> findings-to-plan stamps a FIDEL-gated fix-task tagged
//            finding:<dedup_key> -> the fixture is FIXED + the task validated ->
//            audit-close-loop (engine-backed narrow re-audit) flips the finding
//            to status='cleared'. A no-op-fix control REOPENS the finding +
//            emits a validator/finding divergence (green validator + persistent
//            defect = a reportable mismatch).
//
// Two layers:
//   ALWAYS-RUN  — pure detect-soundness for all 9 domains + the verb dry-run +
//                 the LOOP-02/LOOP-03 source-analysis + the operator surface.
//                 No daemon/PG needed.
//   LIVE-DAEMON — skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799}
//                 is unreachable (mirrors the 79-01/82-01 gate). Drives the full
//                 loop over HTTP; PATCH-clears every finding it posts and removes
//                 every tmp fixture. The hyphenated daemon starts servers at
//                 import, so it is hit over HTTP, NEVER required. No sleeps.
//
// NOTE (surfaced, out-of-scope): the pre-existing `=== 17` listAgents count
// assertions in tests/agent-compiler.test.cjs + tests/gsd-tools-agents-cli.test.cjs
// are ALREADY RED (35 vs 17, 10 auditor dirs now exist). Phase 83 adds no agent
// and does not touch them — their failure is pre-existing drift, not this plan.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'audit-runner.cjs');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CMD_MD = path.join(ROOT, 'commands', 'amauta', 'audit.md');
const WORKFLOW_MD = path.join(ROOT, 'get-shit-done', 'workflows', 'audit.md');

const engine = require(ENGINE);
const PORT = parseInt(process.env.AMAUTA_PORT || '18799', 10);

// ── tmp scratch (never the real store / source / config) ────────────────────
function mkFixture(prefix, name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return { dir, p };
}

// Run the gsd-tools CLI. `hermeticEnv` points AMAUTA_PORT/GSD_RLM_PORT at a
// closed port so the always-run spawns never touch the live daemon/index.
function runTool(argv, hermetic) {
  const env = hermetic
    ? { ...process.env, AMAUTA_PORT: '1', GSD_RLM_PORT: '1' }
    : { ...process.env, GSD_RLM_PORT: '1' }; // live daemon, closed reindex
  return spawnSync(process.execPath, [TOOLS, ...argv], { encoding: 'utf-8', env });
}

// Parse the JSON objects a verb prints (one per line), skipping PLAN.md XML.
function jsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function daemonReachable() {
  const r = await httpJson('GET', '/health');
  return r.status === 200 && r.json && r.json.status === 'ok';
}

// dedup_key = rule_id + ':' + sha1(file_path) — SERVER-SIDE formula (SUBS-05,
// daemon computes it verbatim; mirrored here to build the finding:<key> tag).
function dedupKey(ruleId, filePath) {
  return `${ruleId}:${crypto.createHash('sha1').update(filePath).digest('hex')}`;
}

// ===========================================================================
// LOOP-01 — detect-soundness for all 9 domains (ALWAYS-RUN, pure, no daemon)
// Each domain's headline detect fires on a genuine seeded/real violation and
// NOT on a clean control. Detect expressions are the exact Phase-81/82 rules,
// lifted verbatim into the engine's DETECT_REGISTRY.
// ===========================================================================

// Per-file / fileset domains: { seed fires headline, control clean }.
const PER_FILE_CASES = [
  {
    domain: 'frontend', rule: 'FRONT-01', file: 'Card.jsx',
    seed: 'export const A = () => <div onClick={() => {}}>hi</div>;',
    control: 'export const B = () => <button onClick={() => {}}>hi</button>;',
  },
  {
    domain: 'api-connections', rule: 'APIC-01', file: 'client.js',
    seed: 'fetch("https://api.example.com/data");',
    control: 'fetch("https://api.example.com/data", { signal: AbortSignal.timeout(5000) });',
  },
  {
    domain: 'mobile', rule: 'MOBL-A4', file: 'strings.xml',
    seed: '<resources><string name="api_key">AKIAIOSFODNN7EXAMPLE1</string></resources>',
    control: '<resources><string name="app_name">MyApp</string></resources>',
  },
  {
    domain: 'general', rule: 'GEN-08', file: 'thing.js',
    seed: 'function x() { debugger; return 1; }',
    control: 'function x() { return 1; }\nmodule.exports = require("./x-self");',
  },
  {
    domain: 'backend', rule: 'BACK-06', file: 'repo.js',
    seed: 'for (const id of ids) {\n  db.query("SELECT 1");\n}',
    control: 'db.query("SELECT 1");',
  },
  {
    domain: 'infra', rule: 'INFRA-01', file: 'compose.yml',
    seed: 'services:\n  db:\n    image: postgres:latest\n',
    control: 'services:\n  db:\n    image: postgres@sha256:abcdef0123456789\n    healthcheck:\n      test: ["CMD", "true"]\n',
  },
  {
    domain: 'models', rule: 'MODL-01', file: 'router.py',
    seed: 'MODEL = "claude-opus-4-1"\n',
    control: 'MODEL = "opus"  # tier name, not an inline id\n',
  },
  {
    domain: 'harness-self', rule: 'HARN-02', file: 'ledger.json',
    seed: JSON.stringify({ tasks: [{ id: 'T1', claim: { agent: 'a' }, validation: { agent: 'a' } }] }),
    control: JSON.stringify({ tasks: [{ id: 'T1', claim: { agent: 'a' }, validation: { agent: 'b' } }] }),
  },
];

for (const c of PER_FILE_CASES) {
  test(`LOOP-01 / SC1: ${c.domain} ${c.rule} detect FIRES on a seeded violation and NOT on a clean control`, (t) => {
    const seed = mkFixture(`loop83-${c.domain}-`, c.file, c.seed);
    const ctrlName = c.file.replace(/(\.[^.]+)$/, '.ctrl$1');
    const ctrl = mkFixture(`loop83-${c.domain}c-`, ctrlName, c.control);
    t.after(() => {
      try { fs.rmSync(seed.dir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(ctrl.dir, { recursive: true, force: true }); } catch (_) {}
    });

    const hit = engine.detect(c.domain, [seed.p]);
    const clean = engine.detect(c.domain, [ctrl.p]);
    assert.ok(
      hit.some((f) => f.rule_id === c.rule),
      `${c.rule} must fire on the seeded ${c.domain} violation; got ${JSON.stringify(hit.map((f) => f.rule_id))}`
    );
    assert.equal(
      clean.some((f) => f.rule_id === c.rule), false,
      `${c.rule} must NOT fire on the clean ${c.domain} control (no false positive)`
    );
    // Every finding rides the audit substrate shape (finding_type='audit').
    for (const f of hit) {
      assert.equal(f.finding_type, 'audit', `${c.domain} finding is an audit finding`);
      assert.equal(f.domain, c.domain, 'domain stamped on the finding');
    }
  });
}

// mobile — the second headline rule (cross-file fileset): a dangling
// <uses-permission> with no code usage fires; a permission with a code usage does not.
test('LOOP-01 / SC1: mobile MOBL-A1 (fileset) FIRES on a dangling <uses-permission> and NOT on a used one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop83-mobA1-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const manifest = path.join(dir, 'AndroidManifest.xml');
  fs.writeFileSync(manifest,
    '<manifest>\n  <uses-permission android:name="android.permission.CAMERA" />\n</manifest>');
  // (a) dangling — no code file references CAMERA.
  const dangling = engine.detect('mobile', [manifest]);
  assert.ok(dangling.some((f) => f.rule_id === 'MOBL-A1'), 'MOBL-A1 fires on the dangling CAMERA permission');
  // (b) used — a code file names CAMERA -> not dangling.
  const usage = path.join(dir, 'Cam.kt');
  fs.writeFileSync(usage, 'val p = "CAMERA"\n');
  const used = engine.detect('mobile', [manifest, usage]);
  assert.equal(used.some((f) => f.rule_id === 'MOBL-A1'), false, 'MOBL-A1 does NOT fire when the permission is used in code');
});

// agentic-flow — REAL repo detects (read-only over the actual tree). AGEN-04
// keys on the ceiling ABSENCE (an empty budget/token/cost-ceiling grep across
// services/ + get-shit-done/bin/), NOT on a false "telemetry measures cost"
// premise; AGEN-06 on the eval-coverage gap (tests/evals/*.json vs the roster).
test('LOOP-01 / SC1+SC2: agentic-flow AGEN-04 (ceiling absence) + AGEN-06 (evals coverage gap) FIRE on the real tree (read-only)', () => {
  const findings = engine.detect('agentic-flow', []); // repo-scope: inspects the tree, not a file list
  const agen04 = findings.find((f) => f.rule_id === 'AGEN-04');
  const agen06 = findings.find((f) => f.rule_id === 'AGEN-06');
  assert.ok(agen04, 'AGEN-04 fires on the real ceiling absence');
  assert.match(agen04.evidence, /ceiling absence|ceiling/i, 'AGEN-04 evidence keys on the ceiling ABSENCE (not a measures-cost premise)');
  assert.ok(agen06, 'AGEN-06 fires on the real eval-coverage gap');
  assert.match(agen06.evidence, /eval coverage|coverage gap|eval set/i, 'AGEN-06 evidence names the evals coverage gap');
});

// ===========================================================================
// LOOP-01 — the `gsd-tools audit` verb (ALWAYS-RUN, daemon-optional --dry-run)
// ===========================================================================

test('LOOP-01: `gsd-tools audit <domain> --scope <seed> --dry-run` reports the headline rule JSON with NO daemon', (t) => {
  const seed = mkFixture('loop83-verb-', 'api.js', 'fetch("https://x/data");');
  t.after(() => { try { fs.rmSync(seed.dir, { recursive: true, force: true }); } catch (_) {} });

  const res = runTool(['audit', 'api-connections', '--scope', seed.p, '--dry-run'], true);
  assert.equal(res.status, 0, `audit --dry-run exits 0 (stderr: ${res.stderr})`);
  const obj = jsonLines(res.stdout).find((o) => o.dry_run === true);
  assert.ok(obj, 'the verb prints a dry-run JSON object');
  assert.ok(Array.isArray(obj.findings), 'dry-run reports a findings array');
  assert.ok(obj.findings.some((f) => f.rule_id === 'APIC-01'), 'dry-run reports the APIC-01 headline finding');
});

// ===========================================================================
// LOOP-02 — the on-phase-close trigger: ADVISORY, config-gated, NON-BLOCKING
// (source-analysis — the hyphenated daemon starts servers at import, so the
//  hook is analyzed as text; the wiring is asserted structurally).
// ===========================================================================

test('LOOP-02: the on_phase_close audit hook sits BEFORE cmdPhaseComplete, is try/catch-guarded, config-gated, engine-delegating', () => {
  const src = fs.readFileSync(TOOLS, 'utf-8');
  const iTelemetry = src.indexOf("_telemetryEmit('phase_complete'");
  const iHook = src.indexOf('on_phase_close');
  const iComplete = src.indexOf('cmdPhaseComplete(cwd');
  assert.ok(iTelemetry > -1, 'the phase_complete telemetry emit is present');
  assert.ok(iHook > -1, 'the audit.on_phase_close hook is present');
  assert.ok(iComplete > -1, 'the cmdPhaseComplete call is present');
  // Ordering: telemetry -> hook -> cmdPhaseComplete (the hook must run BEFORE
  // the process.exit()ing completion so it can never gate the phase).
  assert.ok(iTelemetry < iHook && iHook < iComplete,
    'the on_phase_close hook must sit AFTER the telemetry emit and BEFORE cmdPhaseComplete');

  // The audit hook window (telemetry emit -> cmdPhaseComplete) is try/catch-
  // guarded, reads the flag with a default, and delegates to the engine.
  const win = src.slice(iTelemetry, iComplete);
  assert.match(win, /try\s*\{/, 'the hook window is try-guarded');
  assert.match(win, /catch\s*\(/, 'the hook window has a catch (swallows every error — advisory)');
  assert.match(win, /on_phase_close\s*===\s*false/, 'the flag is read with a default-ON (only an explicit false disables)');
  assert.match(win, /runAudit/, 'the hook delegates to the engine runAudit');
});

test('LOOP-02: the audit path NEVER blocks the phase — no error(/process.exit( in the telemetry->cmdPhaseComplete window', () => {
  const src = fs.readFileSync(TOOLS, 'utf-8');
  const iTelemetry = src.indexOf("_telemetryEmit('phase_complete'");
  const iComplete = src.indexOf('cmdPhaseComplete(cwd');
  const win = src.slice(iTelemetry, iComplete);
  // A raw-text scan (grepping source, incl. comments): the advisory hook must
  // not call error( or process.exit( — a phase is never gated by the audit.
  assert.equal(/\berror\(/.test(win), false, 'the on-phase-close audit path never calls error( (never blocks a phase)');
  assert.equal(/process\.exit\(/.test(win), false, 'the on-phase-close audit path never calls process.exit( (never blocks a phase)');
});

// ===========================================================================
// LOOP-03 — audit-close-loop real re-audit fallback (source-analysis)
// The Phase-79 --reaudit-file seam still works; with a resolvable --file-path
// the close-loop falls back to the engine's narrow reauditFile (auditors now
// exist), no longer hard-erroring "auditors not yet available".
// ===========================================================================

test('LOOP-03: audit-close-loop falls back to the engine reauditFile when --reaudit-file is absent', () => {
  const src = fs.readFileSync(TOOLS, 'utf-8');
  const iCloseLoop = src.indexOf("case 'audit-close-loop'");
  const iNext = src.indexOf("case 'reindex'");
  assert.ok(iCloseLoop > -1 && iNext > iCloseLoop, 'the audit-close-loop segment is locatable');
  const seg = src.slice(iCloseLoop, iNext);
  assert.match(seg, /reauditFile/, 'audit-close-loop calls the engine reauditFile fallback');
  assert.match(seg, /require\(['"]\.\/lib\/audit-runner\.cjs['"]\)/, 'the fallback requires the audit-runner engine');
  assert.match(seg, /--reaudit-file/, 'the --reaudit-file seam is still supported (backward-compatible)');
});

// ===========================================================================
// Operator surface — the /amauta:audit command drives the verb, read-only.
// ===========================================================================

test('LOOP-01: commands/amauta/audit.md exists, is read-only (no Write/Edit), and @-refs the audit workflow', () => {
  assert.ok(fs.existsSync(CMD_MD), 'commands/amauta/audit.md exists');
  assert.ok(fs.existsSync(WORKFLOW_MD), 'get-shit-done/workflows/audit.md exists');
  const cmd = fs.readFileSync(CMD_MD, 'utf-8');
  assert.match(cmd, /name:\s*amauta:audit/, 'command frontmatter names amauta:audit');
  const fm = cmd.split('---')[1] || '';
  assert.equal(/^\s*-?\s*Write\s*$/m.test(fm), false, 'the audit command frontmatter must not grant Write (read-only)');
  assert.equal(/^\s*-?\s*Edit\s*$/m.test(fm), false, 'the audit command frontmatter must not grant Edit (read-only)');
  assert.match(cmd, /workflows\/audit\.md/, 'the command @-refs the audit workflow');

  const wf = fs.readFileSync(WORKFLOW_MD, 'utf-8');
  assert.match(wf, /gsd-tools.*audit|audit verb|gsd-tools audit/, 'the workflow drives the gsd-tools audit verb');
  assert.match(wf, /finding|substrate|\/api\/findings|sweep/i, 'the workflow reports the findings/substrate sweep');
});

// ===========================================================================
// LIVE-DAEMON — LOOP-03 CAPSTONE: the full loop clears a finding end-to-end.
// Skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799} is unreachable.
// ===========================================================================

test('LOOP-03 CAPSTONE (LIVE): full loop clears a finding — engine files it -> findings-to-plan gated ticket -> fix + validate -> audit-close-loop CLEARS', async (t) => {
  if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop83-cap-'));
  // A unique fixture path keeps the server dedup_key distinct (fresh insert).
  const fixture = path.join(dir, `api-${Date.now()}.js`);
  const postedIds = [];
  t.after(async () => {
    for (const id of postedIds) { try { await httpJson('PATCH', `/api/findings/${id}`, { status: 'cleared' }); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  // (1) Seed a clearable APIC-01 violation (a fetch with no timeout).
  fs.writeFileSync(fixture, 'fetch("https://api.example.com/data");');

  // (2) The ENGINE files a REAL finding to the live substrate (POST /api/findings).
  const run = await engine.runAudit('api-connections', { files: [fixture], post: true, port: PORT });
  assert.ok(run.findings.some((f) => f.rule_id === 'APIC-01'), 'engine detects the APIC-01 violation');
  assert.ok(run.posted >= 1, `engine POSTs the finding to the live substrate (posted=${run.posted})`);

  // Capture the finding's real UUID from the SUBS-04 open-audit sweep.
  const sweep = await httpJson('GET', '/api/findings?status=open&type=audit');
  assert.equal(sweep.status, 200, 'the SUBS-04 sweep returns 200');
  const mine = (sweep.json.findings || []).find((f) => f.file_path === fixture && f.rule_id === 'APIC-01');
  assert.ok(mine, 'the posted APIC-01 finding is present in the open-audit sweep');
  postedIds.push(mine.id);
  const key = dedupKey('APIC-01', fixture);

  // (3) findings-to-plan turns the finding into a FIDEL-gated fix-task tagged
  //     finding:<dedup_key> (the only path with the manifest gates + tag stamp).
  const findingsFile = path.join(dir, 'findings.json');
  fs.writeFileSync(findingsFile, JSON.stringify([{
    severity: 'error', domain: 'api-connections', finding_type: 'audit',
    file_path: fixture, dedup_key: key, id: mine.id, suggested_fix: 'add an AbortSignal timeout',
  }]));
  const emptyTasks = path.join(dir, 'empty-tasks.json');
  fs.writeFileSync(emptyTasks, JSON.stringify({ items: [] }));
  const f2p = runTool(['findings-to-plan', '--findings-file', findingsFile, '--tasks-file', emptyTasks], true);
  assert.equal(f2p.status, 0, `findings-to-plan exits 0 (stderr: ${f2p.stderr})`);
  assert.ok(f2p.stdout.includes(`finding:${key}`), 'the synthesized PLAN.md stamps the finding:<dedup_key> tag (FIDEL-gated fix-task)');
  assert.ok(f2p.stdout.includes(fixture), 'the synthesized PLAN.md carries the concrete finding file path');

  // (4) The fixture is FIXED (the violation removed) and its fix-task validated.
  //     The validated fix-task carries the finding:<dedup_key> tag (registered
  //     through plan-to-tasks; represented here as the resolved task-store row
  //     the close-loop resolves — the Phase-79 --tasks-file idiom).
  fs.writeFileSync(fixture, 'fetch("https://api.example.com/data", { signal: AbortSignal.timeout(5000) });');
  const tasksFile = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({
    items: [{ id: 'TK-CAP-CLEAR', status: 'validated', tags: [`finding:${key}`] }],
  }));

  // (5) audit-close-loop (engine-backed narrow re-audit) re-runs APIC-01 on the
  //     fixed file -> empty -> the finding flips to status='cleared'.
  const close = runTool([
    'audit-close-loop', 'TK-CAP-CLEAR',
    '--tasks-file', tasksFile, '--finding-id', mine.id,
    '--file-path', fixture, '--rule-id', 'APIC-01',
  ]);
  assert.equal(close.status, 0, `audit-close-loop clears cleanly (exit 0); stderr: ${close.stderr}`);
  const clearOut = jsonLines(close.stdout).find((o) => 'cleared' in o);
  assert.ok(clearOut, 'audit-close-loop prints a cleared object');
  assert.equal(clearOut.cleared, true, 'the loop CLEARS the finding (defect gone after the fix)');
  assert.equal(clearOut.rule_id, 'APIC-01', 'the cleared rule is the finding rule');

  // The finding's status='cleared' in the substrate (SUBS-04 cleared sweep).
  const clearedSweep = await httpJson('GET', '/api/findings?status=cleared&type=audit');
  const nowCleared = (clearedSweep.json.findings || []).find((f) => f.id === mine.id);
  assert.ok(nowCleared, 'the finding surfaces in the cleared-audit sweep');
  assert.equal(nowCleared.status, 'cleared', "the finding's status is now 'cleared' — the loop CLOSED end-to-end");

  // And it is GONE from the open-audit sweep.
  const openSweep = await httpJson('GET', '/api/findings?status=open&type=audit');
  assert.equal((openSweep.json.findings || []).some((f) => f.id === mine.id), false,
    'the cleared finding no longer appears in the open-audit sweep');
});

test('LOOP-03 CAPSTONE (LIVE): no-op-fix CONTROL reopens the finding + emits a validator/finding DIVERGENCE', async (t) => {
  if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop83-ctrl-'));
  const fixture = path.join(dir, `api-${Date.now()}-ctrl.js`);
  const postedIds = [];
  t.after(async () => {
    for (const id of postedIds) { try { await httpJson('PATCH', `/api/findings/${id}`, { status: 'cleared' }); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  // Seed the SAME violation but the "fix" leaves it in place (no-op fix).
  fs.writeFileSync(fixture, 'fetch("https://api.example.com/data");');
  const run = await engine.runAudit('api-connections', { files: [fixture], post: true, port: PORT });
  assert.ok(run.posted >= 1, 'the control finding is filed to the live substrate');
  const sweep = await httpJson('GET', '/api/findings?status=open&type=audit');
  const mine = (sweep.json.findings || []).find((f) => f.file_path === fixture && f.rule_id === 'APIC-01');
  assert.ok(mine, 'the control finding is present in the open-audit sweep');
  postedIds.push(mine.id);
  const key = dedupKey('APIC-01', fixture);

  // The task validated GREEN, but the fixture STILL carries the violation.
  const tasksFile = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({
    items: [{ id: 'TK-CAP-CTRL', status: 'validated', tags: [`finding:${key}`] }],
  }));

  // audit-close-loop re-audits -> the defect PERSISTS -> reopen + divergence.
  const close = runTool([
    'audit-close-loop', 'TK-CAP-CTRL',
    '--tasks-file', tasksFile, '--finding-id', mine.id,
    '--file-path', fixture, '--rule-id', 'APIC-01',
  ]);
  // A green validator + a persistent defect is a NON-ZERO condition (surface, never absorb).
  assert.equal(close.status, 1, 'a green validator + a persistent defect is a NON-ZERO exit (surfaced, not absorbed)');
  const out = jsonLines(close.stdout).find((o) => o.reopened);
  assert.ok(out, 'audit-close-loop prints a reopened object');
  assert.equal(out.reopened, true, 'the finding is REOPENED (defect persists)');
  assert.equal(out.divergence, true, 'a validator/finding divergence is emitted');
  assert.match(out.content, /validator\/finding divergence/, 'the divergence message names the validator/finding mismatch');

  // The finding is back to status='open' in the substrate.
  const reopened = await httpJson('GET', '/api/findings?status=open&type=audit');
  const still = (reopened.json.findings || []).find((f) => f.id === mine.id);
  assert.ok(still && still.status === 'open', "the reopened finding is 'open' again in the substrate");
});
