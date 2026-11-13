'use strict';
/**
 * A test process that starts a REAL daemon WITHOUT the fixture and leaves it
 * running (plan 89-15). Deliberately NOT named *.test.cjs, so the default test
 * glob never runs it; tests/89-15-process-registry.test.cjs drives it through
 * scripts/run-tests.cjs.
 *
 * It is the shape of a daemon started through a product path — a CLI that
 * auto-starts one, the installer's daemon step — under the run's own
 * environment. No fixture registers it. The daemon registers ITSELF
 * (tests/support/pythonpath/sitecustomize.py, which every Python child of a run
 * loads), so the runner must list it as a stray, name this file as the one it
 * was started under, stop it, and fail the run.
 *
 * The daemon runs in test mode on an ephemeral port over a throw-away data
 * directory, exactly as a fixture daemon does. This file prints
 * `PRODUCT_PID=<pid> PRODUCT_DATA=<dir>` once the daemon has announced its
 * port, and exits.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const platform = require(path.join(REPO, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-product-path-'));
const env = { ...process.env };
for (const k of ['GSD_POSTGRES_URL', 'DATABASE_URL', 'REDIS_URL', 'GSD_SQLITE_PATH', 'GSD_DATA_DIR']) delete env[k];
Object.assign(env, {
  GSD_TEST_MODE: '1',
  GSD_AMAUTA_PORT: '0',
  GSD_DAEMON_PORT: '0',
  GSD_FORCE_SQLITE: '1',
  GSD_BACKEND: 'sqlite',
  AMAUTA_DATA_DIR: dataDir,
  AMAUTA_AUTO_BACKUP: 'off',
  GSD_REDIS_ENABLED: 'false',
  GSD_RLM_ENABLED: 'false',
});

const outFile = path.join(dataDir, 'daemon.out');
const out = fs.openSync(outFile, 'a');
// The call a product CLI makes (get-shit-done/bin/gsd-amauta.cjs `startDaemon`):
// detached, no pipe back, so the daemon outlives this process on every platform.
const child = platform.launchPython([path.join(REPO, 'services', 'amauta-daemon.py'), 'run'], {
  detached: true,
  stdio: ['ignore', out, out],
  env,
});
child.unref();

const deadline = Date.now() + 60000;
const timer = setInterval(() => {
  let text = '';
  try {
    text = fs.readFileSync(outFile, 'utf8');
  } catch (_e) {
    /* not written yet */
  }
  if (!/^DAEMON_PORT=\d+$/m.test(text) && Date.now() < deadline) return;
  clearInterval(timer);
  const line = 'PRODUCT_PID=' + child.pid + ' PRODUCT_DATA=' + dataDir + '\n';
  fs.writeSync(1, line);
  fs.writeSync(2, line);
  process.exit(0);
}, 100);
