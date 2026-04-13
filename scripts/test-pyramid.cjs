#!/usr/bin/env node
'use strict';
/**
 * scripts/test-pyramid.cjs
 *
 * Counts test files by naming convention and reports the test pyramid ratio.
 * Outputs JSON to stdout; human-readable summary to stderr.
 *
 * Naming conventions counted:
 *   unit:        *.unit.test.cjs / *.unit.test.js / *.unit.test.ts
 *   integration: *.integration.test.cjs / *.integration.test.js / *.integration.test.ts
 *   e2e:         *.e2e.test.cjs / *.e2e.test.js / *.e2e.test.ts
 *   other:       remaining *.test.cjs / *.test.js (legacy naming — excluded from pyramid ratio)
 *
 * pyramid_valid: true if (e2e / pyramidTotal) <= E2E_CEILING (0.25) OR pyramidTotal === 0
 *
 * Exit codes:
 *   0 — pyramid valid (E2E <= 25% of pyramidTotal)
 *   1 — pyramid invalid (E2E > 25% of pyramidTotal)
 */
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');
const E2E_CEILING = 0.25;

function pct(n, total) {
  if (total === 0) return '0.0%';
  return (Math.round((n / total) * 1000) / 10).toFixed(1) + '%';
}

function classifyFile(filename) {
  if (/\.unit\.test\.(cjs|js|ts)$/.test(filename)) return 'unit';
  if (/\.integration\.test\.(cjs|js|ts)$/.test(filename)) return 'integration';
  if (/\.e2e\.test\.(cjs|js|ts)$/.test(filename)) return 'e2e';
  if (/\.test\.(cjs|js|ts)$/.test(filename)) return 'other';
  return null;
}

function main() {
  if (!fs.existsSync(TESTS_DIR)) {
    process.stderr.write(`Error: tests directory not found at ${TESTS_DIR}\n`);
    process.exit(1);
  }

  let allEntries;
  try {
    allEntries = fs.readdirSync(TESTS_DIR);
  } catch (err) {
    process.stderr.write(`Error reading tests directory: ${err.message}\n`);
    process.exit(1);
  }

  const counts = { unit: 0, integration: 0, e2e: 0, other: 0 };

  for (const entry of allEntries) {
    const fullPath = path.join(TESTS_DIR, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;

    const category = classifyFile(entry);
    if (category) counts[category]++;
  }

  const pyramidTotal = counts.unit + counts.integration + counts.e2e;
  const total = pyramidTotal + counts.other;

  const e2ePct = pyramidTotal === 0 ? 0 : counts.e2e / pyramidTotal;
  const pyramid_valid = pyramidTotal === 0 || e2ePct <= E2E_CEILING;

  const result = {
    unit: counts.unit,
    unitPct: pct(counts.unit, pyramidTotal),
    integration: counts.integration,
    integrationPct: pct(counts.integration, pyramidTotal),
    e2e: counts.e2e,
    e2ePct: pct(counts.e2e, pyramidTotal),
    other: counts.other,
    total,
    pyramidTotal,
    pyramid_valid,
  };

  // JSON to stdout (machine-readable)
  process.stdout.write(JSON.stringify(result) + '\n');

  // Human-readable summary to stderr
  const status = pyramid_valid
    ? 'VALID'
    : `INVALID (E2E ${pct(counts.e2e, pyramidTotal)} > ${Math.round(E2E_CEILING * 100)}% ceiling)`;

  process.stderr.write(`Test Pyramid Analysis:\n`);
  process.stderr.write(`  Unit:        ${String(counts.unit).padStart(3)}  (${result.unitPct})\n`);
  process.stderr.write(`  Integration: ${String(counts.integration).padStart(3)}  (${result.integrationPct})\n`);
  process.stderr.write(`  E2E:         ${String(counts.e2e).padStart(3)}  (${result.e2ePct})\n`);
  process.stderr.write(`  Other:       ${String(counts.other).padStart(3)}  (not in pyramid)\n`);
  process.stderr.write(`  Status: ${status}\n`);

  process.exit(pyramid_valid ? 0 : 1);
}

main();
