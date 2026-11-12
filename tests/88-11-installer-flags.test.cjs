'use strict';

/**
 * Plan 88-11: an unknown argument to the installer is an ERROR, not something
 * silently ignored.
 *
 * The incident this pins: `node bin/init.cjs --upgrade --files-only
 * --enable-shunt` was run on the operator's machine. `bin/init.cjs` did not know
 * `--files-only` OR `--enable-shunt`, and unknown flags were dropped on the
 * floor, so the command the operator believed was "refresh the files" ran the
 * FULL upgrade: it started the `gsd-postgres` container, applied 30 migrations
 * to it, replaced the launchd-managed daemon with a detached one on the wrong
 * backend, and exited 1.
 *
 * Nothing here spawns a container, a daemon or a service: every case either
 * exits before any step runs, or only prints help. No network, no PATH tools.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { homeEnv } = require('./support/home-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');
const BIN_INSTALL = path.join(ROOT, 'bin', 'install.js');
const init = require(BIN_INIT);

/** A hermetic environment: throwaway HOME, no live ports, sqlite pinned. */
function env(home) {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  return Object.assign(e, homeEnv(home), {
    GSD_TEST_MODE: '1',
    AMAUTA_DATA_DIR: path.join(home, 'data'),
    // NOT `$HOME/.claude`: install.js's test-mode guard refuses (exit 0) when the
    // target IS the home config dir, which would mask the exit-2 assertions.
    CLAUDE_CONFIG_DIR: path.join(home, 'cfg', 'claude'),
    GSD_INSTALL_PROJECT_ROOT: path.join(home, 'cfg'),
    GSD_FORCE_SQLITE: '1',
    GSD_AMAUTA_PORT: '0',
    GSD_DAEMON_PORT: '0',
    GSD_RLM_PORT: '0',
    AMAUTA_MEMORY_DATABASE_URL: '',
    GSD_POSTGRES_URL: '',
    AMAUTA_AUTO_BACKUP: 'off',
    GSD_INSTALL_FILES_ONLY: '',
    GSD_SHUNT: '',
    GSD_COMPRESS: '',
  });
}

