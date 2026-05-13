'use strict';
/**
 * agent-md-to-yaml.cjs — One-shot agents/*.md → canonical AGENT.yaml converter.
 * Phase 52 / COMPILE-01.
 *
 * Reads existing agents/*.md files (v3.0 standardized 10-section format from
 * Phase 31) and emits canonical YAML under get-shit-done/agents/<name>/AGENT.yaml.
 *
 * USAGE:
 *   node scripts/agent-md-to-yaml.cjs <input.md> <output-dir>
 *   node scripts/agent-md-to-yaml.cjs --batch <input-dir> <output-dir>
 *   node scripts/agent-md-to-yaml.cjs --help
 *
 * Three exported functions (testable):
 *   convert(inputMdPath, outputDir)        — convert single .md to AGENT.yaml
 *   convertBatch(inputDir, outputDir)      — convert all *.md in inputDir
 *   parseAgentFrontmatter(text)            — parse YAML frontmatter text
 *
 * Exported constant:
 *   HEADING_TO_KEY                         — bidirectional {heading: snakeKey} map
 *
 * EXIT CODES:
 *   0 = success
 *   1 = unknown heading / unparseable frontmatter / validation failure
 *   2 = file not found / I/O error
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─── HEADING_TO_KEY — Locked bidirectional map ──────────────────────────────
// 9 human-readable '## ' headings + 1 synthetic metadata key.
// FROZEN (Phase 52 COMPILE-01). Reordering without updating SECTION_KEY_ORDER
// in services/agent_schema.py breaks the round-trip.
//
// Order mirrors SECTION_KEY_ORDER in services/agent_schema.py:
//   role_and_identity, domain_knowledge, patterns_and_practices,
//   workflow_and_process, tools_and_resources, quality_gates,
//   output_format, error_handling, examples, metadata

const HEADING_TO_KEY = {
  'Role & identity':             'role_and_identity',
  'Domain knowledge':            'domain_knowledge',
  'Behavioral rules':            'patterns_and_practices',
  'Tool access & guidance':      'workflow_and_process',
  'Task management':             'tools_and_resources',
  'Security rules':              'quality_gates',
  'Preconditions & constraints': 'output_format',
  'Error handling':              'error_handling',
  'Examples':                    'examples',
  '__metadata_version__':        'metadata',  // synthesized from '## version: 3.0.0' line
};

// Reverse map: snakeKey → heading (used for validation messages + future compiler)
const KEY_TO_HEADING = Object.fromEntries(
  Object.entries(HEADING_TO_KEY).map(([h, k]) => [k, h])
);

// The 10 keys in SECTION_KEY_ORDER declaration order (mirrors services/agent_schema.py)
const SECTION_KEY_ORDER = [
  'role_and_identity',
  'domain_knowledge',
  'patterns_and_practices',
  'workflow_and_process',
  'tools_and_resources',
  'quality_gates',
  'output_format',
  'error_handling',
  'examples',
  'metadata',
];

// ─── parseAgentFrontmatter ────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter text (between the two '---' delimiters) into an object.
 *
 * Handles:
 *   - Scalar values (quoted or unquoted)
 *   - Inline list form: "tools: Read, Write, Edit" (comma-separated)
 *   - Inline bracket list: "tools: [Read, Write]"
 *   - Indented list items: "skills:\n  - gsd-planner-workflow"
 *   - # comment lines and blank lines → skip
 *
 * Mirrors parseFrontmatter in scripts/skill-compiler.cjs.
 *
 * @param {string} text — YAML frontmatter text (without surrounding ---)
 * @returns {Object} parsed frontmatter data
 */
function parseAgentFrontmatter(text) {
  const result = {};
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      let val = m[2].trim();

      if (val === '' || val === '[]') {
        // Collect indented list items
        const items = [];
        let j = i + 1;
        while (j < lines.length && /^\s{2}-\s/.test(lines[j])) {
          items.push(lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, ''));
          j++;
        }
        result[key] = items;
        i = j;
        continue;

      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Inline bracket list
        result[key] = val.slice(1, -1)
          .split(',')
          .map(x => x.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        i++;
        continue;

      } else if (val.includes(',') && key === 'tools') {
        // Comma-separated inline tools field (existing .md format)
        result[key] = val.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
        i++;
        continue;

      } else {
        // Scalar — strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
        i++;
        continue;
      }
    }
    i++;
  }

  return result;
}

