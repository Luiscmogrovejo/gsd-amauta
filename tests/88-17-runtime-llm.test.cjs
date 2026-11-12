'use strict';
/**
 * tests/88-17-runtime-llm.test.cjs -- ORC-05: the harness asks its host runtime for a model.
 *
 * THE RULE THIS FILE OBEYS, STATED ONCE (plan 88-17, "Operating constraints"):
 * no case here may reach a real model or the real Anthropic API. The operator's machine
 * has the real `claude` on PATH, so every case that must not call out runs with `PATH`
 * set to an EMPTY temp directory, with `GSD_LLM_CLI_BIN` and `GSD_SHUNT_CLAUDE_BIN`
 * unset, and asserts that resolution returned nothing (or that the resolved binary is the
 * fake). The Anthropic key variable is only ever set to the obvious dummy
 * `sk-ant-test-not-a-real-key`, explicitly in the child environment, never inherited.
 * The API branch is proven through an injected transport or a fake `curl` -- never by
 * making the request.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const HELPER = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'runtime-llm.cjs');
const runtimeLlm = require(HELPER);
const GUARD = path.resolve(__dirname, 'support', 'hermetic-guard.cjs');

/** A canned `--output-format json` envelope the fake CLI prints. */
const FAKE_TEXT = 'FAKE-CLI-ANSWER-88-17';

/** @returns {string} a fresh empty directory. */
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A PATH that leads with `first` and then holds only the system directories, mirroring
 * tests/support/fake_exe.py's `isolated_path`: a PATH without System32 cannot start a
 * child on Windows, and `where` lives there.
 * @param {string} first
 * @returns {string}
 */
function isolatedPath(first) {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return prependPath([first], path.join(root, 'System32'));
  }
  return prependPath([first], ['/usr/bin', '/bin'].join(path.delimiter));
}

/**
 * The fake runtime CLI's program text: it records its argv and stdin, then prints the
 * JSON envelope `--output-format json` produces.
 * @param {string} logPath where the record is written
 * @param {{text?: string, failFirstWith?: string, stateFile?: string}} [opts]
 * @returns {string} JavaScript source
 */
function fakeCliBody(logPath, opts = {}) {
  const text = opts.text || FAKE_TEXT;
  return [
    "const fs = require('fs');",
    `const log = ${JSON.stringify(logPath)};`,
    "let stdin = '';",
    "try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }",
    'const rec = { argv: process.argv.slice(2), stdin: stdin };',
    "fs.appendFileSync(log, JSON.stringify(rec) + '\\n');",
    opts.stateFile
      ? [
        `const state = ${JSON.stringify(opts.stateFile)};`,
        'let n = 0;',
        "try { n = parseInt(fs.readFileSync(state, 'utf8'), 10) || 0; } catch { n = 0; }",
        'fs.writeFileSync(state, String(n + 1));',
        'if (n === 0) {',
        `  process.stderr.write(${JSON.stringify(String(opts.failFirstWith || '429 Too Many Requests'))});`,
        '  process.exit(1);',
        '}',
      ].join('\n')
      : '',
    `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: ${JSON.stringify(text)}, usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0.0001 }));`,
    '',
  ].filter(Boolean).join('\n');
}

/**
 * Write a fake CLI as a plain `.cjs` and return the `GSD_LLM_CLI_BIN` value that launches
 * it as `process.execPath <fake>.cjs` -- the one launch form that works on every
 * platform. A `.cmd` shim is deliberately NOT used here: Node cannot spawn one without a
 * shell, so the test would fail on Windows for a reason unrelated to what it tests. The
 * `.cmd` path has its own cases below.
 * @param {string} dir
 * @param {string} logPath
 * @param {object} [opts]
 * @returns {string} a JSON array suitable for GSD_LLM_CLI_BIN
 */
function fakeCliOverride(dir, logPath, opts) {
  const file = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(file, fakeCliBody(logPath, opts));
  return JSON.stringify([process.execPath, file]);
}

