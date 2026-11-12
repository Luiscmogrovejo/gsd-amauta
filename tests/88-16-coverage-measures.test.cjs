'use strict';
/**
 * The coverage ratchet must MEASURE on the platform it runs on.
 *
 * Plan 88-15 found that the Windows cells reported 0% for every file: the c8
 * configuration lived in the `test:coverage` npm script as command-line flags
 * with SINGLE-QUOTED globs, npm runs a script through `cmd.exe`, and cmd does
 * not strip single quotes — so c8 received a literal `'get-shit-done/bin/lib/*.cjs'`
 * that matched nothing. The ratchet then failed on a summary with no
 * `total.lines.pct`, and nobody saw it because the test step failed first and
 * the ratchet step never ran. 88-15 moved the configuration into `.c8rc.json`.
 *
 * Plan 88-16 was handed "make it measure, or state it explicitly, with a test".
 * This is the test, and it is a MEASUREMENT, not a source inspection: it runs
 * c8 for real on this platform, into a temp report directory, and asserts the
 * include glob resolved to real files with real percentages. An assertion about
 * the TEXT of `.c8rc.json` could not have caught the original defect either —
 * the text was fine, the shell was not.
 *
 * @module tests/88-16-coverage-measures
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

describe('[88-16] the coverage ratchet measures on this platform', () => {
  it('the c8 configuration is a file, and no glob carries a shell quote', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.c8rc.json'), 'utf-8'));
    assert.ok(Array.isArray(cfg.include) && cfg.include.length > 0, '.c8rc.json must declare include globs');
    for (const glob of [...cfg.include, ...(cfg.exclude || [])]) {
      assert.ok(
        !/['"]/.test(glob),
        'a quote inside a c8 glob is the Windows defect 88-15 fixed: ' + JSON.stringify(glob)
      );
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const script = pkg.scripts['test:coverage'];
    assert.ok(script, 'package.json must keep a test:coverage script');
    assert.ok(
      !/['"]/.test(script),
      'test:coverage must carry no quoted argument: cmd.exe does not strip them. Got: ' + script
    );
  });

  it('c8 really produces a non-zero summary here, with the included files in it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-c8-measure-'));
    try {
      const r = spawnSync(
        process.execPath,
        [
          path.join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js'),
          '--check-coverage=false',
          '--reporter=json-summary',
          '--report-dir=' + path.join(tmp, 'report'),
          '--temp-directory=' + path.join(tmp, 'tmp'),
          process.execPath,
          '-e',
          'require("./get-shit-done/bin/lib/platform.cjs")',
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: 120000 }
      );
      const summaryPath = path.join(tmp, 'report', 'coverage-summary.json');
      assert.ok(
        fs.existsSync(summaryPath),
        'c8 wrote no coverage-summary.json (status ' + r.status + ')\n' +
          '--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '')
      );
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

      assert.strictEqual(
        typeof (summary.total && summary.total.lines && summary.total.lines.pct),
        'number',
        'the ratchet reads total.lines.pct; a summary without it is what the Windows cells produced'
      );
      assert.strictEqual(typeof summary.total.branches.pct, 'number');

      const files = Object.keys(summary).filter((k) => k !== 'total');
      assert.ok(
        files.length >= 5,
        'the include glob matched ' + files.length + ' file(s); on the broken Windows configuration it matched none'
      );

      // The file this child actually loaded must show real line coverage. This is
      // the part a 0%-for-everything run could not satisfy.
      const loaded = files.filter((f) => f.replace(/\\/g, '/').endsWith('get-shit-done/bin/lib/platform.cjs'));
      assert.strictEqual(loaded.length, 1, 'platform.cjs must appear once in the summary; got ' + loaded.length);
      assert.ok(
        summary[loaded[0]].lines.pct > 0,
        'platform.cjs was loaded by the measured child, so its line coverage cannot be 0%'
      );
      assert.ok(summary.total.lines.pct > 0, 'total line coverage cannot be 0% when a file was executed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