/**
 * Run one of the two entry points and return its result.
 * @param {string} bin absolute path to init.cjs or install.js
 * @param {string[]} argv arguments
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function run(bin, argv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-flags-'));
  try {
    const r = spawnSync(process.execPath, [bin, ...argv], {
      cwd: ROOT, env: env(home), encoding: 'utf8', timeout: 60000, input: '',
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ─── The pure parser, exhaustively ───────────────────────────────────────────

describe('88-11 unknownArgs', () => {
  const cases = [
    ['no arguments', [], []],
    ['the incident command is now fully known', ['--upgrade', '--files-only', '--enable-shunt'], []],
    ['a value flag consumes its value', ['--backend', 'sqlite'], []],
    ['--tools consumes its comma list', ['--tools', 'claude-code,cursor'], []],
    ['an = form is matched on the name', ['--backend=sqlite'], []],
    ['the -h alias', ['-h'], []],
    ['a typo is reported verbatim', ['--file-only'], ['--file-only']],
    ['a plausible neighbour is still unknown', ['--files_only'], ['--files_only']],
    ['every unknown is reported, in order', ['--a', '--upgrade', '--b'], ['--a', '--b']],
    ['a stray positional is reported', ['upgrade'], ['upgrade']],
    ['a value flag does NOT swallow a following flag name it was given instead of a value',
      ['--tools'], []],
  ];
  for (const [name, argv, expected] of cases) {
    test(name, () => {
      assert.deepEqual(init.unknownArgs(argv), expected);
    });
  }

  test('an unknown flag that merely contains a known one is unknown', () => {
    assert.deepEqual(init.unknownArgs(['--no-files-only']), ['--no-files-only']);
  });
});

// ─── The table is the single source for parser and help ──────────────────────

describe('88-11 one flag table drives the parser and --help', () => {
  test('every flag in the table is accepted by the parser', () => {
    for (const f of init.INIT_FLAGS) {
      const argv = f.takesValue ? [f.flag, 'x'] : [f.flag];
      assert.deepEqual(init.unknownArgs(argv), [], `${f.flag} must be accepted`);
      for (const alias of f.aliases || []) {
        assert.deepEqual(init.unknownArgs([alias]), [], `${alias} must be accepted`);
      }
    }
  });

  test('every flag in the table appears in --help, and --help exits 0', () => {
    const r = run(BIN_INIT, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of init.INIT_FLAGS) {
      assert.ok(r.stdout.includes(f.flag), `--help must document ${f.flag}`);
      for (const alias of f.aliases || []) {
        assert.ok(r.stdout.includes(alias), `--help must document ${alias}`);
      }
    }
  });

  test('every long flag --help prints is one the parser accepts (no documented-only flag)', () => {
    const r = run(BIN_INIT, ['--help']);
    const printed = new Set((r.stdout.match(/(?<![\w-])--[a-z][a-z0-9-]+/g) || []));
    // The prose mentions commands and variables too; only check the ones that
    // appear at the start of an indented option line, which is the table's doing.
    const optionLines = r.stdout.split('\n')
      .map((l) => /^ {2}(--[a-z0-9-]+)(?:, (-\w))?/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
    assert.ok(optionLines.length >= init.INIT_FLAGS.length - 3, `found only ${optionLines.length} option lines`);
    for (const flag of optionLines) {
      assert.deepEqual(init.unknownArgs([flag, 'x']).filter((a) => a === flag), [],
        `--help prints ${flag} but the parser rejects it`);
    }
    assert.ok(printed.has('--files-only'));
  });

  test('--enable-shunt is forwarded to install.js, not swallowed', () => {
    assert.ok(init.INSTALL_PASSTHROUGH_FLAGS.includes('--enable-shunt'),
      'the incident command asked for the shunt and nothing registered it');
    // installerArgs reads process.argv, so assert the passthrough list is what
    // drives it rather than re-spawning: the e2e cover is in the files-only suite.
    assert.deepEqual(init.installerArgs({ filesOnly: true }), ['--files-only']);
    assert.deepEqual(init.installerArgs({ filesOnly: false }, { skipPostgres: true }), ['--skip-postgres']);
  });
});

// ─── Exit 2, nothing done, both entry points ─────────────────────────────────

describe('88-11 an unknown argument exits 2 with nothing done', () => {
  for (const [name, bin, argv, needle] of [
    ['init.cjs, the incident typo', BIN_INIT, ['--upgrade', '--file-only'], '--file-only'],
    ['init.cjs, unknown alone', BIN_INIT, ['--nonsense'], '--nonsense'],
    ['install.js, unknown alone', BIN_INSTALL, ['--nonsense'], '--nonsense'],
    ['install.js, unknown beside a real flag', BIN_INSTALL, ['--claude', '--global', '--nope'], '--nope'],
  ]) {
    test(name, () => {
      const r = run(bin, argv);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`unknown argument: ${needle.replace(/[-]/g, '\\-')}`));
      assert.match(r.stderr, /Nothing was done/);
      // No step ran: the step table header and every FROZEN step name are absent.
      for (const marker of ['Step  ', 'detect_ides', 'install_skills', 'detect_infra',
        'refresh_installed_files', 'Amauta Infrastructure', 'Starting PostgreSQL']) {
        assert.ok(!r.stdout.includes(marker), `"${marker}" must not appear; got:\n${r.stdout}`);
      }
    });
  }

  test('two unknown arguments are both named', () => {
    const r = run(BIN_INIT, ['--one', '--upgrade', '--two']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown arguments: --one, --two/);
  });

  test('a known-but-invalid VALUE is still exit 1, not 2', () => {
    const r = run(BIN_INIT, ['--backend', 'mysql']);
    assert.equal(r.status, 1, `--backend mysql must stay exit 1; got ${r.status}`);
  });
});

// ─── No shipped caller uses an unknown flag ──────────────────────────────────

describe('88-11 no caller in the repository passes an unknown flag', () => {
  test("doctor's own recommendation is a valid command", () => {
    const hint = fs.readFileSync(path.join(ROOT, 'services', 'doctor.py'), 'utf8')
      .match(/INSTALL_UPGRADE_HINT = "([^"]+)"/);
    assert.ok(hint, 'INSTALL_UPGRADE_HINT must exist in services/doctor.py');
    const argv = hint[1].split(/\s+/).filter((t) => t.startsWith('-'));
    assert.ok(argv.includes('--files-only'), `the hint lost --files-only: ${hint[1]}`);
    assert.deepEqual(init.unknownArgs(argv), [],
      `doctor recommends flags init.cjs rejects: ${hint[1]}`);
  });

  test('the npm install lifecycle script passes no flag at all', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    const argv = String(scripts.install || '').split(/\s+/).slice(2);
    assert.deepEqual(argv, [], `npm "install" must stay argument-free, got ${JSON.stringify(argv)}`);
  });
});
