/**
 * Phase 88 plan 88-12 task 05: every AGENT.yaml under get-shit-done/agents/ parses.
 *
 * gsd-auditor-mobile/AGENT.yaml once ended with two stray tool-call tag lines
 * (`</content>`, `</invoke>`), so PyYAML failed ("while scanning a simple key") and
 * the A2A registry silently skipped the agent. PyYAML is what the registry uses,
 * so PyYAML is the parser here.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'get-shit-done', 'agents');

// Phase 88 plan 88-16-06: this file carried a SECOND copy of the fixture
// daemon's `pythonBin()`, with the same macOS-only Homebrew preference — and
// that preference is precisely why this test skipped on the macOS cell and
// nowhere else: `/opt/homebrew/bin/python3` is not the `setup-python`
// interpreter the workflow installs PyYAML into. One resolver now, the shared
// one, which honours GSD_PYTHON first and VERIFIES each candidate by running it.
const platform = require('../get-shit-done/bin/lib/platform.cjs');

const HAS_PYYAML = platform.spawnPython(['-c', 'import yaml'], { stdio: 'ignore' }).status === 0;
const SKIP_NO_PYYAML = HAS_PYYAML
  ? false
  : 'PyYAML is not importable from the resolved Python interpreter in this environment';

/** @returns {string[]} absolute paths of every agents/<name>/AGENT.yaml */
function agentYamlFiles() {
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(AGENTS_DIR, d.name, 'AGENT.yaml')))
    .map((d) => path.join(AGENTS_DIR, d.name, 'AGENT.yaml'))
    .sort();
}

describe('88-12 every AGENT.yaml parses', () => {
  test('the glob finds the roster (a glob that matches nothing must fail)', () => {
    assert.ok(agentYamlFiles().length >= 30, 'found only ' + agentYamlFiles().length + ' AGENT.yaml files');
  });

  test('no AGENT.yaml fails to parse with PyYAML', { skip: SKIP_NO_PYYAML }, () => {
    const bad = [];
    for (const file of agentYamlFiles()) {
      const r = platform.spawnPython(['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]).read())', file], {
        encoding: 'utf8',
      });
      if (r.status !== 0) {
        const lines = (r.stderr || '').trim().split('\n').filter(Boolean);
        const errLine = lines.find((l) => /Error/.test(l)) || lines[lines.length - 1] || 'exit ' + r.status;
        bad.push(path.relative(ROOT, file) + ': ' + errLine);
      }
    }
    assert.deepStrictEqual(bad, [], 'unparseable AGENT.yaml files:\n' + bad.join('\n'));
  });
});
