#!/usr/bin/env node
'use strict';
/**
 * Prefix stability audit — Phase 23 / CACHE-01.
 * Validates all 11 agent .md files have correct stable-prefix / variable-suffix structure.
 *
 * Usage: node scripts/audit-prefix-stability.cjs
 * Exit 0: all agents pass. Exit 1: violations found.
 */
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const BREAKPOINT_MARKER = '<!-- CACHE_BREAKPOINT -->';

// Volatile patterns that must NOT appear before breakpoint
const VOLATILE_PATTERNS = [
  { re: /datetime\.now\(\)/gi, name: 'datetime.now()' },
  { re: /time\.time\(\)/gi, name: 'time.time()' },
  { re: /Date\.now\b/g, name: 'Date.now' },
  { re: /new Date\(/g, name: 'new Date(' },
  { re: /Math\.random\(\)/g, name: 'Math.random()' },
  { re: /crypto\.randomUUID/g, name: 'crypto.randomUUID' },
];

// Required structural elements that MUST appear before breakpoint
const REQUIRED_BEFORE = [
  { tag: '<role>', name: 'ROLE_BEFORE_BREAKPOINT' },
  { tag: '<patterns>', name: 'PATTERNS_BEFORE_BREAKPOINT' },
];

// Tags that should appear AFTER breakpoint if present at all
const SHOULD_BE_AFTER = ['<runtime_read>', '<enrichment>', '<dynamic>'];

/**
 * Find line number (1-based) where pattern first matches in text.
 * Returns null if not found.
 */
function findLineNumber(text, pattern) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      pattern.lastIndex = 0;
      return i + 1;
    }
    pattern.lastIndex = 0;
  }
  return null;
}

/**
 * Audit a single agent file.
 * Returns { name, filePath, passed, checks }
 * Each check: { id, passed, message }
 */
function auditAgent(filePath) {
  const name = path.basename(filePath);
  const checks = [];

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      name,
      filePath,
      passed: false,
      checks: [{ id: 'FILE_READABLE', passed: false, message: `Cannot read file: ${err.message}` }],
    };
  }

  // --- Check 1: BREAKPOINT_EXISTS ---
  const breakpointCount = (content.split(BREAKPOINT_MARKER).length - 1);
  if (breakpointCount === 0) {
    checks.push({
      id: 'BREAKPOINT_EXISTS',
      passed: false,
      message: 'missing CACHE_BREAKPOINT marker',
    });
    // Cannot do further positional checks without a breakpoint — report and return
    const passed = checks.every(c => c.passed);
    return { name, filePath, passed, checks };
  }
  if (breakpointCount > 1) {
    checks.push({
      id: 'BREAKPOINT_EXISTS',
      passed: false,
      message: `found ${breakpointCount} CACHE_BREAKPOINT markers (expected exactly 1)`,
    });
  } else {
    checks.push({ id: 'BREAKPOINT_EXISTS', passed: true, message: 'exactly 1 CACHE_BREAKPOINT marker' });
  }

  // Split content on first breakpoint
  const breakpointIdx = content.indexOf(BREAKPOINT_MARKER);
  const prefix = content.slice(0, breakpointIdx);
  const suffix = content.slice(breakpointIdx + BREAKPOINT_MARKER.length);

  // --- Check 2: NO_VOLATILE_BEFORE_BREAKPOINT ---
  let volatileViolation = null;
  for (const { re, name: patName } of VOLATILE_PATTERNS) {
    re.lastIndex = 0;
    const lineNum = findLineNumber(prefix, re);
    re.lastIndex = 0;
    if (lineNum !== null) {
      volatileViolation = `found "${patName}" at line ${lineNum}`;
      break;
    }
  }
  checks.push({
    id: 'NO_VOLATILE_BEFORE_BREAKPOINT',
    passed: volatileViolation === null,
    message: volatileViolation || 'no volatile patterns in prefix',
  });

  // --- Check 3: FRONTMATTER_BEFORE_BREAKPOINT ---
  // YAML frontmatter starts with --- at top of file
  const hasFrontmatter = /^---/.test(prefix.trimStart());
  checks.push({
    id: 'FRONTMATTER_BEFORE_BREAKPOINT',
    passed: hasFrontmatter,
    message: hasFrontmatter ? 'YAML frontmatter found in prefix' : 'YAML frontmatter missing from prefix',
  });

  // --- Checks 4 & 5: REQUIRED_BEFORE (role, patterns) ---
  for (const { tag, name: checkName } of REQUIRED_BEFORE) {
    const found = prefix.includes(tag);
    checks.push({
      id: checkName,
      passed: found,
      message: found ? `${tag} found in prefix` : `${tag} missing from prefix`,
    });
  }

  // --- Check 6: VARIABLE_AFTER_BREAKPOINT ---
  // If any variable tag exists anywhere, it must appear only in the suffix (not the prefix)
  let variableViolation = null;
  for (const tag of SHOULD_BE_AFTER) {
    const inPrefix = prefix.includes(tag);
    if (inPrefix) {
      variableViolation = `${tag} appears before CACHE_BREAKPOINT (should be in suffix)`;
      break;
    }
  }
  checks.push({
    id: 'VARIABLE_AFTER_BREAKPOINT',
    passed: variableViolation === null,
    message: variableViolation || 'no variable tags in prefix (correct)',
  });

  const passed = checks.every(c => c.passed);
  return { name, filePath, passed, checks };
}

function main() {
  console.log('Prefix Stability Audit — Phase 23 / CACHE-01');
  console.log('================================================');

  // Discover agent files
  let agentFiles;
  try {
    agentFiles = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md'))
      .sort()
      .map(f => path.join(AGENTS_DIR, f));
  } catch (err) {
    console.error(`ERROR: Cannot read agents directory: ${err.message}`);
    process.exit(1);
  }

  if (agentFiles.length === 0) {
    console.error('ERROR: No gsd-*.md files found in agents/');
    process.exit(1);
  }

  const results = agentFiles.map(auditAgent);
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.filter(r => !r.passed).length;

  // Print per-agent results
  const colWidth = Math.max(...results.map(r => r.name.length)) + 4;
  for (const result of results) {
    const checksPassed = result.checks.filter(c => c.passed).length;
    const checksTotal = result.checks.length;
    const label = result.passed ? '[PASS]' : '[FAIL]';
    const namePadded = result.name.padEnd(colWidth);
    console.log(`${label} ${namePadded} ${checksPassed}/${checksTotal} checks`);

    // Print failed check details
    for (const check of result.checks) {
      if (!check.passed) {
        console.log(`  FAIL: ${check.id} — ${check.message}`);
      }
    }
  }

  console.log('================================================');
  console.log(`Result: ${passCount}/${results.length} PASSED, ${failCount}/${results.length} FAILED`);

  process.exit(failCount > 0 ? 1 : 0);
}

main();
