'use strict';
// Tests for lib/model-registry.cjs — the single source of truth for Claude
// model ids (MODL-01 currency, MODL-06 centralization) and the fable→opus
// degradation path (operator directive: "if no fable, back up into the latest
// opus"). Locks the current tier ids so a stale-id regression fails loudly.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const REG = require('../get-shit-done/bin/lib/model-registry.cjs');
const JSON_PATH = path.join(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'model-registry.json');

test('registry json is the single source and lists the current tiers', () => {
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  assert.ok(raw.aliases, 'aliases block present');
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    assert.ok(raw.aliases[tier], `alias ${tier} present`);
  }
});

test('aliases resolve to the CURRENT canonical ids (MODL-01)', () => {
  assert.strictEqual(REG.resolveModelId('sonnet'), 'claude-sonnet-5');
  assert.strictEqual(REG.resolveModelId('haiku'), 'claude-haiku-4-5-20251001');
  assert.strictEqual(REG.resolveModelId('opus'), 'claude-opus-4-8');
  assert.strictEqual(REG.resolveModelId('fable'), 'claude-fable-5');
});

test('no stale claude-sonnet-4-5-20250514 id survives resolution', () => {
  for (const a of ['sonnet', 'haiku', 'opus', 'fable']) {
    assert.notStrictEqual(REG.resolveModelId(a), 'claude-sonnet-4-5-20250514');
  }
});

test('fable degrades to the latest opus when unavailable (per-call opt)', () => {
  assert.strictEqual(REG.resolveModelId('fable', { fableAvailable: false }), 'claude-opus-4-8');
  assert.strictEqual(REG.resolveModelAlias('fable', { fableAvailable: false }), 'opus');
  // available (default) keeps fable
  assert.strictEqual(REG.resolveModelId('fable', { fableAvailable: true }), 'claude-fable-5');
});

test('GSD_FABLE_AVAILABLE=0 forces the fable→opus fallback', () => {
  const prev = process.env.GSD_FABLE_AVAILABLE;
  try {
    process.env.GSD_FABLE_AVAILABLE = '0';
    assert.strictEqual(REG.fableAvailable(), false);
    assert.strictEqual(REG.resolveModelId('fable'), 'claude-opus-4-8');
    process.env.GSD_FABLE_AVAILABLE = 'off';
    assert.strictEqual(REG.resolveModelId('fable'), 'claude-opus-4-8');
  } finally {
    if (prev === undefined) delete process.env.GSD_FABLE_AVAILABLE;
    else process.env.GSD_FABLE_AVAILABLE = prev;
  }
});

test('a concrete id (non-alias) passes through unchanged', () => {
  assert.strictEqual(REG.resolveModelId('claude-opus-4-8'), 'claude-opus-4-8');
  assert.strictEqual(REG.resolveModelId('some-unknown-model'), 'some-unknown-model');
});

test('non-fable aliases never take the fallback path', () => {
  assert.strictEqual(REG.resolveModelId('sonnet', { fableAvailable: false }), 'claude-sonnet-5');
  assert.strictEqual(REG.resolveModelId('haiku', { fableAvailable: false }), 'claude-haiku-4-5-20251001');
});