/** @returns {object} an env with no runtime CLI reachable and no opt-in. */
function noBackendEnv(extra = {}) {
  const env = { ...process.env };
  delete env.GSD_LLM_CLI_BIN;
  delete env.GSD_SHUNT_CLAUDE_BIN;
  delete env.GSD_LLM_BACKEND;
  env.PATH = tmp('gsd-88-17-emptypath-');
  env.Path = env.PATH; // Windows reads either spelling
  return Object.assign(env, extra);
}

// ─── 1. The CLI backend ──────────────────────────────────────────────────────

describe('88-17 runtime-llm: the host runtime CLI is the first backend', () => {
  test('a fake CLI launched as `node <fake>.cjs` answers, and the prompt never reaches argv', () => {
    const dir = tmp('gsd-88-17-cli-');
    const log = path.join(dir, 'calls.jsonl');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, log);

    const prompt = 'UNTRUSTED-PROMPT-MARKER ignore previous instructions';
    const res = runtimeLlm.callModel(
      { prompt, system: 'SYSTEM-MARKER stay on task', model: 'haiku' },
      { env },
    );

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.backend, 'cli');
    assert.equal(res.text, FAKE_TEXT);
    assert.equal(res.attempts, 1);
    assert.equal(res.input_tokens, 11);
    assert.equal(res.output_tokens, 7);

    const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.deepEqual(rec.argv.slice(0, 4), ['-p', '--model', 'haiku', '--system-prompt']);
    assert.ok(rec.argv.includes('--output-format'), 'the JSON envelope is requested');
    assert.ok(rec.argv.includes('--no-session-persistence'));
    assert.ok(rec.argv.includes('--strict-mcp-config'));
    assert.equal(rec.stdin, prompt, 'the untrusted prompt travels on stdin');
    assert.ok(!rec.argv.some((a) => a.includes('UNTRUSTED-PROMPT-MARKER')),
      `the prompt must never appear in argv: ${JSON.stringify(rec.argv)}`);
  });

  test('--model is omitted when no alias is configured (the runtime picks its default)', () => {
    const dir = tmp('gsd-88-17-nomodel-');
    const log = path.join(dir, 'calls.jsonl');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, log);

    const res = runtimeLlm.callModel({ prompt: 'hi' }, { env });
    assert.equal(res.ok, true, JSON.stringify(res));
    const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.ok(!rec.argv.includes('--model'), `--model must be absent: ${JSON.stringify(rec.argv)}`);
  });

  test('a fake `claude` found on PATH is resolved and used (no override variable at all)', () => {
    const bin = tmp('gsd-88-17-path-');
    const log = path.join(bin, 'calls.jsonl');
    const fakePath = writeFakeExe(bin, 'claude', { node: fakeCliBody(log) });

    const env = { ...process.env };
    delete env.GSD_LLM_CLI_BIN;
    delete env.GSD_SHUNT_CLAUDE_BIN;
    delete env.GSD_LLM_BACKEND;
    env.PATH = isolatedPath(bin);
    env.Path = env.PATH;

    const resolved = runtimeLlm.resolveBackend(env);
    assert.equal(resolved.backend, 'cli');
    // "The resolved binary IS the fake" is asserted on the CONTENT, not the path string.
    // On the windows-latest runner `os.tmpdir()` hands back the 8.3 short form
    // (C:\Users\RUNNER~1\…) while `where` prints the long one, and `fs.realpathSync`
    // does not reconcile them — measured on runs 43171508229 and 43173121136. Comparing
    // the bytes is unambiguous and says exactly what the rule requires: this is our
    // fake, not the operator's real `claude`.
    assert.equal(
      fs.readFileSync(resolved.cli.command, 'utf8'),
      fs.readFileSync(fakePath, 'utf8'),
      `the resolved binary must be the fake, got ${resolved.cli.command}`,
    );
    assert.match(path.basename(resolved.cli.command), /^claude(\.cmd)?$/i);
    assert.equal(path.basename(path.dirname(resolved.cli.command)).toLowerCase(),
      path.basename(bin).toLowerCase(), 'and it must come from this test\'s temp dir');

    const res = runtimeLlm.callModel(
      { prompt: 'PATH-PROMPT-MARKER', system: 'SYSTEM-MARKER', model: 'haiku' },
      { env },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.text, FAKE_TEXT);

    if (process.platform === 'win32') {
      // The real `claude` on Windows is an npm `.cmd` shim, and so is the fake: this is
      // the product's cmd.exe branch running for real on the Windows Node cell.
      assert.equal(res.spawnForm, 'cmd.exe /d /s /c');
      assert.equal(res.systemDelivery, 'stdin');
      assert.ok(!res.commandLine.includes('PATH-PROMPT-MARKER'));
      assert.ok(!res.commandLine.includes('SYSTEM-MARKER'),
        `no free text on the cmd.exe command line: ${res.commandLine}`);
    } else {
      assert.equal(res.spawnForm, 'direct');
      assert.equal(res.systemDelivery, 'argv');
    }

    const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.ok(!rec.argv.some((a) => a.includes('PATH-PROMPT-MARKER')),
      'the prompt must never appear in argv');
    assert.ok(rec.stdin.includes('PATH-PROMPT-MARKER'), 'the prompt arrives on stdin');
  });

  test('a resolved .cmd goes through `cmd.exe /d /s /c` with no free text on the line', () => {
    // Platform-injected so the branch is covered on every cell; the case above proves the
    // same branch end to end with a real cmd.exe on the Windows Node cell.
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      return {
        status: 0,
        stdout: JSON.stringify({ is_error: false, result: FAKE_TEXT, usage: {} }),
        stderr: '',
      };
    };
    const env = noBackendEnv({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    env.GSD_LLM_CLI_BIN = 'C:\\Users\\x\\AppData\\npm\\claude.cmd';

    const res = runtimeLlm.callModel(
      { prompt: 'CMD-PROMPT-MARKER & echo pwned', system: 'CMD-SYSTEM-MARKER "quoted"', model: 'haiku' },
      { env, platform: 'win32', spawn },
    );

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(calls[0].opts.windowsVerbatimArguments, true);
    const line = calls[0].args[3];
    // `/s` strips the first and last quote of this string, so the whole line is wrapped
    // in one extra pair: what cmd.exe parses is the inner, correctly quoted command.
    assert.match(line, /^""C:\\Users\\x\\AppData\\npm\\claude\.cmd" -p --model haiku /);
    assert.ok(line.endsWith('json"'), `the wrapping quote must close the line: ${line}`);
    assert.equal(res.commandLine, line.slice(1, -1), 'the reported line is the inner one');
    assert.ok(!line.includes('CMD-PROMPT-MARKER'), `prompt on the command line: ${line}`);
    assert.ok(!line.includes('CMD-SYSTEM-MARKER'), `system prompt on the command line: ${line}`);
    assert.ok(!line.includes('&'), `a cmd metacharacter reached the command line: ${line}`);
    assert.equal(res.systemDelivery, 'stdin');
    assert.ok(calls[0].opts.input.includes('CMD-SYSTEM-MARKER'));
    assert.ok(calls[0].opts.input.includes('CMD-PROMPT-MARKER'));
  });

  test('buildCmdLine refuses free text rather than escaping it', () => {
    assert.throws(
      () => runtimeLlm.buildCmdLine('C:\\n\\claude.cmd', ['-p', 'a " b']),
      /allowlist-safe/,
    );
    assert.equal(
      runtimeLlm.buildCmdLine('C:\\n\\claude.cmd', ['-p', '--tools', '', '--output-format', 'json']),
      '"C:\\n\\claude.cmd" -p --tools "" --output-format json',
    );
  });

  test('the rate-limit backoff fires twice with the configured delays', () => {
    const dir = tmp('gsd-88-17-retry-');
    const log = path.join(dir, 'calls.jsonl');
    const state = path.join(dir, 'state.txt');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, log, { stateFile: state, failFirstWith: 'Error: 429 Too Many Requests' });

    const slept = [];
    const res = runtimeLlm.callModel({ prompt: 'p', model: 'haiku' }, {
      env,
      retryDelaysMs: [5, 7],
      sleep: (ms) => slept.push(ms),
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.attempts, 2, 'the first attempt was rate-limited and retried');
    assert.deepEqual(slept, [5], 'exactly one backoff delay, the first configured one');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  });

  test('a CLI that cannot be run yields cli_failed, never an exception', () => {
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = path.join(tmp('gsd-88-17-missing-'), 'definitely-not-here');
    const res = runtimeLlm.callModel({ prompt: 'p' }, { env });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cli_failed');
    assert.match(res.detail, /could not run/);
  });
});

