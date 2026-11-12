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

const INSTALL = path.resolve(__dirname, '..', 'bin', 'install.js');
let tmp, bin, calls;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-files-only-'));
  bin = path.join(tmp, 'bin');
  calls = path.join(tmp, 'calls.log');
  fs.mkdirSync(bin);
  for (const name of ['docker', 'python3']) {
    const p = path.join(bin, name);
    // --version must succeed so the installer believes the tool exists.
    fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${calls}"\necho "${name} 1.0"\nexit 0\n`);
    fs.chmodSync(p, 0o755);
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
      PATH: bin + path.delimiter + process.env.PATH,
      ...homeEnv(path.join(tmp, 'home-' + name)),
      GSD_INSTALL_FILES_ONLY: '',
      GSD_TEST_MODE: '', // the runner's GSD_TEST_MODE=1 makes install.js skip its main block
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
