#!/usr/bin/env node
/**
 * eval-runner.cjs — Code-based eval scenario runner for gsd-amauta v3.0
 *
 * Reads all eval JSON files from tests/evals/*.json, executes each code-based
 * scenario by grepping the specified file for the pattern, and reports pass/fail.
 *
 * Usage: node tests/evals/eval-runner.cjs
 * Exit 0: all scenarios pass. Exit 1: any scenario fails.
 *
 * Grader types:
 *   code-based  — IMPLEMENTED in v3.0 (this file)
 *   model-based — DOCUMENTED in grader-schemas.json, v3.1 implementation
 *   human       — DOCUMENTED in grader-schemas.json, v3.1 implementation
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVALS_DIR = path.resolve(__dirname);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ─── Load all eval JSON files from tests/evals/ ──────────────────────────────

const evalFiles = fs.readdirSync(EVALS_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('grader-'))
  .sort();

if (evalFiles.length === 0) {
  console.error('[eval-runner] No eval JSON files found in tests/evals/');
  process.exit(1);
}

// ─── Execute code-based grader ────────────────────────────────────────────────

function gradeCodeBased(scenario) {
  const { file_to_check, pattern_to_grep, expected_match } = scenario.grading_criteria;

  const filePath = path.resolve(PROJECT_ROOT, file_to_check);

  // File existence check
  if (!fs.existsSync(filePath)) {
    return {
      passed: false,
      reason: `file_to_check not found: ${file_to_check}`,
    };
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // Pattern match using RegExp (supports basic regex in pattern_to_grep)
  let matched;
  try {
    const re = new RegExp(pattern_to_grep);
    matched = re.test(content);
  } catch (_) {
    // Fallback to literal string search if regex is invalid
    matched = content.includes(pattern_to_grep);
  }

  const passed = matched === expected_match;
  const reason = passed
    ? `pattern "${pattern_to_grep}" ${matched ? 'found' : 'not found'} in ${file_to_check} (expected: ${expected_match})`
    : `pattern "${pattern_to_grep}" ${matched ? 'found' : 'not found'} in ${file_to_check} (expected: ${expected_match})`;

  return { passed, reason };
}

// ─── Main runner ──────────────────────────────────────────────────────────────

let total = 0;
let passed = 0;
let failed = 0;
const results = [];

for (const evalFile of evalFiles) {
  const evalPath = path.join(EVALS_DIR, evalFile);
  let evalData;
  try {
    evalData = JSON.parse(fs.readFileSync(evalPath, 'utf-8'));
  } catch (err) {
    console.error(`[eval-runner] Failed to parse ${evalFile}: ${err.message}`);
    process.exit(1);
  }

  for (const scenario of (evalData.scenarios || [])) {
    total++;

    if (scenario.grader_type === 'code-based') {
      const result = gradeCodeBased(scenario);
      if (result.passed) {
        passed++;
      } else {
        failed++;
      }
      results.push({
        id: scenario.id,
        agent: scenario.agent,
        passed: result.passed,
        reason: result.reason,
      });
    } else if (scenario.grader_type === 'model-based' || scenario.grader_type === 'human') {
      // Not implemented in v3.0 — documented in grader-schemas.json for v3.1
      console.log(`[eval-runner] [skip] ${scenario.id}: grader_type="${scenario.grader_type}" is not implemented until v3.1`);
      total--;
    } else {
      failed++;
      results.push({
        id: scenario.id,
        agent: scenario.agent,
        passed: false,
        reason: `Unknown grader_type: ${scenario.grader_type}`,
      });
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const summary = { total, passed, failed, results };

console.log('\n=== Eval Runner Results ===');
console.log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
console.log('');

for (const r of results) {
  const status = r.passed ? 'PASS' : 'FAIL';
  const marker = r.passed ? '[+]' : '[!]';
  console.log(`${marker} ${status}  ${r.id} (${r.agent})`);
  if (!r.passed) {
    console.log(`    Reason: ${r.reason}`);
  }
}

console.log('');
if (failed === 0) {
  console.log(`All ${passed}/${total} code-based eval scenarios passed.`);
} else {
  console.log(`${failed} eval scenario(s) failed. See above for details.`);
}

// Exit 0 if all pass, exit 1 if any fail
process.exit(failed > 0 ? 1 : 0);