// ─── YAML emitter (no external deps) ─────────────────────────────────────────

/**
 * Emit a string value as a YAML block literal '|' with given indent.
 * Appends a trailing newline to the block body to ensure proper YAML.
 *
 * @param {string} value — multi-line string
 * @param {number} indent — number of spaces for each body line
 * @returns {string} YAML representation starting with '|\n...'
 */
function emitBlockLiteral(value, indent) {
  const pad = ' '.repeat(indent);
  const body = String(value || '');
  const lines = body.split('\n');
  // Remove trailing empty lines except keep one trailing newline
  while (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return '|\n' + lines.map(l => pad + l).join('\n') + '\n';
}

/**
 * Emit a YAML scalar — use block literal for multi-line, quoted for single-line.
 *
 * @param {string} value
 * @param {number} indent
 * @returns {string}
 */
function emitScalar(value, indent) {
  const str = String(value || '');
  if (str.includes('\n')) {
    return emitBlockLiteral(str, indent);
  }
  // Single line: use double-quote if it contains special chars, else bare
  if (/[:#{}\[\]|>&*!,?@`]/.test(str) || str.startsWith(' ') || str.endsWith(' ')) {
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return str;
}

/**
 * Emit a YAML list of strings as indented block-sequence form.
 *
 * @param {string[]} items
 * @param {number} indent — indent for each list item
 * @returns {string}
 */
function emitList(items, indent) {
  if (!items || items.length === 0) return '[]\n';
  const pad = ' '.repeat(indent);
  return '\n' + items.map(item => `${pad}- ${item}`).join('\n') + '\n';
}

/**
 * Build the canonical AGENT.yaml content string from parsed components.
 *
 * Output structure:
 *   frontmatter:
 *     name: ...
 *     description: "..."
 *     tools:
 *       - Read
 *       ...
 *     color: ...
 *     memory: ...
 *     skills:
 *       - ...
 *
 *   body_preamble: |
 *     # Agent: <name>
 *
 *   sections:
 *     role_and_identity: |
 *       ...
 *     ... (10 keys in SECTION_KEY_ORDER order)
 *
 * @param {Object} fm — parsed frontmatter object
 * @param {string|null} bodyPreamble — captured preamble text or null
 * @param {Object} sections — {key: body} for all 10 SECTION_KEY_ORDER keys
 * @returns {string} canonical YAML content
 */
function buildAgentYaml(fm, bodyPreamble, sections) {
  const lines = [];

  lines.push('frontmatter:');
  lines.push(`  name: ${fm.name}`);

  // description: always double-quoted
  const desc = String(fm.description || '');
  lines.push(`  description: "${desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

  // tools: indented list
  const tools = Array.isArray(fm.tools) ? fm.tools : [];
  lines.push('  tools:');
  for (const t of tools) {
    lines.push(`    - ${t}`);
  }

  lines.push(`  color: ${fm.color || ''}`);
  lines.push(`  memory: ${fm.memory || ''}`);

  // skills: indented list
  const skills = Array.isArray(fm.skills) ? fm.skills : [];
  lines.push('  skills:');
  for (const s of skills) {
    lines.push(`    - ${s}`);
  }

  lines.push('');

  // body_preamble
  if (bodyPreamble && String(bodyPreamble).trim()) {
    lines.push('body_preamble: ' + emitBlockLiteral(String(bodyPreamble).trimEnd() + '\n', 2).trimEnd());
    lines.push('');
  } else {
    lines.push('body_preamble: null');
    lines.push('');
  }

  // sections in SECTION_KEY_ORDER
  lines.push('sections:');
  for (const key of SECTION_KEY_ORDER) {
    const body = sections[key] || '';
    const bodyStr = String(body).trimEnd();
    if (bodyStr === '') {
      // Emit empty string literal
      lines.push(`  ${key}: ""`);
    } else {
      // Emit block literal
      const blockLines = bodyStr.split('\n');
      lines.push(`  ${key}: |`);
      for (const bl of blockLines) {
        lines.push(`    ${bl}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

// ─── convert ─────────────────────────────────────────────────────────────────

/**
 * Convert a single agents/*.md file to canonical AGENT.yaml.
 *
 * Creates <outputDir>/<name>/AGENT.yaml (mkdir -p).
 *
 * @param {string} inputMdPath — path to source .md file
 * @param {string} outputDir — base output directory
 * @param {Object} [opts] — options
 * @param {boolean} [opts.dryRun=false] — parse and validate but do not write
 * @returns {{ name: string, outputPath: string, frontmatter: Object, bodyPreamble: string|null, sections: Object }}
 * @throws {Error} on unknown heading, parse failure, or I/O error
 */
function convert(inputMdPath, outputDir, opts) {
  const dryRun = (opts && opts.dryRun) || false;

  // ── Read source .md ──
  let content;
  try {
    content = fs.readFileSync(inputMdPath, 'utf8');
  } catch (err) {
    const e = new Error(`I/O error reading ${inputMdPath}: ${err.message}`);
    e.code = 'IO_ERROR';
    throw e;
  }

  // ── Split frontmatter ──
  // Frontmatter is between first two '---' delimiters.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`No valid YAML frontmatter found in ${inputMdPath}`);
  }
  const fmText = fmMatch[1];
  const afterFm = fmMatch[2];

  // ── Parse frontmatter ──
  const fm = parseAgentFrontmatter(fmText);
  if (!fm.name) {
    throw new Error(`Missing 'name' field in frontmatter of ${inputMdPath}`);
  }
  // Normalize tools: may be a string (comma-separated) or already an array
  if (typeof fm.tools === 'string') {
    fm.tools = fm.tools.split(/\s*,\s*/).map(t => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(fm.skills)) {
    fm.skills = [];
  }

  // ── Capture body_preamble ──
  // Text between closing '---' and first '## ' heading.
  // Trim trailing whitespace but preserve the H1 line(s) verbatim.
  const firstHeadingIdx = afterFm.search(/^## /m);
  let bodyPreamble = null;
  let bodyWithSections = afterFm;

  if (firstHeadingIdx > 0) {
    const preambleRaw = afterFm.slice(0, firstHeadingIdx);
    const trimmed = preambleRaw.trim();
    if (trimmed) {
      bodyPreamble = trimmed + '\n';
    }
    bodyWithSections = afterFm.slice(firstHeadingIdx);
  } else if (firstHeadingIdx === 0) {
    bodyWithSections = afterFm;
  }

  // ── Split into sections on '## ' headings ──
  // Each chunk: heading line + body until next '## ' or EOF.
  const rawSections = bodyWithSections.split(/^(?=## )/m).filter(Boolean);

  const sections = {};
  let hasVersionLine = false;

  for (const chunk of rawSections) {
    // First line is the heading
    const headingLineEnd = chunk.indexOf('\n');
    const headingLine = headingLineEnd >= 0 ? chunk.slice(0, headingLineEnd) : chunk;
    const body = headingLineEnd >= 0 ? chunk.slice(headingLineEnd + 1) : '';

    // Strip the '## ' prefix
    const headingText = headingLine.replace(/^## /, '').trim();

    // Check for version line: "version: 3.0.0" (or "version: X.Y.Z")
    if (/^version:\s*\d+\.\d+\.\d+/.test(headingText)) {
      sections['metadata'] = headingText + '\n';
      hasVersionLine = true;
      continue;
    }

    // Look up heading in HEADING_TO_KEY map
    const sectionKey = HEADING_TO_KEY[headingText];
    if (!sectionKey) {
      const e = new Error(
        `Unknown heading "## ${headingText}" in ${inputMdPath}. ` +
        `Known headings: ${Object.keys(HEADING_TO_KEY).filter(h => h !== '__metadata_version__').join(', ')}`
      );
      e.code = 'UNKNOWN_HEADING';
      throw e;
    }

    sections[sectionKey] = body;
  }

  // Ensure metadata section exists (synthesized from version line)
  if (!hasVersionLine && !sections['metadata']) {
    sections['metadata'] = 'version: 3.0.0\n';
  }

  // Ensure all 10 section keys are present
  for (const key of SECTION_KEY_ORDER) {
    if (!(key in sections)) {
      sections[key] = '';
    }
  }

  // ── Build YAML output ──
  const yamlContent = buildAgentYaml(fm, bodyPreamble, sections);

  // ── Write output ──
  const agentName = fm.name;
  const agentOutDir = path.join(outputDir, agentName);
  const outputPath = path.join(agentOutDir, 'AGENT.yaml');

  if (!dryRun) {
    try {
      fs.mkdirSync(agentOutDir, { recursive: true });
      fs.writeFileSync(outputPath, yamlContent, 'utf8');
    } catch (err) {
      const e = new Error(`I/O error writing ${outputPath}: ${err.message}`);
      e.code = 'IO_ERROR';
      throw e;
    }
  }

  return {
    name: agentName,
    outputPath,
    frontmatter: fm,
    bodyPreamble,
    sections,
    yamlContent,
  };
}

// ─── convertBatch ─────────────────────────────────────────────────────────────

/**
 * Convert all *.md files in inputDir (immediate depth only, not recursive).
 * Subdirectories (like agents/changelog/, agents/shared/) are skipped.
 *
 * @param {string} inputDir — directory containing *.md files (e.g. agents/)
 * @param {string} outputDir — base output directory (e.g. get-shit-done/agents/)
 * @param {Object} [opts] — options passed to convert()
 * @returns {{ converted: number, errors: Array<{file: string, error: string}>, results: Array }}
 */
function convertBatch(inputDir, outputDir, opts) {
  let entries;
  try {
    entries = fs.readdirSync(inputDir, { withFileTypes: true });
  } catch (err) {
    const e = new Error(`I/O error reading directory ${inputDir}: ${err.message}`);
    e.code = 'IO_ERROR';
    throw e;
  }

  const mdFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(inputDir, e.name));

  const results = [];
  const errors = [];

  for (const mdPath of mdFiles) {
    try {
      const result = convert(mdPath, outputDir, opts);
      results.push(result);
    } catch (err) {
      errors.push({ file: mdPath, error: err.message, code: err.code });
    }
  }

  return {
    converted: results.length,
    errors,
    results,
  };
}

// ─── Module exports ────────────────────────────────────────────────────────────

module.exports = { convert, convertBatch, parseAgentFrontmatter, HEADING_TO_KEY };

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  function usage() {
    console.log([
      'Usage:',
      '  node scripts/agent-md-to-yaml.cjs <input.md> <output-dir>',
      '  node scripts/agent-md-to-yaml.cjs --batch <input-dir> <output-dir>',
      '  node scripts/agent-md-to-yaml.cjs --help',
      '',
      'Options:',
      '  --batch       Convert all *.md files in input-dir (non-recursive)',
      '  --dry-run     Parse and validate but do not write output files',
      '  --help, -h    Show this help message',
      '',
      'Exit codes:',
      '  0 = success',
      '  1 = unknown heading / parse failure / validation error',
      '  2 = file not found / I/O error',
    ].join('\n'));
  }

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const filteredArgs = args.filter(a => a !== '--dry-run');

  if (filteredArgs[0] === '--batch') {
    // Batch mode: --batch <input-dir> <output-dir>
    const inputDir = filteredArgs[1];
    const outputDir = filteredArgs[2];
    if (!inputDir || !outputDir) {
      console.error('Error: --batch requires <input-dir> and <output-dir>');
      usage();
      process.exit(1);
    }

    let batchResult;
    try {
      batchResult = convertBatch(inputDir, outputDir, { dryRun });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(err.code === 'IO_ERROR' ? 2 : 1);
    }

    console.log(`Converted ${batchResult.converted} agents.`);
    if (batchResult.errors.length > 0) {
      for (const e of batchResult.errors) {
        console.error(`  FAIL [${e.code || 'ERR'}] ${path.basename(e.file)}: ${e.error}`);
      }
      process.exit(1);
    }

  } else {
    // Single mode: <input.md> <output-dir>
    const inputMd = filteredArgs[0];
    const outputDir = filteredArgs[1];
    if (!inputMd || !outputDir) {
      console.error('Error: requires <input.md> and <output-dir>');
      usage();
      process.exit(1);
    }

    if (!fs.existsSync(inputMd)) {
      console.error(`Error: file not found: ${inputMd}`);
      process.exit(2);
    }

    try {
      const result = convert(inputMd, outputDir, { dryRun });
      console.log(`Converted: ${result.name} -> ${result.outputPath}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(err.code === 'IO_ERROR' ? 2 : 1);
    }
  }
}
