#!/usr/bin/env node
'use strict';
/**
 * scripts/rule-of-two-audit.cjs
 *
 * Rule of Two audit: reads all agent .md files and classifies each one with
 * three boolean properties using keyword heuristics:
 *   - reads_untrusted:     agent processes user input, web content, external API responses
 *   - accesses_sensitive:  agent reads/writes credentials, tokens, PG connection strings
 *   - modifies_state:      agent writes to filesystem, database, or git
 *
 * Any agent where ALL THREE properties are true is flagged as a Rule of Two
 * violation (highest-risk: untrusted input + sensitive access + state mutation).
 *
 * Output: JSON to stdout AND to reports/rule-of-two-report.json (if reports/ exists).
 *
 * agents_audited reflects files present at runtime; 17 total when Phases 35-37 complete.
 *
 * Exit 0 always — this is an audit tool, not a blocker.
 *
 * Usage:
 *   node scripts/rule-of-two-audit.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const REPORTS_DIR = path.join(ROOT, 'reports');

// ─────────────────────────────────────────────────────────────────────────────
// Keyword sets for each classification dimension
// ─────────────────────────────────────────────────────────────────────────────

const READS_UNTRUSTED_KEYWORDS = [
  'user input',
  'web content',
  'external api',
  'external API',
  'http response',
  'HTTP response',
  'scrape',
  'research',
  'perplexity',
  'fetch',
  'search results',
  'untrusted',
  'url',
  'URL',
  'web search',
  'context7',
  'external source',
  'external data',
  'web fetch',
  'WebFetch',
  'npm registry',
  'github api',
  'GitHub API',
];

const ACCESSES_SENSITIVE_KEYWORDS = [
  'credentials',
  'token',
  'secret',
  'password',
  'api key',
  'API key',
  'connection string',
  'pg_connect',
  'POSTGRES',
  'postgres',
  'database connection',
  'auth',
  'PG_PASSWORD',
  'pg password',
  'private key',
  'certificate',
  'environment variable',
  'env var',
  '.env',
  'PGPASSWORD',
  'gitleaks',
  'secrets detection',
];

const MODIFIES_STATE_KEYWORDS = [
  'Write tool',
  'Edit tool',
  'git commit',
  'migration',
  'INSERT',
  'UPDATE',
  'DELETE',
  'write to',
  'writes to',
  'database',
  'filesystem',
  'schema change',
  'deploy',
  'create file',
  'creates file',
  'modify file',
  'modifies file',
  'creates new',
  'git add',
  'file system',
  'commit ',
  'push to',
  'pushes to',
  'stores ',
  'persists ',
  'fs.write',
  'writeFile',
  'mkdirSync',
  'creates ',
  'writes ',
];

// ─────────────────────────────────────────────────────────────────────────────
// Classification logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if any keyword from the list appears in the text (case-sensitive).
 * Case-insensitive fallback for keywords that are all-lowercase.
 */
function hasKeyword(text, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.some(kw => {
    // If the keyword is all-lowercase, use case-insensitive match
    if (kw === kw.toLowerCase()) {
      return lowerText.includes(kw.toLowerCase());
    }
    // Otherwise, check both the original and lowercase
    return text.includes(kw) || lowerText.includes(kw.toLowerCase());
  });
}

function classifyAgent(filePath, content) {
  const name = path.basename(filePath, '.md');
  const relFile = path.relative(ROOT, filePath);

  const reads_untrusted = hasKeyword(content, READS_UNTRUSTED_KEYWORDS);
  const accesses_sensitive = hasKeyword(content, ACCESSES_SENSITIVE_KEYWORDS);
  const modifies_state = hasKeyword(content, MODIFIES_STATE_KEYWORDS);

  const rule_of_two_violation = reads_untrusted && accesses_sensitive && modifies_state;

  let remediation = null;
  if (rule_of_two_violation) {
    remediation = [
      'Consider sandboxing or adding a human approval gate for state-modifying operations.',
      'Validate and sanitize all untrusted input before using it in sensitive or state-mutating operations.',
      'Separate the untrusted-input-reading role from the state-mutation role where possible.',
    ].join(' ');
  }

  return {
    name,
    file: relFile,
    reads_untrusted,
    accesses_sensitive,
    modifies_state,
    rule_of_two_violation,
    remediation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  // Collect all *.md files in agents/ excluding the shared/ subdirectory
  let agentFiles;
  try {
    agentFiles = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.md') && !fs.statSync(path.join(AGENTS_DIR, f)).isDirectory())
      .map(f => path.join(AGENTS_DIR, f))
      .sort();
  } catch (err) {
    console.error(`[rule-of-two-audit] Cannot read agents/ directory: ${err.message}`);
    process.exit(0);
  }

  const agents = [];

  for (const filePath of agentFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[rule-of-two-audit] Cannot read ${filePath}: ${err.message}`);
      continue;
    }
    agents.push(classifyAgent(filePath, content));
  }

  const flagged = agents
    .filter(a => a.rule_of_two_violation)
    .map(a => a.name);

  const report = {
    audit_date: new Date().toISOString(),
    // agents_audited reflects files present at runtime; 17 total when Phases 35-37 complete
    agents_audited: agents.length,
    flagged_agents: flagged,
    agents,
  };

  const json = JSON.stringify(report, null, 2);

  // Always print to stdout
  console.log(json);

  // Write to reports/ if the directory exists
  if (fs.existsSync(REPORTS_DIR)) {
    const outPath = path.join(REPORTS_DIR, 'rule-of-two-report.json');
    try {
      fs.writeFileSync(outPath, json, 'utf-8');
    } catch (err) {
      // Non-fatal — stdout is the authoritative output
      process.stderr.write(`[rule-of-two-audit] Warning: could not write report file: ${err.message}\n`);
    }
  }

  process.exit(0);
}

main();
