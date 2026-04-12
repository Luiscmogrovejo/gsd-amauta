#!/usr/bin/env node
/**
 * Plan 19-01-02: Regression tests for scanDogfoodLedgerDepths (Phase 19 / SCHEMA-01).
 *
 * Tests use temp-dir fixtures for both sources. No live file mutations.
 *
 * Run: node --test tests/19-ledger-scan.test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { scanDogfoodLedgerDepths } = require(path.join(REPO_ROOT, 'scripts', 'verify-v26.cjs'));

// Helper: build a minimal Markdown ledger table from an array of row specs.
// Each spec: { depth, phase, outcome } — omit phase/outcome to produce a gap row.
function buildLedgerFixture(rows) {
  const header = [
    '| Depth | Phase | Actor | Artifact | Rationalization Named | Outcome |',
    '|-------|-------|-------|----------|----------------------|---------|',
  ];
  const dataRows = rows.map(({ depth, phase, outcome }) => {
    if (!phase) return `| ${depth} | — | — | — | — | Not yet observed |`;
    return `| ${depth} | ${phase} | Actor | Artifact | Rat | ${outcome || 'Caught'} |`;
  });
  return header.concat(dataRows).join('\n') + '\n';
}

// Helper: write a fake dogfood memory file.
function writeMemoryFile(dir, filename, content) {
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

// ── Tier 1: Full union (ledger + memory both available) ───────────────────────

test('Tier 1 happy path: ledger + memory union produces correct depths and gaps', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-t1-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-t1-'));
  try {
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([
      { depth: 0, phase: '13.1 Wave 1' },
      { depth: 1, phase: '13.1 Wave 2' },
      { depth: 2, phase: '13.1 Wave 3' },
      { depth: 3 }, // gap row
      { depth: 4, phase: '13.1 Closeout' },
    ]));
    writeMemoryFile(memTmp, 'project_phase16_dogfood.md', '---\ndescription: Depth 10 dogfood moment\n---\n');
    writeMemoryFile(memTmp, 'project_phase18_dogfood.md', '---\ndescription: something else\n---\n# Phase 18 — Depth 11\n');

    const result = scanDogfoodLedgerDepths(memTmp, ledgerTmp);

    assert.deepEqual(result.depths, [0, 1, 2, 4, 10, 11], 'depths should be union of ledger+memory sorted');
    assert.deepEqual(result.gaps, [3, 5, 6, 7, 8, 9], 'gaps should be {0..max} minus union');
    assert.strictEqual(result.source, 'ledger + memory');
    assert.deepEqual(result.observations, []);
  } finally {
    fs.unlinkSync(ledgerTmp);
    fs.rmSync(memTmp, { recursive: true });
  }
});

test('Tier 1 gap detection: depth 3 row with "Not yet observed" is excluded and appears in gaps', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-t2-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-t2-'));
  try {
    // Depth 3 has "Not yet observed" in Outcome; depths 0,1,2,4 are captured.
    // Gap computation is {0..max=4} \ {0,1,2,4} = {3}, so depth 3 appears in gaps.
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([
      { depth: 0, phase: '13.1 Wave 1' },
      { depth: 1, phase: '13.1 Wave 2' },
      { depth: 2, phase: '13.1 Wave 3' },
      { depth: 3 }, // gap row — em-dash in Phase column
      { depth: 4, phase: '13.1 Closeout' },
    ]));

    const result = scanDogfoodLedgerDepths(memTmp, ledgerTmp);

    assert.ok(!result.depths.includes(3), 'depth 3 must NOT be in depths');
    assert.ok(result.gaps.includes(3), 'depth 3 must be in gaps');
  } finally {
    fs.unlinkSync(ledgerTmp);
    fs.rmSync(memTmp, { recursive: true });
  }
});

test('Tier 1 memory regex: handles "Depth-6" frontmatter and "Depth 7" heading formats', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-t3-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-t3-'));
  try {
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([]));
    writeMemoryFile(memTmp, 'project_phase14_dogfood.md', '---\ndescription: Depth-6 dogfood moment\ntype: project\n---\n');
    writeMemoryFile(memTmp, 'project_phase15_dogfood.md', '---\ndescription: Phase 15 dogfood\n---\n# Phase 15 Ghost Directory Dogfood — Depth 7\n');

    const result = scanDogfoodLedgerDepths(memTmp, ledgerTmp);

    assert.ok(result.depths.includes(6), 'depth 6 (Depth-6 format) must be captured');
    assert.ok(result.depths.includes(7), 'depth 7 (Depth 7 heading format) must be captured');
  } finally {
    fs.unlinkSync(ledgerTmp);
    fs.rmSync(memTmp, { recursive: true });
  }
});

// ── Tier 2: Ledger-only (memory unavailable) ──────────────────────────────────

test('Tier 2: memory dir nonexistent returns ledger depths only with degradation observation', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-t4-${Date.now()}.md`);
  const nonexistentMem = path.join(os.tmpdir(), `nonexistent-mem-${Date.now()}`);
  try {
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([
      { depth: 0, phase: '13.1 Wave 1' },
      { depth: 1, phase: '13.1 Wave 2' },
    ]));

    const result = scanDogfoodLedgerDepths(nonexistentMem, ledgerTmp);

    assert.strictEqual(result.source, 'ledger only');
    assert.ok(result.observations.includes('ledger_scan_degraded: memory_unavailable'), 'must log memory_unavailable');
    assert.deepEqual(result.depths, [0, 1], 'depths must only contain ledger depths');
  } finally {
    fs.unlinkSync(ledgerTmp);
  }
});

// ── Tier 3: Memory-only (ledger unavailable) ──────────────────────────────────

test('Tier 3: ledger file nonexistent returns memory depths only with degradation observation', () => {
  const nonexistentLedger = path.join(os.tmpdir(), `nonexistent-ledger-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-t5-'));
  try {
    writeMemoryFile(memTmp, 'project_phase16_dogfood.md', '---\ndescription: Depth 10\n---\n');
    writeMemoryFile(memTmp, 'project_phase18_dogfood.md', '---\ndescription: Depth 11\n---\n');

    const result = scanDogfoodLedgerDepths(memTmp, nonexistentLedger);

    assert.strictEqual(result.source, 'memory only');
    assert.ok(result.observations.includes('ledger_scan_degraded: ledger_unavailable'), 'must log ledger_unavailable');
    assert.ok(result.depths.includes(10), 'depth 10 must be present');
    assert.ok(result.depths.includes(11), 'depth 11 must be present');
  } finally {
    fs.rmSync(memTmp, { recursive: true });
  }
});

// ── Tier 4: Static fallback (both unavailable) ────────────────────────────────

test('Tier 4: both sources nonexistent returns static fallback', () => {
  const nonexistentLedger = path.join(os.tmpdir(), `nonexistent-ledger-${Date.now()}.md`);
  const nonexistentMem = path.join(os.tmpdir(), `nonexistent-mem-${Date.now()}`);

  const result = scanDogfoodLedgerDepths(nonexistentMem, nonexistentLedger);

  assert.deepEqual(result.depths, [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(result.gaps, [3]);
  assert.strictEqual(result.source, 'static fallback');
  assert.ok(result.observations.includes('ledger_scan_degraded: both_sources_unavailable'));
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('Edge: empty memory directory — returns ledger depths only, no crash', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-e1-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-e1-'));
  try {
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([
      { depth: 0, phase: '13.1 Wave 1' },
      { depth: 1, phase: '13.1 Wave 2' },
      { depth: 2, phase: '13.1 Wave 3' },
    ]));

    const result = scanDogfoodLedgerDepths(memTmp, ledgerTmp);

    assert.strictEqual(result.source, 'ledger + memory', 'source is still ledger+memory (both dirs reachable)');
    assert.deepEqual(result.depths, [0, 1, 2], 'memory contributed nothing — only ledger depths');
    assert.deepEqual(result.observations, []);
  } finally {
    fs.unlinkSync(ledgerTmp);
    fs.rmSync(memTmp, { recursive: true });
  }
});

test('Edge: no gaps when all depths 0-3 are present across both sources', () => {
  const ledgerTmp = path.join(os.tmpdir(), `ledger-19-e2-${Date.now()}.md`);
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-19-e2-'));
  try {
    fs.writeFileSync(ledgerTmp, buildLedgerFixture([
      { depth: 0, phase: 'Phase A' },
      { depth: 1, phase: 'Phase B' },
      { depth: 2, phase: 'Phase C' },
    ]));
    writeMemoryFile(memTmp, 'project_phase_dogfood.md', '---\ndescription: Depth 3\n---\n');

    const result = scanDogfoodLedgerDepths(memTmp, ledgerTmp);

    assert.deepEqual(result.gaps, [], 'no gaps expected when 0,1,2,3 all present');
    assert.deepEqual(result.depths, [0, 1, 2, 3]);
  } finally {
    fs.unlinkSync(ledgerTmp);
    fs.rmSync(memTmp, { recursive: true });
  }
});
