'use strict';
/**
 * Per-process pact output directory (Phase 88, plan 88-07).
 *
 * All five contracts in tests/pact/ use the consumer/provider pair gsd-tools -> amauta-daemon, so they
 * all merge into the same pacts/gsd-tools-amauta-daemon.json. The runner, tests 33 and 38 each start
 * them, so several processes read-modify-write that one file at the same time (the pact library even
 * logs "Existing pact is an older specification version (V3), and will be upgraded" on every merge).
 * Nothing in the repository reads the generated file, so each process gets its own directory and
 * removes it on exit. GSD_PACT_DIR overrides it (the directory is then left alone).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @returns {string} an absolute directory the calling process owns for its pact output
 */
function pactDir() {
  if (process.env.GSD_PACT_DIR) return process.env.GSD_PACT_DIR;
  const dir = path.join(os.tmpdir(), 'gsd-pacts-' + process.pid);
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
  return dir;
}

module.exports = { pactDir };