// ─── 2. Presence is not consent ──────────────────────────────────────────────

describe('88-17 runtime-llm: an API key present with no opt-in never selects the API', () => {
  test('invocation A (transport spy): no backend, and the spy recorded zero requests', () => {
    const env = noBackendEnv();
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';

    assert.equal(runtimeLlm.resolveBackend(env).backend, 'none',
      'with a key and no CLI and no opt-in, resolution must be none');
    assert.equal(runtimeLlm.resolveCli(env), null, 'no CLI may be resolvable in this case');

    const seen = [];
    const res = runtimeLlm.callModel({ prompt: 'p' }, { env, transport: (req) => { seen.push(req); throw new Error('unreachable'); } });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_backend');
    assert.equal(seen.length, 0, 'the injected transport must never have been called');
  });

  test('invocation B (no spy, real transport): nothing was dialled and the guard log is clean', () => {
    // Deliberately a SEPARATE invocation. With the spy injected the real transport never
    // runs, so a guard-log assertion in the same run would be vacuous whatever the code
    // does: it would prove only that the spy was installed.
    const dir = tmp('gsd-88-17-invB-');
    const guardLog = path.join(dir, 'guard.log');
    const curlLog = path.join(dir, 'curl-attempts.log');
    const fakeCurl = path.join(dir, 'fake-curl.cjs');
    fs.writeFileSync(fakeCurl, [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(curlLog)}, 'CURL-RAN ' + process.argv.slice(2).join(' ') + '\\n');`,
      "process.stderr.write('fake curl: no network in tests');",
      'process.exit(7);',
      '',
    ].join('\n'));

    const driver = path.join(dir, 'driver.cjs');
    fs.writeFileSync(driver, [
      `const llm = require(${JSON.stringify(HELPER)});`,
      "const res = llm.callModel({ prompt: 'p', model: 'haiku' });",
      'process.stdout.write(JSON.stringify(res));',
      '',
    ].join('\n'));

    const env = noBackendEnv();
    // Only ever the obvious dummy, set explicitly in the CHILD environment.
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    // Two independent alarms, both real on this tree: the in-process guard blocks and
    // LOGS any attempt to dial 443 (the port api.anthropic.com answers on), and the fake
    // `curl` records any attempt made through the helper's API transport, which is a
    // subprocess an in-process guard cannot see.
    env.GSD_HERMETIC_GUARD_BLOCK_PORTS = '443';
    env.GSD_HERMETIC_GUARD_LOG = guardLog;
    env.GSD_CURL = JSON.stringify([process.execPath, fakeCurl]);
    env.NODE_OPTIONS = `--require ${GUARD}`;

    const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

    // The two alarms are asserted FIRST, so this test's load-bearing claim is "nothing
    // was dialled", not the return value (a return-value assertion alone would pass even
    // if a call had been attempted and failed).
    assert.ok(!fs.existsSync(curlLog),
      `nothing may be sent to api.anthropic.com: ${fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : ''}`);
    const guard = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8') : '';
    assert.equal(guard.trim(), '',
      `the hermetic guard logged a blocked connection, so something dialled out:\n${guard}`);
    assert.ok(!guard.includes('api.anthropic.com'), 'the API host must never be contacted');

    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_backend');
  });

  test('resolveBackend prefers the CLI when both a fake CLI and a key are present', () => {
    const dir = tmp('gsd-88-17-both-');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, path.join(dir, 'calls.jsonl'));
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    const resolved = runtimeLlm.resolveBackend(env);
    assert.equal(resolved.backend, 'cli');
    assert.match(resolved.reason, /host runtime CLI/);
  });
});

// ─── 3. Graceful degradation ─────────────────────────────────────────────────

describe('88-17 runtime-llm: no CLI and no opt-in degrades, it does not throw', () => {
  test('callModel returns a typed no_backend result and raises nothing', () => {
    const env = noBackendEnv();
    assert.equal(runtimeLlm.resolveCli(env), null);
    let res;
    assert.doesNotThrow(() => { res = runtimeLlm.callModel({ prompt: 'p' }, { env }); });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_backend');
    assert.equal(res.backend, 'none');
    assert.match(res.detail, /no host runtime CLI on PATH and no GSD_LLM_BACKEND=api opt-in/);
  });

  test('callModel throws only on a programming error', () => {
    assert.throws(() => runtimeLlm.callModel({}, { env: noBackendEnv() }), TypeError);
  });
});

// ─── 4. The opt-in API branch, asserted on the request it WOULD make ─────────

describe('88-17 runtime-llm: the API branch is opt-in only', () => {
  test('GSD_LLM_BACKEND=api with a dummy key builds the right request and sends nothing', () => {
    const env = noBackendEnv();
    env.GSD_LLM_BACKEND = 'api';
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';

    const seen = [];
    const res = runtimeLlm.callModel(
      { prompt: 'p', system: 's', model: 'claude-haiku-5-5', maxTokens: 123 },
      {
        env,
        transport: (req) => {
          seen.push(req);
          return { status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'API-OK' }], usage: {} }) };
        },
      },
    );

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.backend, 'api');
    assert.equal(res.text, 'API-OK');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].headers['x-api-key'], 'sk-ant-test-not-a-real-key');
    const body = JSON.parse(seen[0].body);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.max_tokens, 123);
    assert.equal(body.system, 's');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'p' }]);
  });

  test('GSD_LLM_BACKEND=api with no key is an explicit misconfiguration, not a throw', () => {
    const env = noBackendEnv();
    env.GSD_LLM_BACKEND = 'api';
    delete env.ANTHROPIC_API_KEY;
    const seen = [];
    const res = runtimeLlm.callModel({ prompt: 'p' }, { env, transport: (r) => { seen.push(r); return { status: 200, text: '{}' }; } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_backend');
    assert.match(res.detail, /GSD_LLM_BACKEND=api but/);
    assert.equal(seen.length, 0);
  });

  test('the default API transport never puts the key on a command line', () => {
    const dir = tmp('gsd-88-17-curl-');
    const argvLog = path.join(dir, 'curl-argv.txt');
    const fakeCurl = path.join(dir, 'fake-curl.cjs');
    fs.writeFileSync(fakeCurl, [
      "const fs = require('fs');",
      `const log = ${JSON.stringify(argvLog)};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(log, 'ARGV: ' + args.join(' ') + '\\n');",
      "const i = args.indexOf('--config');",
      'if (i >= 0) {',
      "  const cfg = args[i + 1];",
      "  fs.appendFileSync(log, 'CFGMODE: ' + (fs.statSync(cfg).mode & 0o777).toString(8) + '\\n');",
      "  fs.appendFileSync(log, 'DIRMODE: ' + (fs.statSync(require('path').dirname(cfg)).mode & 0o777).toString(8) + '\\n');",
      "  fs.appendFileSync(log, 'CFGHASKEY: ' + (fs.readFileSync(cfg, 'utf8').includes('x-api-key') ? 1 : 0) + '\\n');",
      '}',
      'process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "CURL-OK" }] }));',
      '',
    ].join('\n'));

    const env = noBackendEnv();
    env.GSD_LLM_BACKEND = 'api';
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    env.GSD_CURL = JSON.stringify([process.execPath, fakeCurl]);

    const res = runtimeLlm.callModel({ prompt: 'p', model: 'haiku' }, { env });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.text, 'CURL-OK');

    const log = fs.readFileSync(argvLog, 'utf8');
    assert.ok(!log.includes('sk-ant-test-not-a-real-key'),
      `the key must never appear on curl's command line:\n${log}`);
    assert.match(log, /CFGHASKEY: 1/, 'the key travels in the config file');
    if (process.platform !== 'win32') {
      // POSIX permission bits; NTFS has none (the per-user %LOCALAPPDATA%\Temp ACL is
      // what protects the file there -- the same split plan 88-15 recorded).
      assert.match(log, /CFGMODE: 600\b/);
      assert.match(log, /DIRMODE: 700\b/);
    }
  });
});

