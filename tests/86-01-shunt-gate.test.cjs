'use strict';

/**
 * tests/86-01-shunt-gate.test.cjs — token-saving read shunt.
 *
 * Covers the PreToolUse gate (hooks/gsd-shunt-gate.cjs) as a real process:
 * opt-in default, deny/warn shapes, targeted-read passthrough, bare-dump
 * detection, subagent coverage with worker exemption, fail-open; plus the
 * pure helpers of the worker CLI (get-shit-done/bin/gsd-shunt.cjs), build
 * staging and installer registration. No model is called.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GATE = path.join(REPO, 'hooks', 'gsd-shunt-gate.cjs');
const WORKER = path.join(REPO, 'get-shit-done', 'bin', 'gsd-shunt.cjs');
const gate = require(GATE);
const worker = require(WORKER);

let dir, big, small, plan, wide, logFile;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shunt-'));
  big = path.join(dir, 'big.js');
  small = path.join(dir, 'small.js');
  plan = path.join(dir, '01-02-PLAN.md');
  wide = path.join(dir, 'wide.json');
  logFile = path.join(dir, 'log.jsonl');
  fs.writeFileSync(big, 'const x = 1;\n'.repeat(500));
  fs.writeFileSync(small, 'const x = 1;\n'.repeat(20));
  fs.writeFileSync(plan, '- step\n'.repeat(900));
  fs.writeFileSync(wide, '{"k":"' + 'a'.repeat(50000) + '"}\n'); // 2 lines, 50 KB
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ shunt: { enabled: true } }));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(input, env = {}) {
  const base = Object.assign({}, process.env, {
    GSD_SHUNT_LOG: logFile,
    GSD_SHUNT_CONFIG_PATH: path.join(dir, 'no-such-config.json'),
  });
  for (const k of ['GSD_SHUNT', 'GSD_SHUNT_MIN_LINES', 'GSD_SHUNT_MIN_BYTES',
    'GSD_SHUNT_EXEMPT_AGENTS', 'GSD_SHUNT_EXEMPT_RE', 'GSD_HOOKS_ENFORCE']) delete base[k];
  const r = spawnSync(process.execPath, [GATE], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: Object.assign(base, env),
  });
  return { code: r.status, out: r.stdout, json: r.stdout ? JSON.parse(r.stdout) : null };
}

const read = (file, extra = {}, top = {}) =>
  Object.assign({ tool_name: 'Read', tool_input: Object.assign({ file_path: file }, extra), cwd: dir }, top);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
const denied = (r) => r.json && r.json.hookSpecificOutput &&
  r.json.hookSpecificOutput.permissionDecision === 'deny';

describe('shunt gate: mode', () => {
  test('default is off: a whole read of a big file passes with no output', () => {
    const r = run(read(big));
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  });

  test('GSD_SHUNT=on denies with the PreToolUse deny shape and names the routes', () => {
    const r = run(read(big), { GSD_SHUNT: 'on' });
    assert.equal(r.code, 0);
    assert.ok(denied(r));
    const reason = r.json.hookSpecificOutput.permissionDecisionReason;
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(reason, /offset\/limit/);
    assert.match(reason, /gsd-rlm query/);
    assert.match(reason, /bulk-read/);
  });

  test('deny does not depend on GSD_HOOKS_ENFORCE (warn-first gates must not neuter it)', () => {
    assert.ok(denied(run(read(big), { GSD_SHUNT: 'on', GSD_HOOKS_ENFORCE: 'warn' })));
    assert.ok(denied(run(read(big), { GSD_SHUNT: 'on', GSD_HOOKS_ENFORCE: 'off' })));
  });

  test('GSD_SHUNT=warn emits a systemMessage and never a deny', () => {
    const r = run(read(big), { GSD_SHUNT: 'warn' });
    assert.equal(typeof r.json.systemMessage, 'string');
    assert.equal(r.json.hookSpecificOutput, undefined);
  });

  test('config shunt.enabled turns it on; GSD_SHUNT=off overrides config', () => {
    const cfg = { GSD_SHUNT_CONFIG_PATH: path.join(dir, 'config.json') };
    assert.ok(denied(run(read(big), cfg)));
    assert.equal(run(read(big), Object.assign({ GSD_SHUNT: 'off' }, cfg)).out, '');
  });
});

describe('shunt gate: what is blocked', () => {
  const on = { GSD_SHUNT: 'on' };

  test('targeted reads pass (offset or limit)', () => {
    assert.equal(run(read(big, { offset: 100 }), on).out, '');
    assert.equal(run(read(big, { limit: 50 }), on).out, '');
  });

  test('small files, missing files and skipped extensions pass', () => {
    assert.equal(run(read(small), on).out, '');
    assert.equal(run(read(path.join(dir, 'nope.js')), on).out, '');
    const png = path.join(dir, 'x.png');
    fs.writeFileSync(png, 'x\n'.repeat(900));
    assert.equal(run(read(png), on).out, '');
  });

  test('a few very long lines trip the byte threshold', () => {
    assert.ok(denied(run(read(wide), on)));
  });

  test('plan files are exempt by default; the exemption is configurable', () => {
    assert.equal(run(read(plan), on).out, '');
    assert.ok(denied(run(read(plan), { GSD_SHUNT: 'on', GSD_SHUNT_EXEMPT_RE: 'never-matches-anything' })));
  });

  test('thresholds are configurable', () => {
    assert.equal(run(read(big), { GSD_SHUNT: 'on', GSD_SHUNT_MIN_LINES: '5000', GSD_SHUNT_MIN_BYTES: '9000000' }).out, '');
    assert.ok(denied(run(read(small), { GSD_SHUNT: 'on', GSD_SHUNT_MIN_LINES: '10' })));
  });

  test('relative paths resolve against cwd', () => {
    assert.ok(denied(run(read('big.js'), on)));
  });

  test('bare dump commands are blocked; pipelines and bounded head/tail pass', () => {
    assert.ok(denied(run(bash(`cat ${big}`), on)));
    assert.ok(denied(run(bash(`less "${big}"`), on)));
    assert.ok(denied(run(bash(`head ${big}`), on)));
    assert.equal(run(bash(`cat ${big} | grep x`), on).out, '');
    assert.equal(run(bash(`head -n 20 ${big}`), on).out, '');
    assert.equal(run(bash(`wc -l ${big}`), on).out, '');
    assert.equal(run(bash(`cat ${small}`), on).out, '');
  });

  test('subagents are covered; worker agents and listed agents are exempt', () => {
    assert.ok(denied(run(read(big, {}, { agent_type: 'gsd-executor-backend' }), on)));
    assert.equal(run(read(big, {}, { agent_type: 'gsd-bulk-reader' }), on).out, '');
    assert.equal(run(read(big, {}, { agent_type: 'gsd-debugger' }),
      { GSD_SHUNT: 'on', GSD_SHUNT_EXEMPT_AGENTS: 'gsd-debugger, gsd-security' }).out, '');
  });
});

describe('shunt gate: fail-open and logging', () => {
  test('unparseable stdin and odd shapes exit 0 with no output', () => {
    for (const input of ['not json', '', '[]', '{"tool_name":"Read"}', '{"tool_name":"Bash","tool_input":{"command":"cat \\"unterminated"}}']) {
      const r = spawnSync(process.execPath, [GATE], {
        input, encoding: 'utf8',
        env: Object.assign({}, process.env, { GSD_SHUNT: 'on', GSD_SHUNT_LOG: logFile }),
      });
      assert.equal(r.status, 0, input);
      assert.equal(r.stdout, '', input);
    }
  });

  test('a block is logged with agent, path and size', () => {
    fs.rmSync(logFile, { force: true });
    run(read(big, {}, { agent_type: 'gsd-executor-backend', session_id: 's1' }), { GSD_SHUNT: 'on' });
    const e = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(e.event, 'blocked');
    assert.equal(e.agent, 'gsd-executor-backend');
    assert.equal(e.path, big);
    assert.equal(e.bytes, fs.statSync(big).size);
  });

  test('an unwritable log path does not change the decision', () => {
    assert.ok(denied(run(read(big), { GSD_SHUNT: 'on', GSD_SHUNT_LOG: '/dev/null/nope/log.jsonl' })));
  });
});

describe('shunt gate: pure helpers', () => {
  test('bashTargets', () => {
    assert.deepEqual(gate.bashTargets('cat a.js b.js'), ['a.js', 'b.js']);
    assert.deepEqual(gate.bashTargets('/bin/cat "my file.js"'), ['my file.js']);
    assert.deepEqual(gate.bashTargets('tail -f a.log'), []);
    assert.deepEqual(gate.bashTargets('cat a.js && rm b'), []);
    assert.deepEqual(gate.bashTargets('git log'), []);
    assert.deepEqual(gate.bashTargets('cat $(ls)'), []);
  });

  test('shellSplit returns null on an unterminated quote', () => {
    assert.equal(gate.shellSplit('cat "a'), null);
    // Phase 88 plan 88-15: `\\` is an ESCAPE on POSIX and a PATH SEPARATOR on
    // Windows, so shellSplit takes an injectable platform. The POSIX corpus is
    // asserted with the POSIX branch on every host; the Windows branch has its
    // own assertions in tests/88-15-hook-command-golden.test.cjs.
    assert.deepEqual(gate.shellSplit("cat 'a b' c\\ d", 'darwin'), ['cat', 'a b', 'c d']);
    assert.deepEqual(gate.shellSplit('cat D:\\a\\big.js', 'win32'), ['cat', 'D:\\a\\big.js']);
  });
});

describe('shunt worker: pure helpers and argument errors', () => {
  test('parseArgs handles list flags, booleans and values', () => {
    const a = worker.parseArgs(['--question', 'what?', '--paths', 'a', 'b', '--json']);
    assert.equal(a.question, 'what?');
    assert.deepEqual(a.paths, ['a', 'b']);
    assert.equal(a.json, true);
  });

  test('numbered prefixes aligned line numbers', () => {
    assert.equal(worker.numbered('a\nb'), '1\ta\n2\tb');
  });

  test('stripFences removes one wrapping fence and nothing else', () => {
    assert.equal(worker.stripFences('```js\nconst a = 1;\n```'), 'const a = 1;\n');
    assert.equal(worker.stripFences('const a = 1;'), 'const a = 1;\n');
    assert.equal(worker.stripFences('a\n```\nb\n```\nc'), 'a\n```\nb\n```\nc\n');
  });

  test('summarize totals blocks and worker calls', () => {
    const s = worker.summarize([
      { event: 'blocked', bytes: 40000, agent: 'gsd-executor-backend' },
      { event: 'blocked', bytes: 20000 },
      { event: 'warned', bytes: 1000 },
      { event: 'bulk-read', input_bytes: 100000, output_bytes: 2000, cost_usd: 0.01 },
      { event: 'code-write', input_bytes: 5000, output_bytes: 9000, cost_usd: 0.02 },
    ]);
    assert.equal(s.blocked, 2);
    assert.equal(s.warned, 1);
    assert.equal(s.bulk_reads, 1);
    assert.equal(s.code_writes, 1);
    assert.equal(s.worker_cost_usd, 0.03);
    assert.deepEqual(s.by_agent, { 'gsd-executor-backend': 1, main: 2 });
    assert.equal(s.est_tokens_kept_out, Math.round((61000 + (105000 - 11000)) / 4));
  });

  const cli = (args, env = {}) => spawnSync(process.execPath, [WORKER, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { GSD_SHUNT_LOG: logFile, GSD_SHUNT_CLAUDE_BIN: '/nonexistent/claude' }, env),
  });

  test('missing arguments exit 2 before any model call', () => {
    assert.equal(cli(['bulk-read', '--paths', small]).status, 2);
    assert.equal(cli(['bulk-read', '--question', 'q']).status, 2);
    assert.equal(cli(['code-write', '--spec', 's']).status, 2);
    assert.equal(cli(['bulk-read', '--question', 'q', '--paths', path.join(dir, 'nope')]).status, 2);
    assert.equal(cli(['nonsense']).status, 2);
  });

  test('code-write refuses to overwrite an existing target without --force', () => {
    const r = cli(['code-write', '--spec', 's', '--reference', small, '--target', big]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /target exists/);
    assert.equal(fs.readFileSync(big, 'utf8'), 'const x = 1;\n'.repeat(500));
  });

  test('oversized input is rejected, not sent', () => {
    const r = cli(['bulk-read', '--question', 'q', '--paths', big], { GSD_SHUNT_MAX_INPUT_CHARS: '100' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /split the paths/);
  });

  test('recursion guard: refuses to run inside a worker', () => {
    const r = cli(['bulk-read', '--question', 'q', '--paths', small], { GSD_SHUNT_WORKER: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /recursion guard/);
  });

  test('an unavailable backend fails with exit 1 and a clear message', () => {
    const r = cli(['bulk-read', '--question', 'q', '--paths', small], { ANTHROPIC_API_KEY: '', GSD_SHUNT_BACKEND: 'cli' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not run/);
  });

  test('stats --json reads the log', () => {
    fs.writeFileSync(logFile, JSON.stringify({ event: 'blocked', bytes: 4000 }) + '\nnot json\n');
    const r = cli(['stats', '--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).blocked, 1);
  });
});

describe('shunt: build and install wiring', () => {
  test('build-hooks stages the gate into dist', () => {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-hooks.js')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(REPO, 'hooks', 'dist', 'gsd-shunt-gate.cjs')));
    assert.ok(fs.existsSync(path.join(REPO, 'hooks', 'dist', 'lib', 'hook-common.cjs')));
  });

  test('the template config ships a shunt block, off by default', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'get-shit-done', 'templates', 'config.json'), 'utf8'));
    assert.deepEqual(cfg.shunt, { enabled: false, min_lines: 400, min_bytes: 40000 });
  });

  function install(env) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shunt-install-'));
    const script = `
      process.env.GSD_TEST_MODE = '1';
      process.chdir(${JSON.stringify(cwd)});
      const { install } = require(${JSON.stringify(path.join(REPO, 'bin', 'install.js'))});
      // install() returns {settingsPath, settings} without writing; persist between
      // the two runs (as finishInstall does) so the second run sees the first.
      const first = install(false, 'claude');
      fs.writeFileSync(first.settingsPath, JSON.stringify(first.settings, null, 2));
      const second = install(false, 'claude');
      fs.writeFileSync(${JSON.stringify(path.join(cwd, 'result.json'))}, JSON.stringify(second.settings));
    `.replace("process.chdir", "const fs = require('fs'); process.chdir");
    const childEnv = Object.assign({}, process.env, env);
    if (env.GSD_SHUNT === undefined) delete childEnv.GSD_SHUNT;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: childEnv });
    const p = path.join(cwd, 'result.json');
    const settings = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    const hookOnDisk = fs.existsSync(path.join(cwd, '.claude', 'hooks', 'gsd-shunt-gate.cjs'));
    fs.rmSync(cwd, { recursive: true, force: true });
    return { r, settings, hookOnDisk };
  }
  const shuntEntries = (settings) => ((settings.hooks && settings.hooks.PreToolUse) || [])
    .filter(e => (e.hooks || []).some(h => (h.command || '').includes('gsd-shunt-gate')));

  test('install without the flag registers nothing and says how to opt in', () => {
    const { r, settings } = install({});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(shuntEntries(settings).length, 0);
    assert.ok(!settings.env || settings.env.GSD_SHUNT === undefined);
    assert.match(r.stdout, /--enable-shunt/);
  });

  test('install with GSD_SHUNT=on registers once, with timeout, and persists the switch', () => {
    const { r, settings, hookOnDisk } = install({ GSD_SHUNT: 'on' });
    assert.equal(r.status, 0, r.stderr);
    const entries = shuntEntries(settings);
    assert.equal(entries.length, 1, 'two installs must register exactly one entry');
    assert.equal(entries[0].matcher, 'Read|Bash');
    assert.equal(entries[0].hooks[0].timeout, 5);
    assert.equal(settings.env.GSD_SHUNT, 'on');
    assert.ok(hookOnDisk, 'the gate script must be copied next to its registration');
  });
});
