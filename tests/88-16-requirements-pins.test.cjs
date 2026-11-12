'use strict';
/**
 * 88-16-07: every Python dependency this repository names is pinned EXACTLY,
 * and the one package that appears in both requirement files agrees with
 * itself.
 *
 * The supply-chain rule is "pin exact versions, no `^` and no `~`". A range on
 * a test dependency is how a green suite turns red overnight on someone else's
 * release; `psycopg2-binary` additionally appears in BOTH files (runtime needs
 * it, and the Node job installs only the dev file), so a drift between the two
 * would mean CI tested a version the product does not ship.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Parse a requirements file into `{name: spec}`, ignoring comments and markers.
 * @param {string} rel path relative to the repository root
 * @returns {Map<string, string>} package name (lower-cased) to the full requirement line
 */
function requirements(rel) {
  const out = new Map();
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const name = line.split(/[=<>!;~\s]/)[0].trim().toLowerCase();
    if (name) out.set(name, line);
  }
  return out;
}

test('88-16-07: requirements-dev.txt pins every package exactly', () => {
  for (const [name, line] of requirements('requirements-dev.txt')) {
    assert.ok(
      /(^|[^=<>!~])==[^=]/.test(line),
      `${name} is not pinned with == in requirements-dev.txt: ${line}`
    );
    assert.ok(!line.includes('~='), `${name} uses a compatible-release range: ${line}`);
    assert.ok(!line.includes('^'), `${name} uses a caret range: ${line}`);
  }
});

test('88-16-07: psycopg2-binary is the same version in both requirement files', () => {
  const dev = requirements('requirements-dev.txt').get('psycopg2-binary');
  const run = requirements('requirements.txt').get('psycopg2-binary');
  assert.ok(dev, 'requirements-dev.txt must pin psycopg2-binary: the Node job installs only that file');
  assert.ok(run, 'requirements.txt must pin psycopg2-binary');
  const version = (spec) => spec.split('==')[1].split(';')[0].trim();
  assert.strictEqual(
    version(dev),
    version(run),
    'psycopg2-binary drifted between requirements.txt and requirements-dev.txt: ' +
      `${run} vs ${dev}. CI would then test a version the product does not ship.`
  );
});

test('88-16-07: the packages the Node tests import are all in requirements-dev.txt', () => {
  const dev = requirements('requirements-dev.txt');
  // Measured causes of skips on master 58a23a5: PyYAML (10 rows), NumPy (2),
  // psycopg2 (3+4). Each must be installable from the one file the Node job reads.
  for (const name of ['pyyaml', 'pydantic', 'numpy', 'psycopg2-binary']) {
    assert.ok(dev.has(name), `requirements-dev.txt must pin ${name}; the Node job installs only that file`);
  }
});

test('88-16-07: the Node CI job installs from the file, not from a loose list', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf-8');
  assert.ok(
    wf.includes('pip install --disable-pip-version-check -r requirements-dev.txt'),
    'the Node job must install the Python packages from requirements-dev.txt so the CI ' +
      "environment and a developer's cannot drift"
  );
});
