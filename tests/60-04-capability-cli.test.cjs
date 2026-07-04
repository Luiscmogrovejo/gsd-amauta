'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const cliPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-amauta.cjs');

function runCli(args, envOverrides = {}) {
  return spawnSync('node', [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
}

test('capability list --json returns 3 seeded entries with the 3 required fields', () => {
  const result = runCli(['capability', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.entries.length, 3);
  for (const entry of data.entries) {
    assert.ok(entry.auth && entry.auth.method, `entry ${entry.name} missing auth.method`);
    assert.ok(entry.security_class, `entry ${entry.name} missing security_class`);
    assert.ok(entry.target, `entry ${entry.name} missing target`);
  }
});

test('capability list fails loudly on malformed catalog', () => {
  const tmpFile = path.join(os.tmpdir(), `capability-catalog-malformed-${Date.now()}.json`);
  const malformed = {
    catalog_version: '1.1',
    entries: [
      {
        name: 'bad-entry',
        kind: 'curl-endpoint',
        target: 'http://example.internal',
        auth: { method: 'none' },
        // security_class deliberately missing
        owner: 'operator',
        grants: [],
        added_at: '2026-07-03',
        notes: '',
      },
    ],
  };
  fs.writeFileSync(tmpFile, JSON.stringify(malformed), 'utf-8');
  try {
    const result = runCli(['capability', 'list'], { GSD_CAPABILITY_CATALOG_PATH: tmpFile });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /capability_catalog_invalid/);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

test('capability list human table shows all seeded names', () => {
  const result = runCli(['capability', 'list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /amauta-daemon-http/);
  assert.match(result.stdout, /amauta-postgres/);
  assert.match(result.stdout, /amauta-valkey/);
});

test('capability audit exit code is 0 or 2', () => {
  const result = runCli(['capability', 'audit']);
  assert.ok([0, 2].includes(result.status), `unexpected exit code ${result.status}: ${result.stderr}`);
  assert.ok((result.stdout + result.stderr).trim().length > 0, 'expected non-empty output');
});

test('capability add --yes appends to an override catalog', () => {
  const tmpFile = path.join(os.tmpdir(), `capability-catalog-add-${Date.now()}.json`);
  const realCatalogPath = path.resolve(__dirname, '../get-shit-done/config/capability-catalog.json');
  fs.copyFileSync(realCatalogPath, tmpFile);
  try {
    const result = runCli([
      'capability', 'add',
      '--name', 'test-k3s-cluster',
      '--kind', 'k3s',
      '--target', 'https://k3s.internal:6443',
      '--auth-method', 'none',
      '--class', 'read-only',
      '--yes',
    ], { GSD_CAPABILITY_CATALOG_PATH: tmpFile });
    assert.equal(result.status, 0, result.stderr);

    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(written.entries.length, 4);
    const added = written.entries.find((e) => e.name === 'test-k3s-cluster');
    assert.ok(added, 'new entry not found in written catalog');
    assert.deepEqual(
      Object.keys(added),
      ['name', 'kind', 'target', 'auth', 'security_class', 'owner', 'grants', 'added_at', 'notes']
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

test('capability add rejects bad kind', () => {
  const tmpFile = path.join(os.tmpdir(), `capability-catalog-badkind-${Date.now()}.json`);
  const realCatalogPath = path.resolve(__dirname, '../get-shit-done/config/capability-catalog.json');
  fs.copyFileSync(realCatalogPath, tmpFile);
  try {
    const result = runCli([
      'capability', 'add',
      '--name', 'test-bad-kind',
      '--kind', 'http',
      '--target', 'http://example.internal',
      '--auth-method', 'none',
      '--class', 'read-only',
      '--yes',
    ], { GSD_CAPABILITY_CATALOG_PATH: tmpFile });
    assert.equal(result.status, 1);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

test('capability access refuses without --entry/--agent', () => {
  const result = runCli(['capability', 'access']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage/i);
});
