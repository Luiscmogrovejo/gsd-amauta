'use strict';
/**
 * tests/memory-truth.test.cjs
 *
 *   (a) A daemon 500 on search must be visible and non-zero — never a silent
 *       slide into .planning file mode at exit 0 (the TK-2386 failure mode).
 *       Opting in with GSD_MEMORY_FILE_MODE=1 is the only way to get file mode.
 *   (b) The distill Anthropic fallback must not put ANTHROPIC_API_KEY on a
 *       command line, where `ps` and process accounting can read it.
 *
 * The daemon is a local stub on an ephemeral port; `claude` and `curl` are
 * fakes on a temp PATH. Nothing here reaches a real daemon or the network.
 *
 * Run: node --test tests/memory-truth.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const ROOT = path.resolve(__dirname, '..');
const MEMORY = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-memory.cjs');

function withStub(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const [status, payload] = handler(req, body);
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const out = await fn(srv.address().port);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not exit within 30s'));
    }, 30000);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
  });
}

// ─── (a) search must not hide a daemon error ────────────────────────────────

test('memory search: a daemon 500 refuses with a non-zero exit', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mem-'));
  const res = await withStub(
    () => [500, { error: 'route handler blew up' }],
    (port) => run(process.execPath, [MEMORY, 'search', 'anything', '--tags', 'a,b'], {
      cwd,
      env: { ...process.env, GSD_AMAUTA_PORT: String(port), GSD_MEMORY_FILE_MODE: '' },
    }));

  assert.notStrictEqual(res.status, 0,
    'a server error answered from file mode at exit 0 is the bug');
  assert.strictEqual(res.status, 3, 'exit 3 = refused (PG-backed memory unreachable)');
  assert.match(res.stderr, /REFUSING/);
  assert.match(res.stderr, /daemon error \(500\)|HTTP 500/);
});

test('memory search: GSD_MEMORY_FILE_MODE=1 is the explicit opt-in to file mode', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mem-'));
  const res = await withStub(
    () => [500, { error: 'route handler blew up' }],
    (port) => run(process.execPath, [MEMORY, 'search', 'anything', '--json'], {
      cwd,
      env: { ...process.env, GSD_AMAUTA_PORT: String(port), GSD_MEMORY_FILE_MODE: '1' },
    }));

  assert.strictEqual(res.status, 0, 'an explicit opt-in may degrade');
  assert.match(res.stderr, /file mode/);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.mode, 'file', 'the degraded answer must label itself');
});

// ─── (b) the API key must never reach argv ──────────────────────────────────

test('distill fallback: the Anthropic API key never appears on a command line', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mem-bin-'));
  const argvLog = path.join(binDir, 'curl-argv.txt');

  // `claude` fails so the HTTP fallback is exercised.
  // Node bodies: one program behind a shebang (POSIX) or a .cmd shim (Windows). On Windows the
  // product spawns the bare names `claude` and `curl`, which a .cmd cannot shadow: this test is
  // handed to plan 88-15 (platform-aware resolution), not skipped.
  writeFakeExe(binDir, 'claude', { node: 'process.exit(1);' });

  // `curl` records its argv + the mode of any --config file, then answers.
  // Written as a node script, not sh: the old `stat -f '%Lp' || stat -c '%a'` probe is BSD-first, and on GNU
  // stat (ubuntu CI) `-f` means "filesystem status" and exits 0 printing a multi-line report, so the `||`
  // fallback never ran and the log held `CFGMODE:   File: "<tmpdir>/..."` instead of the mode (88-CI-BASELINE,
  // ubuntu/20 + ubuntu/22). The code under test was right; the probe was not portable. fs.statSync is.
  // Phase 88 plan 88-15: the fake is ALSO written as a plain .cjs the test runs
  // through node via GSD_CURL, because a bare `curl` spawn is resolved by the
  // OS loader and the System32 copy always wins on Windows -- a .cmd shim can
  // never shadow it, and current Node refuses to spawn a .cmd without a shell.
  const curlJs = path.join(binDir, 'fake-curl.cjs');
  const curlBody = [
    "const fs = require('fs');",
    `const log = ${JSON.stringify(argvLog)};`,
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(log, 'ARGV: ' + args.join(' ') + '\\n');",
    "const i = args.indexOf('--config');",
    'if (i >= 0) {',
    '  const cfg = args[i + 1];',
    "  fs.appendFileSync(log, 'CFGMODE: ' + (fs.statSync(cfg).mode & 0o777).toString(8) + '\\n');",
    "  const hits = fs.readFileSync(cfg, 'utf8').split('\\n').filter(l => l.includes('x-api-key')).length;",
    "  fs.appendFileSync(log, 'CFGHASKEY: ' + hits + '\\n');",
    // Recorded HERE, while the directory still exists: the product removes its
    // temp dir in a finally, so the test cannot stat it afterwards.
    "  const os2 = require('os'), path2 = require('path');",
    "  const under = fs.realpathSync(path2.dirname(cfg)).toLowerCase()",
    "    .startsWith(fs.realpathSync(os2.tmpdir()).toLowerCase());",
    "  fs.appendFileSync(log, 'CFGUNDERTMP: ' + (under ? 1 : 0) + '\\n');",
    '}',
    'process.stdout.write(\'{"content":[{"text":"A distilled summary long enough to pass the twenty character floor."}]}\');',
    '',
  ].join('\n');
  fs.writeFileSync(curlJs, curlBody, 'utf8');
  writeFakeExe(binDir, 'curl', { node: curlBody });

  const SENTINEL = 'sk-ant-TESTSENTINEL-0123456789';
  const driver = path.join(binDir, 'driver.cjs');
  fs.writeFileSync(driver, [
    `const m = require(${JSON.stringify(MEMORY)});`,
    'const out = m._test_claudeSummarize(',
    '  [{ source: "agent", text: "first memory" }, { source: "agent", text: "second memory" }],',
    '  "sonnet");',
    'process.stdout.write(JSON.stringify({ out }));',
    '',
  ].join('\n'));

  const res = await run(process.execPath, [driver], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: prependPath([binDir]),
      // The interpreter plus the script, as a JSON array: no shell, nothing
      // interpreted, and the same on POSIX and Windows.
      GSD_CURL: JSON.stringify([process.execPath, curlJs]),
      ANTHROPIC_API_KEY: SENTINEL,
    },
  });

  assert.strictEqual(res.status, 0, `driver failed: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.out || '', /distilled summary/, 'the fallback must still work');

  const log = fs.readFileSync(argvLog, 'utf-8');
  assert.ok(log.includes('ARGV:'), 'the fake curl must have been invoked');
  assert.ok(!log.includes(SENTINEL),
    `the API key must not appear in curl's argv:\n${log}`);
  assert.match(log, /--config/, 'the key must travel in a curl config file');
  assert.match(log, /CFGHASKEY: 1/, 'the config file carries the header');
  // Phase 88 plan 88-15: `mode: 0o600` is a POSIX permission bit. NTFS has no
  // such thing -- Node reports 666 for any non-read-only file on Windows and
  // `chmodSync` cannot express an ACL -- so the mode assertion is POSIX-only.
  // What protects the key on Windows is that the file is created by
  // fs.mkdtempSync under os.tmpdir(), which there is the PER-USER
  // %LOCALAPPDATA%\Temp, ACL-restricted to that user. Both halves are
  // asserted; neither platform is left unchecked. The gap (no explicit ACL on
  // Windows) is recorded in 88-15-RECORD.md for the operator.
  assert.match(log, /CFGUNDERTMP: 1/,
    `the config file must live under the per-user temp dir:\n${log}`);
  if (process.platform !== 'win32') {
    assert.match(log, /CFGMODE: 600\b/, 'the config file must be 0o600 (mode & 0o777 read with fs.statSync)');
  }
});

test('distill fallback: no shell interpolation of the key in the source', () => {
  const src = fs.readFileSync(MEMORY, 'utf-8');
  assert.ok(!/-H ["']x-api-key: \$\{apiKey\}/.test(src),
    'the key must not be interpolated into a command string');
  // Phase 88 plan 88-15: the bare `curl` name is resolved through the platform
  // helper (GSD_CURL, then `where`/`which`), because a bare-name execFile spawn
  // is resolved by the OS loader and the System32 copy always wins on Windows.
  // The contract is unchanged and stronger: a config FILE, never the argv.
  assert.ok(src.includes("platform.resolveTool('GSD_CURL', 'curl')"),
    'the fallback must resolve curl through the platform helper');
  assert.ok(/execFileSync\(curlTool\.command, \[\.\.\.curlTool\.args, '--config', cfgPath\]/.test(src),
    'the fallback must invoke curl with a config file');
  assert.ok(!/execFileSync\(\s*'curl'/.test(src),
    'no bare-name curl spawn may survive');
});
