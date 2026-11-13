'use strict';
/**
 * tests/audit-reindex-a2a-truth.test.cjs
 *
 * "Reported success while failing" defects in get-shit-done/bin:
 *
 *   audit    — a 500 from the findings endpoint was parsed into
 *              `open_findings: []` and exited 0, so a failed audit read as
 *              "N detected, 0 posted, 0 open" with success.
 *   reindex  — the HTTP status was never checked (a 503 exited 0) and the
 *              path was sent verbatim, defaulting to '.', which the service
 *              resolved against its OWN cwd.
 *
 * THIS FILE IS EDITED, NOT DELETED (plan 89-05, ORC-02). It covered a third
 * defect class, `a2a tail` — a 5xx was indistinguishable from "no exchanges", so
 * the loop polled forever. That verb is removed with the rest of the A2A
 * surface, so its two tests go with it. The seven audit and reindex tests are
 * about `audit` and `reindex` truth and have nothing to do with A2A; the
 * assertion that decided it is
 *
 *     assert.notStrictEqual(sentPath, '.',
 *       'a relative path resolves against the SERVICE cwd');
 *
 * which pins a reindex defect. The file keeps its name so the history of all
 * three stays findable from one place; what it proves is named above.
 *
 * Every HTTP endpoint here is a local stub on an ephemeral port; nothing
 * contacts a real daemon or RLM service.
 *
 * Run: node --test tests/audit-reindex-a2a-truth.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run the stub server in-process while the CLI runs as an ASYNC child: the
 * event loop must stay free, or the stub cannot answer the child's requests.
 * `handler(req, body)` returns [status, payload].
 */
function withStub(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let out;
        try {
          out = handler(req, body);
        } catch (e) {
          out = [500, { error: e.message }];
        }
        const [status, payload] = out;
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try {
        const result = await fn(port);
        srv.close(() => resolve(result));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-truth-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** A compose file that trips INFRA-01 (unpinned image) — guarantees >=1 finding. */
function unpinnedCompose() {
  return tmpFile('docker-compose.yml',
    'services:\n  db:\n    image: postgres:latest\n    ports:\n      - "5432:5432"\n');
}

/** Async spawn so the in-process stub server can answer while the CLI runs. */
function runTools(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOLS, ...args], {
      cwd: ROOT, env: { ...process.env, ...(env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gsd-tools ${args.join(' ')} did not exit within 30s (infinite loop?)`));
    }, 30000);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

// ─── audit ───────────────────────────────────────────────────────────────────

test('audit: a 500 from the findings endpoint fails loudly instead of "0 open"', async () => {
  const scope = unpinnedCompose();
  const res = await withStub(
    (req) => (req.method === 'POST' ? [200, { id: 'f1' }] : [500, { error: 'boom' }]),
    (port) => runTools(['audit', 'infra', '--scope', scope, '--port', String(port)]));

  const report = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.strictEqual(report.findings_endpoint.ok, false);
  assert.strictEqual(report.findings_endpoint.status, 500);
  assert.strictEqual(report.open_findings, null,
    'a failed sweep is UNKNOWN, never an empty list');
  assert.strictEqual(res.status, 1, 'the verb must exit non-zero');
  assert.match(res.stderr, /HTTP 500/);
});

test('audit: findings detected but not posted exits non-zero', async () => {
  const scope = unpinnedCompose();
  const res = await withStub(
    (req) => (req.method === 'POST' ? [500, { error: 'write failed' }] : [200, { findings: [] }]),
    (port) => runTools(['audit', 'infra', '--scope', scope, '--port', String(port)]));

  const report = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.ok(report.detected >= 1, `expected a detection, got ${report.detected}`);
  assert.strictEqual(report.posted, 0);
  assert.strictEqual(report.not_posted, report.detected);
  assert.ok(report.post_errors.length >= 1, 'each failed POST must be reported');
  assert.strictEqual(report.post_errors[0].status, 500);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /NOT posted/);
});

test('audit: all posted and a clean sweep exits 0', async () => {
  const scope = unpinnedCompose();
  const res = await withStub(
    (req) => (req.method === 'POST' ? [201, { id: 'f1' }] : [200, { findings: [] }]),
    (port) => runTools(['audit', 'infra', '--scope', scope, '--port', String(port)]));

  const report = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.strictEqual(report.not_posted, 0);
  assert.deepStrictEqual(report.open_findings, []);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('audit: an unreachable substrate is a failure, not a clean run', async () => {
  const scope = unpinnedCompose();
  const res = await runTools(['audit', 'infra', '--scope', scope, '--port', '18991']);
  const report = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.strictEqual(report.daemon, false);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /unreachable/);
});

// ─── reindex ────────────────────────────────────────────────────────────────

test('reindex: a 503 exits non-zero', async () => {
  const res = await withStub(
    () => [503, { error: 'index unavailable' }],
    (port) => runTools(['reindex', ROOT], { GSD_RLM_PORT: String(port) }));
  assert.strictEqual(res.status, 1, 'a 503 must not exit 0');
  assert.match(res.stderr, /HTTP 503/);
});

test('reindex: a 200 exits 0', async () => {
  const res = await withStub(
    () => [200, { indexed: 3 }],
    (port) => runTools(['reindex', ROOT], { GSD_RLM_PORT: String(port) }));
  assert.strictEqual(res.status, 0, res.stderr);
});

test('reindex: sends an ABSOLUTE path, never a bare "."', async () => {
  let sentPath = null;
  await withStub(
    (req, body) => {
      try { sentPath = JSON.parse(body).path; } catch (_e) { /* ignore */ }
      return [200, { indexed: 0 }];
    },
    (port) => runTools(['reindex'], { GSD_RLM_PORT: String(port) }));
  assert.ok(sentPath, 'the service must receive a path');
  assert.notStrictEqual(sentPath, '.', 'a relative path resolves against the SERVICE cwd');
  assert.ok(path.isAbsolute(sentPath), `expected an absolute path, got ${sentPath}`);
});

// ─── the removed a2a tail ───────────────────────────────────────────────────
//
// Two tests stood here, pinning that `a2a tail` stopped on a 5xx and on an
// unparseable body instead of polling forever. Plan 89-05 removed the verb, so
// they are removed with it — that is a removal, not a weakening. What replaces
// them is the one assertion that still has content: the verb must be REFUSED
// rather than silently accepted, and it must not reach a port.

test('a2a tail: the verb is refused by name and contacts nothing', async () => {
  const res = await withStub(
    () => [500, { error: 'nothing should ask' }],
    (port) => runTools(['a2a', 'tail'], { AMAUTA_PORT: String(port) }));
  assert.strictEqual(res.status, 1, 'an unknown verb must exit non-zero');
  assert.match(res.stdout + res.stderr, /Unknown command: a2a/,
    'gsd-tools must refuse the removed verb by name, not poll a daemon');
  assert.ok(!/HTTP 500/.test(res.stderr),
    'the refused verb must not have reached the stub at all');
});