// ─── 5. The three Node callers (task 88-17-04) ──────────────────────────────

const SHUNT = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-shunt.cjs');
const MEMORY_CJS = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const VERIFY = path.resolve(__dirname, '..', 'scripts', 'verify-v26.cjs');

/**
 * A fake `curl` that records any attempt and answers with a canned Messages response.
 * Used as the ALARM in the no-opt-in cases (a subprocess an in-process guard cannot see)
 * and as the TRANSPORT in the opt-in case.
 * @param {string} dir
 * @param {string} logPath
 * @returns {string} a GSD_CURL JSON-array value
 */
function fakeCurlOverride(dir, logPath) {
  const file = path.join(dir, 'fake-curl.cjs');
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    `const log = ${JSON.stringify(logPath)};`,
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(log, 'ARGV: ' + args.join(' ') + '\\n');",
    "const i = args.indexOf('--config');",
    'if (i >= 0) {',
    "  fs.appendFileSync(log, 'CFG:\\n' + fs.readFileSync(args[i + 1], 'utf8'));",
    '}',
    'process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "API-BRANCH-ANSWER" }] }));',
    '',
  ].join('\n'));
  return JSON.stringify([process.execPath, file]);
}

describe('88-17 callers: gsd-shunt no longer lets a key select the API', () => {
  test('a key present and no opt-in reports backend=cli and dials nothing', () => {
    const dir = tmp('gsd-88-17-shunt-cli-');
    const corpus = path.join(dir, 'corpus.txt');
    fs.writeFileSync(corpus, 'const x = 1;\n');
    const cliLog = path.join(dir, 'cli-calls.jsonl');
    const curlLog = path.join(dir, 'curl-attempts.log');
    const guardLog = path.join(dir, 'guard.log');

    const env = noBackendEnv();
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    env.GSD_SHUNT_CLAUDE_BIN = fakeCliOverride(dir, cliLog);
    env.GSD_SHUNT_LOG = path.join(dir, 'shunt-log.jsonl');
    env.GSD_CURL = fakeCurlOverride(dir, curlLog);
    env.GSD_HERMETIC_GUARD_BLOCK_PORTS = '443';
    env.GSD_HERMETIC_GUARD_LOG = guardLog;
    env.NODE_OPTIONS = `--require ${GUARD}`;
    delete env.GSD_SHUNT_BACKEND;

    const r = spawnSync(process.execPath, [SHUNT, 'bulk-read', '--question', 'what?', '--paths', corpus],
      { encoding: 'utf8', env });

    assert.ok(!fs.existsSync(curlLog),
      `api.anthropic.com must not be reached: ${fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : ''}`);
    const guard = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8') : '';
    assert.equal(guard.trim(), '', `the guard logged a blocked dial-out:\n${guard}`);

    assert.equal(r.status, 0, `shunt failed: ${r.stderr}`);
    assert.match(r.stderr, /\[gsd-shunt bulk-read\] worker=haiku backend=cli input_chars=\d+/,
      `report() must still print worker=/backend=/input_chars=: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(FAKE_TEXT));
  });

  test('GSD_SHUNT_BACKEND=api still selects the API branch, proven on the request', () => {
    const dir = tmp('gsd-88-17-shunt-api-');
    const corpus = path.join(dir, 'corpus.txt');
    fs.writeFileSync(corpus, 'const x = 1;\n');
    const curlLog = path.join(dir, 'curl.log');

    const env = noBackendEnv();
    env.GSD_SHUNT_BACKEND = 'api';
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    env.GSD_SHUNT_LOG = path.join(dir, 'shunt-log.jsonl');
    env.GSD_CURL = fakeCurlOverride(dir, curlLog);

    const r = spawnSync(process.execPath, [SHUNT, 'bulk-read', '--question', 'what?', '--paths', corpus],
      { encoding: 'utf8', env });
    assert.equal(r.status, 0, `shunt failed: ${r.stderr}`);
    assert.match(r.stderr, /backend=api/);
    assert.match(r.stdout, /API-BRANCH-ANSWER/);

    const log = fs.readFileSync(curlLog, 'utf8');
    assert.match(log, /url = "https:\/\/api\.anthropic\.com\/v1\/messages"/,
      'the opt-in branch addresses the Messages API');
    assert.match(log, /anthropic-version: 2023-06-01/);
    assert.ok(!log.split('\n').filter((l) => l.startsWith('ARGV:')).join('').includes('sk-ant-test-not-a-real-key'),
      `the key must never be on curl's command line:\n${log}`);
  });

  test('the recursion guard and the report shape are unchanged', () => {
    const src = fs.readFileSync(SHUNT, 'utf8');
    assert.ok(src.includes("process.env.GSD_SHUNT_WORKER === '1'"), 'the recursion guard survives');
    assert.ok(src.includes('`worker=${res.model}`'), 'report() still prints worker=');
    assert.ok(src.includes('`backend=${res.backend}`'), 'report() still prints backend=');
    assert.ok(src.includes('`input_chars=${inputChars}`'), 'report() still prints input_chars=');
  });
});

describe('88-17 callers: gsd-memory keeps its rate-limit backoff', () => {
  test('claudeSummarize retries a rate-limited CLI and then succeeds', () => {
    const dir = tmp('gsd-88-17-distill-');
    const log = path.join(dir, 'calls.jsonl');
    const state = path.join(dir, 'state.txt');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, log, {
      stateFile: state,
      failFirstWith: 'Error: 429 Too Many Requests',
      text: 'A distilled summary long enough to pass the twenty character floor.',
    });

    const mem = require(MEMORY_CJS);
    const slept = [];
    const out = mem._test_claudeSummarize(
      [{ source: 'agent', text: 'first memory' }, { source: 'agent', text: 'second memory' }],
      'sonnet',
      { env, retryDelaysMs: [5, 7], sleep: (ms) => slept.push(ms) },
    );

    assert.match(out || '', /distilled summary/);
    assert.deepEqual(slept, [5], 'exactly one backoff delay fired');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'two attempts were made');
  });

  test('claudeSummarize returns null (next provider) when there is no backend', () => {
    const env = noBackendEnv();
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    const mem = require(MEMORY_CJS);
    const out = mem._test_claudeSummarize([{ source: 'agent', text: 'x' }], 'haiku', { env });
    assert.equal(out, null, 'a null return means "try the next provider", unchanged');
  });

  test('the CLI backend writes no file at all, so no key can reach disk', () => {
    const dir = tmp('gsd-88-17-nodisk-');
    const log = path.join(dir, 'calls.jsonl');
    const env = noBackendEnv();
    env.GSD_LLM_CLI_BIN = fakeCliOverride(dir, log);
    env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gsd-llm-'));
    const res = runtimeLlm.callModel({ prompt: 'p', model: 'haiku' }, { env });
    assert.equal(res.ok, true);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gsd-llm-'));
    assert.deepEqual(after, before, 'the CLI backend must create no temp directory');
  });
});

