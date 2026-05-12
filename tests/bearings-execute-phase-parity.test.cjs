'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const shardedPath = path.resolve(repoRoot, 'get-shit-done', 'workflows', 'execute-phase', 'steps', 'step-01-prepare.md');
const legacyPath  = path.resolve(repoRoot, 'get-shit-done', 'workflows', 'execute-phase-legacy.md');
const toolsCmd    = path.resolve(repoRoot, 'get-shit-done', 'bin', 'gsd-tools.cjs');

test('step-01-prepare.md and execute-phase-legacy.md both shell out to gsd-tools bearings --terse --token-budget 400', () => {
  const sharded = fs.readFileSync(shardedPath, 'utf8');
  const legacy  = fs.readFileSync(legacyPath, 'utf8');
  const expected = 'gsd-tools.cjs" bearings --terse --token-budget 400';
  assert.ok(sharded.includes(expected), 'step-01-prepare.md must shell out to bearings with --terse --token-budget 400');
  assert.ok(legacy.includes(expected),  'execute-phase-legacy.md must shell out to bearings with --terse --token-budget 400');
});

test('Two consecutive invocations of bearings --terse --token-budget 400 produce identical Current Position section', () => {
  const run1 = spawnSync('node', [toolsCmd, 'bearings', '--terse', '--token-budget', '400'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  const run2 = spawnSync('node', [toolsCmd, 'bearings', '--terse', '--token-budget', '400'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.strictEqual(run1.status, 0, `run1 exited with status ${run1.status}; stderr: ${run1.stderr}`);
  assert.strictEqual(run2.status, 0, `run2 exited with status ${run2.status}; stderr: ${run2.stderr}`);

  const extractCurrent = (s) => {
    const m = s.match(/## Current Position\n([\s\S]*?)(?=\n## |\n=== END)/);
    return m ? m[1].trim() : '';
  };

  const c1 = extractCurrent(run1.stdout);
  const c2 = extractCurrent(run2.stdout);
  assert.ok(c1.length > 0, 'Current Position section not found in run1 stdout');
  assert.strictEqual(c1, c2, 'Current Position must be byte-identical across two invocations (HELP-01 determinism)');
});

test('Legacy 4-slot Python heredoc is no longer present in execute-phase-legacy.md', () => {
  const legacy = fs.readFileSync(legacyPath, 'utf8');
  assert.ok(!legacy.includes('Slot 1: feature_list summary'), 'Slot 1 heredoc must be removed from execute-phase-legacy.md');
  assert.ok(!legacy.includes('import json, os, sys, glob'), 'Python heredoc imports must be removed from execute-phase-legacy.md');
});
