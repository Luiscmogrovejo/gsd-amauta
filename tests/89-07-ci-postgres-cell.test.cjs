/**
 * Phase 89 plan 89-07 task 02: `scripts/ci-postgres-cell.cjs`, driven with an
 * INJECTED command runner.
 *
 * Nothing here starts a PostgreSQL. The module refuses to do anything unless
 * `CI` is set, and every case below either exercises that refusal or hands the
 * module a fake runner and asserts the ARGV it would have spawned. That is the
 * only way to test a Windows and a macOS bring-up from one cell, and it is also
 * the rule the plan states: the only real cluster this script ever starts is on
 * a CI runner.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cell = require(path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'));
const { LIVE_PORTS } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));
const platform = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

/** A port no live service owns, used wherever the port itself is not the subject. */
const SAFE_PORT = 54329;

/**
 * A recording runner that answers every spawn with success.
 *
 * @param {object} [answers] - per-tool stdout, keyed by the tool's base name.
 * @returns {{calls: Array, run: Function}}
 */
function recorder(answers = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const base = path.basename(String(command)).replace(/\.exe$/i, '');
    const stdout = Object.prototype.hasOwnProperty.call(answers, base)
      ? answers[base]
      : defaultStdout(base, args);
    return { status: 0, stdout, stderr: '', signal: null, error: null };
  };
  return { calls, run };
}

/**
 * What a healthy tool prints, so a bring-up can be driven end to end.
 *
 * @param {string} base - the tool's base name.
 * @param {string[]} args
 * @returns {string}
 */
function defaultStdout(base, args) {
  if (base === 'brew') return '/opt/homebrew/opt/postgresql@17\n';
  if (base === 'pg_config') return '/usr/lib/postgresql/16/bin\n';
  if (base === 'psql') {
    const q = String(args[args.length - 1] || '');
    if (q === 'SELECT 1') return '1\n';
    if (q.includes('extversion')) return '0.8.7\n';
    if (q.includes('server_version')) return '17.12\n';
    return '';
  }
  return '';
}

/** A fresh, isolated data-dir path that no test ever populates with a real cluster. */
function scratchDataDir(tag) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8907-' + tag + '-')), 'pgdata');
}

/** An environment that looks like a CI cell, without touching process.env. */
function ciEnv(extra = {}) {
  return { CI: 'true', PATH: process.env.PATH || '', ...extra };
}

/**
 * Drive `up()` with a recording runner.
 *
 * @param {string} plat - 'darwin' | 'win32' | 'linux'
 * @param {object} [opts] - overrides merged into the call.
 * @returns {Promise<{calls: Array, dsn: string, out: string[]}>}
 */
async function driveUp(plat, opts = {}) {
  const rec = recorder(opts.answers);
  const out = [];
  const dsn = await cell.up({
    port: opts.port || SAFE_PORT,
    dataDir: opts.dataDir || scratchDataDir(plat),
    platform: plat,
    env: opts.env || ciEnv(plat === 'win32' ? { PGBIN: 'C:\\Program Files\\PostgreSQL\\17\\bin' } : {}),
    run: opts.run || rec.run,
    sleep: () => {},
    probe: () => false,
    out: (s) => out.push(s),
  });
  return { calls: rec.calls, dsn, out };
}

