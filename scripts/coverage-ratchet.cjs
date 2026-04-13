#!/usr/bin/env node
'use strict';
/**
 * scripts/coverage-ratchet.cjs
 *
 * Reads c8 coverage-summary.json, compares against .coverage_threshold.json,
 * fails if coverage regressed below threshold, auto-increments if coverage improved.
 *
 * Exit codes:
 *   0 — coverage at or above threshold (threshold may have been auto-incremented)
 *   1 — coverage below threshold (regression detected)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUMMARY_PATH = path.join(ROOT, 'coverage', 'coverage-summary.json');
const THRESHOLD_PATH = path.join(ROOT, '.coverage_threshold.json');

function round1(n) {
  return Math.round(n * 10) / 10;
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function main() {
  // Step 1: Check coverage-summary.json exists
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.error('coverage-summary.json not found — run:');
    console.error('  npx c8 --reporter json-summary node scripts/run-tests.cjs');
    process.exit(1);
  }

  // Step 2: Read current coverage from c8 output
  let summary;
  try {
    summary = readJSON(SUMMARY_PATH);
  } catch (err) {
    console.error('Failed to parse coverage-summary.json:', err.message);
    process.exit(1);
  }

  const totalLines = summary.total && summary.total.lines && summary.total.lines.pct;
  const totalBranches = summary.total && summary.total.branches && summary.total.branches.pct;

  if (typeof totalLines !== 'number' || typeof totalBranches !== 'number') {
    console.error('coverage-summary.json missing total.lines.pct or total.branches.pct');
    console.error('Keys found in total:', summary.total ? Object.keys(summary.total) : 'none');
    process.exit(1);
  }

  const currentLines = round1(totalLines);
  const currentBranches = round1(totalBranches);

  // Step 3: Bootstrap .coverage_threshold.json if it does not exist
  if (!fs.existsSync(THRESHOLD_PATH)) {
    const bootstrapLines = Math.max(0, round1(currentLines - 5));
    const bootstrapBranches = Math.max(0, round1(currentBranches - 5));
    const bootstrapData = {
      lines: bootstrapLines,
      branches: bootstrapBranches,
      timestamp: new Date().toISOString(),
    };
    writeJSON(THRESHOLD_PATH, bootstrapData);
    console.log(`Bootstrap: created .coverage_threshold.json with {lines: ${bootstrapLines}, branches: ${bootstrapBranches}}`);
    console.log(`Current coverage: lines ${currentLines}%, branches ${currentBranches}%`);
    process.exit(0);
  }

  // Step 4: Read existing threshold
  let threshold;
  try {
    threshold = readJSON(THRESHOLD_PATH);
  } catch (err) {
    console.error('Failed to parse .coverage_threshold.json:', err.message);
    process.exit(1);
  }

  if (typeof threshold.lines !== 'number' || typeof threshold.branches !== 'number') {
    console.error('.coverage_threshold.json missing lines or branches (must be numbers)');
    process.exit(1);
  }

  const thresholdLines = threshold.lines;
  const thresholdBranches = threshold.branches;

  // Step 5: Compare
  const linesFailed = currentLines < thresholdLines;
  const branchesFailed = currentBranches < thresholdBranches;

  if (linesFailed || branchesFailed) {
    if (linesFailed) {
      console.error(`FAIL: lines coverage ${currentLines}% < threshold ${thresholdLines}% (delta: ${round1(currentLines - thresholdLines)}%)`);
    }
    if (branchesFailed) {
      console.error(`FAIL: branches coverage ${currentBranches}% < threshold ${thresholdBranches}% (delta: ${round1(currentBranches - thresholdBranches)}%)`);
    }
    process.exit(1);
  }

  // Step 6: Auto-increment if coverage improved
  const linesImproved = currentLines > thresholdLines;
  const branchesImproved = currentBranches > thresholdBranches;

  if (linesImproved || branchesImproved) {
    const updatedData = {
      lines: currentLines,
      branches: currentBranches,
      timestamp: new Date().toISOString(),
    };
    writeJSON(THRESHOLD_PATH, updatedData);
    const linesDelta = linesImproved ? ` lines ${thresholdLines}→${currentLines}%` : '';
    const branchesDelta = branchesImproved ? ` branches ${thresholdBranches}→${currentBranches}%` : '';
    console.log(`Threshold auto-incremented:${linesDelta}${branchesDelta}`);
    process.exit(0);
  }

  // Step 7: At threshold — no change
  console.log(`Coverage at threshold — no change (lines ${currentLines}%, branches ${currentBranches}%)`);
  process.exit(0);
}

main();
