'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const toolsPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-tools.cjs');
const { loadCapabilityCatalog } = require(toolsPath);

test('loads seeded repo catalog', () => {
  delete process.env.GSD_CAPABILITY_CATALOG_PATH;
  const catalog = loadCapabilityCatalog(true);

  assert.equal(catalog.entries.length, 3);
  for (const entry of catalog.entries) {
    assert.ok(entry.auth.method, `entry ${entry.name} missing auth.method`);
    assert.ok(entry.security_class, `entry ${entry.name} missing security_class`);
    assert.ok(entry.target, `entry ${entry.name} missing target`);
  }

  const names = catalog.entries.map((e) => e.name);
  assert.ok(names.includes('amauta-daemon-http'));
  assert.ok(names.includes('amauta-postgres'));
  assert.ok(names.includes('amauta-valkey'));
});

test('env override wins', () => {
  const tmpFile = path.join(os.tmpdir(), `capability-catalog-override-${Date.now()}.json`);
  const override = {
    catalog_version: '1.1',
    entries: [
      {
        name: 'override-entry',
        kind: 'curl-endpoint',
        target: 'http://127.0.0.1:1',
        auth: { method: 'none' },
        security_class: 'read-only',
        owner: 'operator',
        grants: [],
        added_at: '2026-07-03',
        notes: '',
      },
    ],
  };
  fs.writeFileSync(tmpFile, JSON.stringify(override), 'utf-8');

  try {
    process.env.GSD_CAPABILITY_CATALOG_PATH = tmpFile;
    const catalog = loadCapabilityCatalog(true);
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.entries[0].name, 'override-entry');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    delete process.env.GSD_CAPABILITY_CATALOG_PATH;
    loadCapabilityCatalog(true);
  }
});

test('missing file yields empty catalog', () => {
  try {
    process.env.GSD_CAPABILITY_CATALOG_PATH = '/nonexistent/never-here.json';
    const catalog = loadCapabilityCatalog(true);
    assert.deepEqual(catalog, { catalog_version: '1.1', entries: [] });
  } finally {
    delete process.env.GSD_CAPABILITY_CATALOG_PATH;
    loadCapabilityCatalog(true);
  }
});

test('never contains secret values', () => {
  delete process.env.GSD_CAPABILITY_CATALOG_PATH;
  const catalog = loadCapabilityCatalog(true);

  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /"(token|password|secret_value)"/);

  for (const entry of catalog.entries) {
    const authKeys = Object.keys(entry.auth);
    for (const key of authKeys) {
      assert.ok(['method', 'env', 'key_ref'].includes(key), `unexpected auth key: ${key}`);
    }
  }
});