describe('88-17 callers: verify-v26 reports a backend, not a required key', () => {
  test('with a fake CLI it reports available; with neither it does not name a key', () => {
    const dir = tmp('gsd-88-17-verify-');
    const driver = path.join(dir, 'driver.cjs');
    fs.writeFileSync(driver, [
      `const v = require(${JSON.stringify(VERIFY)});`,
      'process.stdout.write(JSON.stringify(v.preflightEnvCheck()));',
      '',
    ].join('\n'));

    const withCli = noBackendEnv();
    withCli.GSD_LLM_CLI_BIN = fakeCliOverride(dir, path.join(dir, 'calls.jsonl'));
    const a = JSON.parse(spawnSync(process.execPath, [driver], { encoding: 'utf8', env: withCli }).stdout);
    assert.equal(a.available, true, JSON.stringify(a));
    assert.equal(a.backend, 'cli');
    assert.deepEqual(a.required, [], 'nothing is required any more');
    assert.deepEqual(a.missing, []);

    const bare = noBackendEnv();
    bare.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    const b = JSON.parse(spawnSync(process.execPath, [driver], { encoding: 'utf8', env: bare }).stdout);
    assert.equal(b.available, false, JSON.stringify(b));
    assert.equal(b.backend, 'none');
    assert.deepEqual(b.required, []);
    assert.ok(!JSON.stringify(b).includes('ANTHROPIC'),
      `the preflight must not name an API key as required: ${JSON.stringify(b)}`);
  });
});
