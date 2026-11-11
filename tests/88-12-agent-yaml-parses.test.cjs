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

/** @returns {string} the python interpreter, same preference order as the fixture daemon */
function pythonBin() {
  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/python3')) return '/opt/homebrew/bin/python3';
  return process.env.GSD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

const PY = pythonBin();
const HAS_PYYAML = spawnSync(PY, ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0;
const SKIP_NO_PYYAML = HAS_PYYAML ? false : 'PyYAML is not installed for python3 in this environment';

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
      const r = spawnSync(PY, ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]).read())', file], {
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
