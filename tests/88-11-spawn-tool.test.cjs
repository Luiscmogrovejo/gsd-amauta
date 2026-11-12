'use strict';
/**
 * `platform.spawnTool` — one spawn form for every external tool, on every platform.
 *
 * Plan 88-11 (B1). Plan 88-17 built the `cmd.exe /d /s /c` form for the host
 * runtime CLI and paid a CI round to learn that `/s` strips the FIRST and LAST
 * quote of the string after `/c`. Plan 88-16 had meanwhile parked three
 * fake-semgrep tests with a Windows skip, because `scripts/skill-semgrep-runner.cjs`
 * spawned a bare `semgrep` with `shell: false` and the hermetic fake is a `.cmd`
 * shim that current Node refuses to spawn that way (CVE-2024-27980 hardening).
 *
 * The form is now shared, and this file pins it:
 *
 *  - the `.cmd` branch is exercised FOR REAL on the Windows cells (case 4 writes
 *    a real `.cmd` shim and round-trips argv through it) and by platform
 *    injection everywhere else, so the branch is covered on all nine cells;
 *  - the `/s` outer quote pair is asserted on the literal argv handed to cmd.exe;
 *  - `shell: true` appears nowhere — asserted against the helper's own source,
 *    because that is the substitute a future edit would reach for;
 *  - a value that cannot be placed safely THROWS instead of being escaped.
 *
 * @module tests/88-11-spawn-tool
 */

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platform = require('../get-shit-done/bin/lib/platform.cjs');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const WIN_TARGET = 'C:\\Users\\x\\AppData\\npm\\semgrep.cmd';

/** A spawn stand-in that records its call and reports success. */
function recorder(calls) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
}

describe('[88-11] spawnTool: the cmd.exe branch', () => {
  it('routes a .cmd target through cmd.exe /d /s /c with the outer quote pair', () => {
    const calls = [];
    const diag = {};
    platform.spawnTool(
      { command: WIN_TARGET },
      ['--config', '.semgrep/skill-enforcement.yml', '--json', '--quiet', 'D:\\a\\gsd\\skills'],
      {
        platform: 'win32',
        spawn: recorder(calls),
        diag,
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        encoding: 'utf8',
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(calls[0].opts.windowsVerbatimArguments, true,
      'without verbatim arguments Node re-quotes the line and the /s arithmetic breaks');
    assert.equal(calls[0].opts.shell, undefined, 'shell:true reopens CVE-2024-27980');

    const line = calls[0].args[3];
    // `/s` removes the first and last quote, so what cmd.exe parses is the INNER line.
    assert.equal(line[0], '"');
    assert.equal(line[line.length - 1], '"');
    assert.equal(line.slice(1, -1), diag.commandLine, 'diag reports the inner line');
    assert.equal(
      diag.commandLine,
      '"C:\\Users\\x\\AppData\\npm\\semgrep.cmd" --config .semgrep/skill-enforcement.yml '
      + '--json --quiet D:\\a\\gsd\\skills',
    );
    assert.equal(diag.spawnForm, 'cmd.exe /d /s /c');
  });

  it('spawns a non-shim target directly, with no cmd.exe anywhere', () => {
    const calls = [];
    const diag = {};
    platform.spawnTool({ command: '/usr/local/bin/semgrep' }, ['--version'], {
      platform: 'linux',
      spawn: recorder(calls),
      diag,
      encoding: 'utf8',
    });
    assert.equal(calls[0].command, '/usr/local/bin/semgrep');
    assert.deepEqual(calls[0].args, ['--version']);
    assert.equal(calls[0].opts.windowsVerbatimArguments, undefined);
    assert.equal(diag.spawnForm, 'direct');
    assert.equal(diag.commandLine, null);
  });

  it('a .cmd on a POSIX platform is spawned directly — the branch is the platform, not the suffix', () => {
    const calls = [];
    platform.spawnTool({ command: '/opt/weird/tool.cmd' }, [], {
      platform: 'linux',
      spawn: recorder(calls),
    });
    assert.equal(calls[0].command, '/opt/weird/tool.cmd');
  });
});

describe('[88-11] spawnTool: what may reach a cmd.exe command line', () => {
  test('a bare-safe token is emitted bare', () => {
    assert.equal(platform.quoteCmdArg('--output-format'), '--output-format');
    assert.equal(platform.quoteCmdArg('D:\\a\\gsd-amauta'), 'D:\\a\\gsd-amauta');
    assert.equal(platform.quoteCmdArg(''), '""');
  });

  test('a token with a space is quoted, not refused', () => {
    assert.equal(platform.quoteCmdArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  });

  test('trailing backslashes before the closing quote are doubled', () => {
    // '"C:\\a b\\"' would reach the child argv parser as `C:\a b"`.
    assert.equal(platform.quoteCmdArg('C:\\a b\\'), '"C:\\a b\\\\"');
  });

  test('a quote or a percent is refused rather than escaped', () => {
    for (const bad of ['a " b', 'a %PATH% b', 'a\nb']) {
      assert.throws(() => platform.quoteCmdArg(bad), /allowlist-safe/, JSON.stringify(bad));
    }
  });

  test('a cmd metacharacter survives only inside quotes, and never unquoted', () => {
    assert.equal(platform.quoteCmdArg('a&b'), '"a&b"');
    const line = platform.buildCmdLine(WIN_TARGET, ['a&b']);
    assert.ok(!/ a&b$/.test(line), `a metacharacter reached the line unquoted: ${line}`);
  });

  test('an unquotable target path is refused', () => {
    assert.throws(() => platform.buildCmdLine('C:\\a"b\\t.cmd', []), /refusing to build/);
  });

  test('the helper never uses a shell', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'platform.cjs'),
      'utf8',
    );
    const body = src.slice(src.indexOf('function spawnTool('));
    assert.ok(!/shell\s*:\s*true/.test(body), 'spawnTool must never pass shell: true');
  });
});