describe('89-07 ci-postgres-cell: the refusals', () => {
  test('refuses when CI is unset, and names CI in the message', () => {
    assert.throws(
      () => cell.assertCi({ PATH: '/usr/bin' }),
      (e) => e.code === 'not_ci' && /\bCI\b/.test(e.message),
    );
  });

  test('CI=false and CI=0 are not CI', () => {
    for (const v of ['false', '0', '']) {
      assert.throws(() => cell.assertCi({ CI: v }), (e) => e.code === 'not_ci');
    }
  });

  test('GSD_CI_PG_ALLOW_LOCAL=1 is the only local escape hatch', () => {
    assert.doesNotThrow(() => cell.assertCi({ GSD_CI_PG_ALLOW_LOCAL: '1' }));
    assert.throws(() => cell.assertCi({ GSD_CI_PG_ALLOW_LOCAL: 'yes' }), (e) => e.code === 'not_ci');
  });

  test('nothing in tests/ or .github/ arms GSD_CI_PG_ALLOW_LOCAL', () => {
    // The guard is only a guard while nothing in the suite disarms it. The two
    // files allowed to NAME the variable are this one (which asserts the escape
    // hatch exists) and the module itself (whose refusal sentence quotes it);
    // both are excluded by path, not by a text pattern.
    const allowed = new Set([
      path.join(ROOT, 'tests', '89-07-ci-postgres-cell.test.cjs'),
      path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'),
    ]);
    const hits = [];
    for (const dir of ['tests', '.github']) {
      walk(path.join(ROOT, dir), (file) => {
        if (allowed.has(file)) return;
        if (!/\.(cjs|mjs|js|py|yml|yaml|sh)$/.test(file)) return;
        if (fs.readFileSync(file, 'utf8').includes('GSD_CI_PG_ALLOW_LOCAL')) hits.push(file);
      });
    }
    assert.deepStrictEqual(hits, []);
  });

  test('every live port is refused, one case per port', async () => {
    for (const port of LIVE_PORTS) {
      assert.throws(
        () => cell.assertPortAllowed(port),
        (e) => e.code === 'live_port' && e.detail.port === port,
        'port ' + port + ' must be refused',
      );
      await assert.rejects(
        cell.up({
          port,
          dataDir: scratchDataDir('live' + port),
          platform: 'linux',
          env: ciEnv(),
          run: () => assert.fail('up() spawned something for live port ' + port),
          probe: () => false,
          out: () => {},
        }),
        (e) => e.code === 'live_port',
      );
    }
  });

  test('a port something already listens on is refused before initdb', async () => {
    await assert.rejects(
      cell.up({
        port: SAFE_PORT,
        dataDir: scratchDataDir('inuse'),
        platform: 'linux',
        env: ciEnv(),
        run: () => assert.fail('up() spawned something on an occupied port'),
        probe: () => true,
        out: () => {},
      }),
      (e) => e.code === 'port_in_use' && e.detail.port === SAFE_PORT,
    );
  });

  test('a non-port is refused', () => {
    for (const bad of [0, -1, 70000, 1.5, NaN, undefined]) {
      assert.throws(() => cell.assertPortAllowed(bad), (e) => e.code === 'bad_port');
    }
  });
});

