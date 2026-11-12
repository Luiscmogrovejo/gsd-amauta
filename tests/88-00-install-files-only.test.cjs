'use strict';

/**
 * install.js used to start Docker containers and the daemon at the end of
 * every install, including `--opencode` into a custom config dir. --files-only
 * (and any install without Claude Code) must touch files only.
 *
 * Runs the real installer as a child process with a fake `docker` and
 * `python3` first on PATH that record every invocation.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { homeEnv } = require('./support/home-env.cjs');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const INSTALL = path.resolve(__dirname, '..', 'bin', 'install.js');
let tmp, bin, calls;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-files-only-'));
  bin = path.join(tmp, 'bin');
  calls = path.join(tmp, 'calls.log');
  fs.mkdirSync(bin);
  for (const name of ['docker', 'python3']) {
    // --version must succeed so the installer believes the tool exists. Node body: one program,
    // a shebang file on POSIX and a .cmd shim on Windows (same output as the old `echo "$name $*"`).
    writeFakeExe(bin, name, { node: [
      `require('fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');`,
      `console.log(${JSON.stringify(name)} + ' 1.0');`,
    ].join('\n') });
  }
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(args, name) {
  const configDir = path.join(tmp, name);
  fs.rmSync(calls, { force: true });
  const r = spawnSync(process.execPath, [INSTALL, ...args, '--global', '--config-dir', configDir], {
    encoding: 'utf8',
    timeout: 120000,
    input: '',
    env: Object.assign({}, process.env, {
      PATH: prependPath([bin]),
      ...homeEnv(path.join(tmp, 'home-' + name)),
      GSD_INSTALL_FILES_ONLY: '',
      GSD_TEST_MODE: '', // the runner's GSD_TEST_MODE=1 makes install.js skip its main block
      // ...and clearing it also clears the test-mode default for the one file
      // the installer writes into the PROJECT rather than the config dir.
      // Without this the spawn inherits cwd = the repository root and rewrites
      // the TRACKED .mcp.json — invisible on a machine whose resolved Python is
      // the committed one, caught on CI where GSD_PYTHON is an absolute path
      // (plan 88-15 found it on Windows; plan 88-16-07 found the writer).
      GSD_INSTALL_PROJECT_ROOT: configDir,
      GSD_SHUNT: '', GSD_COMPRESS: '',
    }),
  });
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  return { r, log, configDir };
}

const started = (log) => /docker compose|docker start|docker run|amauta-daemon\.py/.test(log);

test('--files-only installs files and starts nothing', () => {
  const { r, log, configDir } = run(['--claude', '--files-only'], 'claude-files-only');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(configDir, 'get-shit-done', 'VERSION')), 'files must be installed');
  assert.ok(fs.existsSync(path.join(configDir, 'gsd-file-manifest.json')), 'manifest must still be written');
  assert.equal(started(log), false, `nothing may be started, got:\n${log}`);
  assert.match(r.stdout, /Skipped infrastructure setup \(--files-only\)/);
});

test('an OpenCode-only install starts nothing', () => {
  const { r, log, configDir } = run(['--opencode'], 'opencode-only');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(configDir), 'config dir must be populated');
  assert.equal(started(log), false, `nothing may be started, got:\n${log}`);
  assert.match(r.stdout, /no Claude Code runtime selected/);
});

test('help documents the flag', () => {
  const r = spawnSync(process.execPath, [INSTALL, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /--files-only/);
});