describe('[88-11] spawnTool: resolved and run for real on this platform', () => {
  it('finds a PATH-resolved fake and round-trips argv through it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-spawntool-'));
    try {
      // On Windows this writes `gsdfaketool.cmd` — the exact shape that used to
      // be unspawnable, so this case IS the Windows proof.
      writeFakeExe(dir, 'gsdfaketool', {
        node: 'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
      });
      const env = { ...process.env, PATH: prependPath([dir]) };
      const diag = {};
      const args = ['--json', 'plain', 'with space', 'D:\\a\\gsd-amauta'];
      const r = platform.spawnTool('gsdfaketool', args, { env, encoding: 'utf8', diag });

      assert.equal(r.status, 0, `status ${r.status}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), args,
        'every argument must arrive at the child unchanged');
      assert.equal(
        diag.spawnForm,
        process.platform === 'win32' ? 'cmd.exe /d /s /c' : 'direct',
        'the Windows cells must take the cmd.exe branch, the others the direct one',
      );
      assert.ok(diag.target && diag.target.includes('gsdfaketool'),
        `the tool must be resolved to a path, got ${diag.target}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing tool through the spawn result rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-spawntool-none-'));
    try {
      const env = { ...process.env, PATH: dir };
      const r = platform.spawnTool('gsd-no-such-tool-88-11', ['--version'], {
        env, encoding: 'utf8',
      });
      assert.notEqual(r.status, 0, 'a tool that does not exist cannot report success');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an operator override wins over PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-spawntool-ovr-'));
    try {
      const target = writeFakeExe(dir, 'gsdoverride', {
        node: "process.stdout.write('OVERRIDE');",
      });
      const env = { ...process.env, GSD_FAKE_TOOL: target };
      const r = platform.spawnTool('gsd-not-on-path-at-all', [], {
        env, encoding: 'utf8', envVar: 'GSD_FAKE_TOOL',
      });
      assert.equal(r.status, 0, `status ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, 'OVERRIDE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