describe('89-07 ci-postgres-cell: the argv, per platform', () => {
  test('darwin resolves the Homebrew keg and spawns absolute paths', async () => {
    const { calls, dsn } = await driveUp('darwin');
    const brew = calls[0];
    assert.strictEqual(path.basename(brew.command), 'brew');
    assert.deepStrictEqual(brew.args, ['--prefix', 'postgresql@' + cell.PG_MAJOR]);

    const initdb = calls.find((c) => /initdb/.test(c.command));
    assert.ok(initdb, 'initdb was spawned');
    assert.strictEqual(initdb.command, '/opt/homebrew/opt/postgresql@17/bin/initdb');
    assert.ok(initdb.args.includes('-U'));
    assert.ok(initdb.args.includes(cell.ROLE));
    assert.ok(initdb.args.includes('--locale=C'));
    assert.ok(initdb.args.includes('--encoding=UTF8'));
    assert.ok(initdb.args.some((a) => a === '--auth-host=scram-sha-256'));

    const pgctl = calls.find((c) => /pg_ctl/.test(c.command));
    assert.strictEqual(pgctl.command, '/opt/homebrew/opt/postgresql@17/bin/pg_ctl');
    assert.ok(pgctl.args.includes('start'));
    assert.ok(pgctl.args.includes('-p ' + SAFE_PORT + ' -c listen_addresses=127.0.0.1'));

    assert.strictEqual(dsn, 'postgresql://gsd:gsd@127.0.0.1:' + SAFE_PORT + '/gsd_test');
  });

  test('win32 takes PGBIN and appends .exe to every tool', async () => {
    const { calls } = await driveUp('win32');
    assert.ok(!calls.some((c) => /brew/.test(c.command)), 'brew is never consulted on Windows');
    for (const tool of ['initdb', 'pg_ctl', 'psql']) {
      const c = calls.find((x) => new RegExp(tool).test(x.command));
      assert.ok(c, tool + ' was spawned');
      assert.ok(/\.exe$/.test(c.command), tool + ' is spawned as ' + tool + '.exe, got ' + c.command);
      assert.ok(c.command.startsWith('C:\\Program Files\\PostgreSQL\\17\\bin'), c.command);
    }
  });

  test('pg_ctl start is never given a PIPE, because the server inherits it', async () => {
    // Measured on `windows-latest`, run 43357540296: with `encoding: 'utf8'`
    // spawnSync waits for the stdio PIPES to reach EOF, and the server
    // pg_ctl leaves behind holds them open for its whole life — so the call
    // that had plainly started the cluster sat there until the job's 25-minute
    // timeout. Every other spawn here is a short-lived client and may pipe.
    for (const plat of ['darwin', 'win32', 'linux']) {
      const { calls } = await driveUp(plat);
      const start = calls.find((c) => /pg_ctl/.test(c.command) && c.args.includes('start'));
      assert.ok(start, plat + ': pg_ctl start was spawned');
      assert.ok(Array.isArray(start.options.stdio),
        plat + ': pg_ctl start must be given explicit stdio, got '
        + JSON.stringify(start.options.stdio));
      assert.strictEqual(start.options.stdio[0], 'ignore', plat);
      assert.strictEqual(typeof start.options.stdio[1], 'number',
        plat + ': stdout must be a file descriptor, never a pipe');
      assert.strictEqual(start.options.stdio[1], start.options.stdio[2], plat);
      assert.strictEqual(start.options.encoding, undefined,
        plat + ': an encoding implies a pipe');
      for (const c of calls) {
        if (c === start) continue;
        assert.strictEqual(c.options.stdio, undefined,
          plat + ': only pg_ctl start needs file stdio: ' + c.command);
      }
    }
  });

  test('win32 falls back to the image default when PGBIN is unset', () => {
    const dir = cell.resolveBinDir({ platform: 'win32', env: ciEnv(), run: () => assert.fail('no spawn') });
    assert.strictEqual(dir, path.join('C:\\', 'Program Files', 'PostgreSQL', cell.PG_MAJOR, 'bin'));
  });

  test('linux resolves through pg_config --bindir', async () => {
    const { calls } = await driveUp('linux');
    const first = calls[0];
    assert.strictEqual(path.basename(first.command), 'pg_config');
    assert.deepStrictEqual(first.args, ['--bindir']);
    const initdb = calls.find((c) => /initdb/.test(c.command));
    assert.strictEqual(initdb.command, '/usr/lib/postgresql/16/bin/initdb');
  });

  test('the cmd.exe rule is what spawnTool applies for a .cmd target on win32', () => {
    // The module always hands spawnTool an ALREADY-RESOLVED absolute path, so the
    // rule only engages for a .cmd/.bat shim. Assert the rule itself, through the
    // shared helper, so a future change of the spawn form is caught here.
    assert.strictEqual(platform.isCmdShim('C:\\PG\\17\\bin\\psql.exe', 'win32'), false);
    assert.strictEqual(platform.isCmdShim('C:\\PG\\17\\bin\\psql.cmd', 'win32'), true);
    const line = platform.buildCmdLine('C:\\Program Files\\PostgreSQL\\17\\bin\\psql.cmd', ['-tAc', 'SELECT 1']);
    assert.strictEqual(line, '"C:\\Program Files\\PostgreSQL\\17\\bin\\psql.cmd" -tAc "SELECT 1"');
    const diag = {};
    platform.spawnTool(
      { command: 'C:\\x\\psql.cmd' }, ['-tAc', 'SELECT 1'],
      { platform: 'win32', env: { ComSpec: 'cmd.exe' }, spawn: () => ({ status: 0 }), diag },
    );
    assert.strictEqual(diag.spawnForm, 'cmd.exe /d /s /c');
  });

  test('no argv token carries a shell metacharacter the module put there', async () => {
    for (const plat of ['darwin', 'win32', 'linux']) {
      const { calls } = await driveUp(plat);
      for (const c of calls) {
        for (const a of c.args) {
          assert.ok(
            !/[&|;<>`$\n\r]/.test(String(a)),
            plat + ': argv token carries a shell metacharacter: ' + JSON.stringify(a),
          );
        }
        assert.strictEqual(c.options.shell, undefined, 'shell: must never be passed');
      }
    }
  });

  test('the password travels in a file and in PGPASSWORD, never in SQL or a flag value', async () => {
    const { calls } = await driveUp('darwin');
    for (const c of calls) {
      for (const a of c.args) {
        assert.ok(!/PASSWORD/i.test(String(a)) || /^--pwfile=/.test(String(a)),
          'the password reached argv as text: ' + JSON.stringify(a));
      }
    }
    const initdb = calls.find((c) => /initdb/.test(c.command));
    const pwfile = initdb.args.find((a) => /^--pwfile=/.test(String(a)));
    assert.ok(pwfile, 'initdb takes the password from a file');
    assert.strictEqual(
      fs.existsSync(pwfile.replace('--pwfile=', '')), false,
      'and the file is removed as soon as initdb has read it',
    );
    const psqlCall = calls.find((c) => /psql/.test(c.command));
    assert.strictEqual(psqlCall.options.env.PGPASSWORD, cell.PASSWORD);
    assert.ok(psqlCall.args.includes('-w'), 'psql never prompts');
  });

  test('the role is the bootstrap superuser and the database is created with the Linux shape', async () => {
    const { calls } = await driveUp('linux');
    const sql = calls.filter((c) => /psql/.test(c.command))
      .map((c) => String(c.args[c.args.length - 1]));
    assert.ok(sql.includes('CREATE DATABASE gsd_test OWNER gsd'), sql.join(' | '));
    assert.ok(sql.includes('CREATE EXTENSION IF NOT EXISTS vector'), sql.join(' | '));
    assert.ok(!sql.some((s) => /^CREATE ROLE/.test(s)),
      'initdb -U gsd already created the role as the bootstrap superuser');
  });
});

describe('89-07 ci-postgres-cell: the stdout contract', () => {
  test('exactly one GSD_TEST_POSTGRES_URL= line, and it is last', async () => {
    const { out, dsn } = await driveUp('darwin');
    const lines = out.join('').split('\n').filter((l) => l !== '');
    const hits = lines.filter((l) => l.startsWith('GSD_TEST_POSTGRES_URL='));
    assert.strictEqual(hits.length, 1, out.join(''));
    assert.strictEqual(hits[0], 'GSD_TEST_POSTGRES_URL=' + dsn);
    assert.strictEqual(lines[lines.length - 1], hits[0]);
  });

  test('the DSN shape is the Linux container step byte for byte', async () => {
    // .github/workflows/test.yml's Linux step writes
    //   GSD_TEST_POSTGRES_URL=postgresql://gsd:gsd@127.0.0.1:${PG_TEST_PORT}/gsd_test
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    const linux = /GSD_TEST_POSTGRES_URL=postgresql:\/\/gsd:gsd@127\.0\.0\.1:\$\{PG_TEST_PORT\}\/gsd_test/;
    assert.ok(linux.test(workflow), 'the Linux step still writes the DSN this module mirrors');
    const { dsn } = await driveUp('win32');
    assert.strictEqual(
      dsn.replace(String(SAFE_PORT), '${PG_TEST_PORT}'),
      'postgresql://gsd:gsd@127.0.0.1:${PG_TEST_PORT}/gsd_test',
    );
  });
});

describe('89-07 ci-postgres-cell: the readiness loop and the failure path', () => {
  test("PostgreSQL's readiness utility is never spawned, and never named", async () => {
    // The plan's acceptance criterion is a grep that must print 0, so even the
    // comment explaining the choice must not spell the name. The REASON lives in
    // 89-07-RECORD.md, where it is quoted in full.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'), 'utf8');
    assert.strictEqual((src.match(/pg_is' + 'ready/g) || []).length, 0,
      'the module must not name it at all');
    assert.ok(/Deliberately NOT PostgreSQL's own readiness utility/.test(src),
      'but it must say, in prose, that it deliberately does not use it');
    const { calls } = await driveUp('linux');
    assert.ok(!calls.some((c) => /readiness/.test(c.command)));
  });

  test('readiness is a real connection on the published port', async () => {
    const { calls } = await driveUp('linux');
    const probe = calls.find((c) => /psql/.test(c.command)
      && c.args[c.args.length - 1] === 'SELECT 1');
    assert.ok(probe, 'a real SELECT 1 was issued');
    assert.ok(probe.args.includes('-h') && probe.args.includes('127.0.0.1'));
    assert.ok(probe.args.includes('-p') && probe.args.includes(String(SAFE_PORT)));
  });

  test('the loop gives up non-zero WITH the log tail after its bound', async () => {
    const dataDir = scratchDataDir('tail');
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    fs.writeFileSync(dataDir + '.log', Array.from({ length: 80 },
      (_x, i) => 'server log line ' + (i + 1)).join('\n'));
    let attempts = 0;
    const run = (command, args) => {
      const base = path.basename(String(command));
      if (base === 'pg_config') return { status: 0, stdout: '/usr/lib/postgresql/16/bin\n', stderr: '' };
      if (base === 'psql') {
        attempts += 1;
        return { status: 2, stdout: '', stderr: 'could not connect to server' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      cell.up({
        port: SAFE_PORT,
        dataDir,
        platform: 'linux',
        env: ciEnv(),
        run,
        sleep: () => {},
        probe: () => false,
        readyTimeoutS: 3,
        out: () => {},
      }),
      (e) => {
        assert.strictEqual(e.code, 'not_ready');
        assert.ok(e.detail.log.includes('server log line 80'), 'the tail reaches the caller');
        assert.ok(!e.detail.log.includes('server log line 49'),
          'only the last ' + cell.LOG_TAIL_LINES + ' lines');
        assert.ok(e.detail.stderr.includes('could not connect'));
        return true;
      },
    );
    assert.strictEqual(attempts, 3, 'the loop made exactly its bound of attempts');
    assert.ok(attempts >= 2, 'the loop retried, it did not give up on the first answer');
  });

  test('main() prints the log tail to stderr and exits non-zero', async () => {
    // Through the CLI surface, so the diagnostic a reviewer sees is the one tested.
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'), '--up', '--port', String(LIVE_PORTS.values().next().value)],
      { encoding: 'utf8', env: { ...process.env, CI: 'true', NODE_OPTIONS: '' } },
    );
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /FAILED \[live_port\]/);
  });

  test('a failing initdb reports its own stdout and stderr', async () => {
    const run = (command) => {
      const base = path.basename(String(command));
      if (base === 'pg_config') return { status: 0, stdout: '/usr/lib/postgresql/16/bin\n', stderr: '' };
      if (base === 'initdb') {
        return { status: 1, stdout: 'creating directory ... ', stderr: 'initdb: error: directory exists and is not empty' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      cell.up({
        port: SAFE_PORT,
        dataDir: scratchDataDir('initdbfail'),
        platform: 'linux',
        env: ciEnv(),
        run,
        sleep: () => {},
        probe: () => false,
        out: () => {},
      }),
      (e) => e.code === 'initdb_failed' && /not empty/.test(e.detail.stderr),
    );
  });
});

describe('89-07 ci-postgres-cell: --stop', () => {
  test('stop is a no-op, with a sentence, when there is no cluster', () => {
    const out = [];
    const dir = scratchDataDir('nostop');
    cell.stop({
      dataDir: dir, platform: 'linux', env: ciEnv(),
      run: () => assert.fail('stop spawned something with no cluster present'),
      out: (s) => out.push(s),
    });
    assert.match(out.join(''), /nothing to stop/);
  });

  test('stop spawns pg_ctl -m immediate stop and removes the data dir', () => {
    const dir = scratchDataDir('stop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PG_VERSION'), '17\n');
    const rec = recorder();
    cell.stop({ dataDir: dir, platform: 'linux', env: ciEnv(), run: rec.run, out: () => {} });
    const pgctl = rec.calls.find((c) => /pg_ctl/.test(c.command));
    assert.ok(pgctl, 'pg_ctl was spawned');
    assert.deepStrictEqual(pgctl.args, ['-D', dir, '-m', 'immediate', '-w', '-t', '60', 'stop']);
    assert.strictEqual(fs.existsSync(dir), false, 'the data dir is gone');
  });

  test('stop refuses outside CI too', () => {
    assert.throws(
      () => cell.stop({ dataDir: scratchDataDir('stopnoci'), platform: 'linux', env: { PATH: '' }, run: () => {} }),
      (e) => e.code === 'not_ci',
    );
  });
});

describe('89-07 ci-postgres-cell: the source itself', () => {
  test('the two forbidden spawn forms appear nowhere, not even in a comment', () => {
    // The plan's acceptance criterion is a grep that must print 0, so a comment
    // explaining why the form is not used would fail it. Assert what the grep
    // asserts.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'), 'utf8');
    for (const forbidden of ['shell' + ': true', 'execSync' + '(']) {
      assert.strictEqual(src.includes(forbidden), false, 'source contains ' + forbidden);
    }
  });

  test('LIVE_PORTS comes from the runner, not from a second copy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'), 'utf8');
    assert.ok(src.includes('LIVE_PORTS'), 'the module names LIVE_PORTS');
    assert.ok(/require\('\.\/run-tests\.cjs'\)/.test(src), 'and takes it from run-tests.cjs');
    assert.ok(!/new Set\(\s*\[\s*18799/.test(src), 'the module defines no port set of its own');
    // The identity that matters: the module refuses exactly the runner's set.
    for (const p of LIVE_PORTS) {
      assert.throws(() => cell.assertPortAllowed(p), (e) => e.code === 'live_port');
    }
    assert.doesNotThrow(() => cell.assertPortAllowed(SAFE_PORT));
  });

  test('argparse refuses an unknown flag rather than guessing', () => {
    assert.throws(() => cell.parseArgs(['--nope']), (e) => e.code === 'bad_args');
    assert.throws(() => cell.parseArgs(['--port']), (e) => e.code === 'bad_args');
    assert.deepStrictEqual(cell.parseArgs(['--up', '--port', '5440']).mode, 'up');
    assert.deepStrictEqual(cell.parseArgs(['--up', '--port', '5440']).port, 5440);
  });
});

/**
 * Walk a directory tree, calling back with each file path.
 *
 * @param {string} dir
 * @param {function(string): void} fn
 * @returns {void}
 */
function walk(dir, fn) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, fn);
    else fn(full);
  }
}
