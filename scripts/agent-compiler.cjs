'use strict';
/**
 * agent-compiler.cjs — One-way agent compiler for Phase 52 / COMPILE-02.
 *
 * Reads canonical AGENT.yaml files from get-shit-done/agents/<name>/AGENT.yaml,
 * applies per-IDE name-map tables, and emits IDE-specific output .md files.
 *
 * Three exported functions (testable):
 *   compile(target, opts)     — compile all agents to an IDE target
 *   validate(agentDir)        — validate a single agent directory
 *   listAgents(source)        — scan source dir and return agent metadata
 *
 * CLI: node scripts/agent-compiler.cjs --target=<ide> [--source=<dir>]
 *                                       [--out=<dir>] [--agent=<name>]
 *                                       [--hydrate=<name>] [--dry-run] [--help]
 *
 * Supported targets: claude-code, opencode, cursor
 *
 * Symmetric with scripts/skill-compiler.cjs (Phase 43).
 * SC1 BYTE-MATCH LOCK: compile('claude-code') output is byte-identical to
 * agents/*.md committed at HEAD 21438ae.
 */

const fs = require('node:fs');
const path = require('node:path');

// ─── HOOKS_COMMENT_BLOCK ─────────────────────────────────────────────────────
// Verbatim commented hooks block emitted for claude-code target agents that had
// this block in their pre-Phase-52 agents/*.md frontmatter.
//
// SC1 BYTE-MATCH NOTE: The Wave 1 converter (agent-md-to-yaml.cjs) did not
// capture the hooks comment block into AGENT.yaml (comment lines skipped by
// the frontmatter parser). To achieve byte-for-byte round-trip from YAML → .md,
// the compiler uses the AGENTS_WITH_HOOKS set below as a compensating lookup.
// This set is locked per HEAD 21438ae and must be updated if new agents are
// added that include the hooks block, or if existing agents remove it.

const HOOKS_COMMENT_BLOCK = `# hooks:
#   PostToolUse:
#     - matcher: "Write|Edit"
#       hooks:
#         - type: command
#           command: "npx eslint --fix $FILE 2>/dev/null || true"`;

// Agents that have the hooks comment block in their claude-code frontmatter.
// Locked per HEAD 21438ae (Wave 1 conversion reference).
const AGENTS_WITH_HOOKS = new Set([
  'gsd-debugger',
  'gsd-executor-backend',
  'gsd-executor-frontend',
  'gsd-executor-general',
  'gsd-executor-infra',
  'gsd-operator',
  'gsd-planner',
  'gsd-roadmapper',
]);

// Agents whose description field appears UNQUOTED in the claude-code agents/*.md.
// Locked per HEAD 21438ae. The Wave 1 converter normalized all descriptions to
// double-quoted form in AGENT.yaml; the compiler must emit the original form for
// these agents to achieve byte-match.
const AGENTS_WITH_UNQUOTED_DESCRIPTION = new Set([
  'gsd-roadmapper',
]);

// ─── Target name-map tables ───────────────────────────────────────────────────

const TARGET_MAPS = {
  'claude-code': {
    ide_id: 'claude-code',
    dir_name: '.claude',
    agent_subdir: 'agents',
    frontmatter_aliases: {
      // claude-code uses canonical field names as-is
      'name': 'name',
      'description': 'description',
      'tools': 'tools',
      'color': 'color',
      'memory': 'memory',
      'skills': 'skills',
    },
    tool_aliases: {
      // claude-code uses canonical tool names (identity)
      'Read': 'Read', 'Edit': 'Edit', 'Write': 'Write', 'Grep': 'Grep',
      'Glob': 'Glob', 'Bash': 'Bash', 'Task': 'Task',
      'WebFetch': 'WebFetch', 'WebSearch': 'WebSearch',
    },
    extra_fields: {},
    // claude-code emits tools as a comma-separated inline string (the existing
    // agents/*.md format), NOT a YAML block list. SC1 byte-match requires this.
    tools_inline: true,
  },
  'opencode': {
    ide_id: 'opencode',
    dir_name: '.opencode',
    agent_subdir: 'agents',
    frontmatter_aliases: {
      'name': 'name',
      'description': 'description',
      'tools': 'tools',
      'color': 'color',
      'memory': 'memory',
      'skills': 'skills',
    },
    tool_aliases: {
      // opencode uses Title-case (identity for now)
      'Read': 'Read', 'Edit': 'Edit', 'Write': 'Write', 'Grep': 'Grep',
      'Glob': 'Glob', 'Bash': 'Bash', 'Task': 'Task',
      'WebFetch': 'WebFetch', 'WebSearch': 'WebSearch',
    },
    extra_fields: { compatibility: 'opencode' },
    tools_inline: false,
  },
  'cursor': {
    ide_id: 'cursor',
    dir_name: '.cursor',
    agent_subdir: 'rules',
    frontmatter_aliases: {
      // cursor uses camelCase frontmatter
      'name': 'name',
      'description': 'description',
      'tools': 'allowedTools',
      'color': 'color',
      'memory': 'memory',
      'skills': 'skills',
    },
    tool_aliases: {
      // cursor uses snake_case tool names
      'Read': 'read_file', 'Edit': 'edit_file', 'Write': 'write_file',
      'Grep': 'grep', 'Glob': 'glob', 'Bash': 'bash', 'Task': 'task',
      'WebFetch': 'web_fetch', 'WebSearch': 'web_search',
    },
    extra_fields: {},
    tools_inline: false,
  },
};

const SUPPORTED_TARGETS = Object.keys(TARGET_MAPS);

// ─── SECTION_KEY_TO_HEADING ───────────────────────────────────────────────────
// Maps canonical YAML section key (snake_case) → Markdown heading (human-readable).
// Phase 52 SC1 byte-match lock REQUIRES these exact heading strings to match the
// pre-Phase-52 agents/*.md committed at HEAD 21438ae. DO NOT change without
// bumping a major schema version.

const SECTION_KEY_TO_HEADING = {
  'role_and_identity':       'Role & identity',
  'domain_knowledge':        'Domain knowledge',
  'patterns_and_practices':  'Behavioral rules',
  'workflow_and_process':    'Tool access & guidance',
  'tools_and_resources':     'Task management',
  'quality_gates':           'Security rules',
  'output_format':           'Preconditions & constraints',
  'error_handling':          'Error handling',
  'examples':                'Examples',
  // 'metadata' is special — emitted as "## version: 3.0.0" comment line, NOT a
  // normal section heading. Handled by emitSections() inline.
};

const SECTION_KEY_ORDER = [
  'role_and_identity', 'domain_knowledge', 'patterns_and_practices',
  'workflow_and_process', 'tools_and_resources', 'quality_gates',
  'output_format', 'error_handling', 'examples', 'metadata',
];

// For Phase 52 SC1 byte-match: existing agents/*.md emits sections in this
// OBSERVED ORDER (different from SECTION_KEY_ORDER). Locked per HEAD 21438ae.
const SECTION_EMIT_ORDER = [
  'metadata',               // emits "## version: 3.0.0" first
  'role_and_identity',
  'domain_knowledge',
  'patterns_and_practices', // "## Behavioral rules"
  'workflow_and_process',   // "## Tool access & guidance"
  'tools_and_resources',    // "## Task management"
  'examples',
  'error_handling',
  'quality_gates',          // "## Security rules"
  'output_format',          // "## Preconditions & constraints"
];

// ─── Platform codes loader (mirrors skill-compiler.cjs) ───────────────────────

/**
 * Load the platform-codes.yaml IDE registry.
 * Returns {} on any error — compiler falls back to hard-coded TARGET_MAPS values.
 */
function loadPlatformCodes(refPath) {
  let yamlPath;
  if (refPath && typeof refPath === 'string') {
    yamlPath = refPath;
  } else if (process.env.PLATFORM_CODES_YAML) {
    yamlPath = process.env.PLATFORM_CODES_YAML;
  } else {
    yamlPath = path.resolve(__dirname, '../get-shit-done/references/platform-codes.yaml');
  }

  let raw;
  try {
    raw = fs.readFileSync(yamlPath, 'utf8');
  } catch (_e) {
    return {};
  }

  const result = {};
  let inIdes = false;
  let currentIde = null;

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

    if (/^ides:\s*$/.test(trimmed)) {
      inIdes = true;
      continue;
    }

    if (!inIdes) continue;

    const ideMatch = trimmed.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (ideMatch) {
      currentIde = ideMatch[1];
      result[currentIde] = { ide_id: currentIde, dir_name: '', agent_subdir: '', cli_name: '' };
      continue;
    }

    if (currentIde) {
      const fieldMatch = trimmed.match(/^    ([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (fieldMatch) {
        const key = fieldMatch[1];
        let val = fieldMatch[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[currentIde][key] = val;
      }
    }
  }

  return result;
}

// ─── Apply yaml overrides to TARGET_MAPS at module-load time ─────────────────

const _platformCodes = loadPlatformCodes();
for (const [ideId, codes] of Object.entries(_platformCodes)) {
  if (TARGET_MAPS[ideId]) {
    TARGET_MAPS[ideId].dir_name = codes.dir_name || TARGET_MAPS[ideId].dir_name;
    TARGET_MAPS[ideId].cli_name = codes.cli_name;
  }
}

// ─── AGENT.yaml parser ────────────────────────────────────────────────────────

/**
 * Parse canonical AGENT.yaml content into structured data.
 *
 * Handles the specific shape produced by scripts/agent-md-to-yaml.cjs:
 *   frontmatter:           (2-space indented scalar/list fields)
 *     name: ...
 *     description: "..."
 *     tools:               (indented list)
 *       - Read
 *       ...
 *     color: ...
 *     memory: ...
 *     skills:
 *       - ...
 *
 *   body_preamble: |       (block literal or 'null')
 *     # Agent: <name>
 *
 *   sections:
 *     role_and_identity: | (block literal, 4-space indented content)
 *       ...
 *
 * @param {string} yamlText — full AGENT.yaml file content
 * @returns {{ frontmatter: Object, body_preamble: string|null, sections: Object }}
 */
function parseAgentYaml(yamlText) {
  const lines = yamlText.split('\n');
  const frontmatter = {};
  let body_preamble = null;
  const sections = {};

  let i = 0;
  const n = lines.length;

  // ── Parse frontmatter block ──
  // Starts at "frontmatter:" (top-level key)
  while (i < n && !lines[i].startsWith('frontmatter:')) i++;
  i++; // skip "frontmatter:" line

  // Read 2-space indented fields
  while (i < n) {
    const line = lines[i];
    if (!line.startsWith('  ')) break; // end of frontmatter block

    const m = line.match(/^  ([a-zA-Z_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }

    const key = m[1];
    let val = m[2].trim();

    if (val === '' || val === '[]') {
      // Collect 4-space indented list items
      const items = [];
      let j = i + 1;
      while (j < n && lines[j].match(/^    - /)) {
        items.push(lines[j].replace(/^    - /, '').trim().replace(/^["']|["']$/g, ''));
        j++;
      }
      frontmatter[key] = items;
      i = j;
      continue;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      frontmatter[key] = val.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      i++;
      continue;
    } else {
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      frontmatter[key] = val;
      i++;
      continue;
    }
  }

  // ── Skip blank lines between blocks ──
  while (i < n && lines[i].trim() === '') i++;

  // ── Parse body_preamble ──
  if (i < n && lines[i].startsWith('body_preamble:')) {
    const bpVal = lines[i].slice('body_preamble:'.length).trim();
    i++;
    if (bpVal === 'null') {
      body_preamble = null;
    } else if (bpVal === '|') {
      // Block literal — collect 2-space indented lines until non-indented or blank-then-non-indented
      const bpLines = [];
      while (i < n) {
        const l = lines[i];
        if (l.startsWith('  ')) {
          bpLines.push(l.slice(2)); // strip 2-space indent
          i++;
        } else if (l.trim() === '') {
          // Blank line within block literal — preserve
          bpLines.push('');
          i++;
          // But if next non-blank line is not indented, stop
          let k = i;
          while (k < n && lines[k].trim() === '') k++;
          if (k < n && !lines[k].startsWith('  ')) break;
        } else {
          break;
        }
      }
      // Remove trailing empty lines but keep content
      while (bpLines.length > 0 && bpLines[bpLines.length - 1] === '') bpLines.pop();
      body_preamble = bpLines.join('\n') + '\n';
    }
  }

  // ── Skip blank lines ──
  while (i < n && lines[i].trim() === '') i++;

  // ── Parse sections block ──
  if (i < n && lines[i].startsWith('sections:')) {
    i++; // skip "sections:" line

    while (i < n) {
      // Skip blank lines
      if (lines[i].trim() === '') { i++; continue; }
      // Section key at 2-space indent: "  <key>: |" or "  <key>: \"\""
      const sectionMatch = lines[i].match(/^  ([a-zA-Z_]+):\s*(.*)$/);
      if (!sectionMatch) { i++; continue; }

      const sectionKey = sectionMatch[1];
      const sectionVal = sectionMatch[2].trim();
      i++;

      if (sectionVal === '|') {
        // Block literal — collect 4-space indented lines
        const bodyLines = [];
        while (i < n) {
          const l = lines[i];
          if (l.startsWith('    ')) {
            bodyLines.push(l.slice(4)); // strip 4-space indent
            i++;
          } else if (l.trim() === '') {
            // Blank line — could be inside block or between sections
            // Peek ahead: if next non-blank starts with '  ' it's within block
            let k = i + 1;
            while (k < n && lines[k].trim() === '') k++;
            if (k < n && lines[k].startsWith('    ')) {
              // Still inside block
              bodyLines.push('');
              i++;
            } else {
              // End of block
              break;
            }
          } else {
            break;
          }
        }
        // Normalize: remove trailing blank lines, keep exactly one trailing newline
        while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
        sections[sectionKey] = bodyLines.join('\n') + '\n';
      } else if (sectionVal === '""' || sectionVal === '') {
        sections[sectionKey] = '';
      } else {
        // Inline scalar (unquoted or quoted)
        let v = sectionVal;
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        sections[sectionKey] = v;
      }
    }
  }

  return { frontmatter, body_preamble, sections };
}

// ─── Frontmatter emitter ──────────────────────────────────────────────────────

/**
 * Emit YAML frontmatter block for the given target.
 *
 * claude-code format (tools_inline: true):
 *   ---
 *   name: gsd-planner
 *   description: "..."
 *   tools: Read, Write, Edit, ...
 *   color: green
 *   memory: user
 *   skills:
 *     - gsd-planner-workflow
 *   # hooks: ...
 *   ---
 *
 * Other targets (tools_inline: false):
 *   ---
 *   name: ...
 *   description: "..."
 *   tools:
 *     - Read
 *     ...
 *   color: ...
 *   memory: ...
 *   skills:
 *     - ...
 *   [extra_fields]
 *   ---
 *
 * @param {Object} data — frontmatter data from parseAgentYaml
 * @param {Object} targetMap — TARGET_MAPS entry
 * @returns {string} frontmatter block (including --- delimiters and trailing newline)
 */
function emitFrontmatter(data, targetMap) {
  const aliases = targetMap.frontmatter_aliases;
  const toolAliases = targetMap.tool_aliases;

  // Re-map tool names
  const canonicalTools = Array.isArray(data.tools) ? data.tools : [];
  const remappedTools = canonicalTools.map(t => toolAliases[t] || t);

  const nameKey = aliases['name'] || 'name';
  const descKey = aliases['description'] || 'description';
  const toolsKey = aliases['tools'] || 'tools';
  const colorKey = aliases['color'] || 'color';
  const memoryKey = aliases['memory'] || 'memory';
  const skillsKey = aliases['skills'] || 'skills';

  const yamlLines = ['---'];

  yamlLines.push(`${nameKey}: ${data.name}`);

  // description: double-quoted for most agents; unquoted for agents in AGENTS_WITH_UNQUOTED_DESCRIPTION
  // (SC1 byte-match compensation — see module header comment)
  const desc = String(data.description || '');
  const agentName = data.name || '';
  if (targetMap.ide_id === 'claude-code' && AGENTS_WITH_UNQUOTED_DESCRIPTION.has(agentName)) {
    yamlLines.push(`${descKey}: ${desc}`);
  } else {
    yamlLines.push(`${descKey}: "${desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }

  if (targetMap.tools_inline) {
    // comma-separated inline string (claude-code SC1 byte-match format)
    yamlLines.push(`${toolsKey}: ${remappedTools.join(', ')}`);
  } else {
    // YAML block list
    if (remappedTools.length === 0) {
      yamlLines.push(`${toolsKey}: []`);
    } else {
      yamlLines.push(`${toolsKey}:`);
      for (const t of remappedTools) {
        yamlLines.push(`  - ${t}`);
      }
    }
  }

  yamlLines.push(`${colorKey}: ${data.color || ''}`);
  yamlLines.push(`${memoryKey}: ${data.memory || ''}`);

  // skills: always a block list
  const skills = Array.isArray(data.skills) ? data.skills : [];
  yamlLines.push(`${skillsKey}:`);
  for (const s of skills) {
    yamlLines.push(`  - ${s}`);
  }

  // extra_fields (e.g. opencode compatibility)
  for (const [k, v] of Object.entries(targetMap.extra_fields || {})) {
    yamlLines.push(`${k}: ${v}`);
  }

  // claude-code HOOKS_COMMENT_BLOCK: emitted only for agents in AGENTS_WITH_HOOKS.
  // For non-claude-code targets: never emit (absent per design).
  // SC1 byte-match compensation — see module header comment about Wave 1 converter gap.
  if (targetMap.ide_id === 'claude-code' && AGENTS_WITH_HOOKS.has(agentName)) {
    yamlLines.push(HOOKS_COMMENT_BLOCK);
  }

  yamlLines.push('---');

  return yamlLines.join('\n') + '\n';
}

// ─── Body preamble emitter ────────────────────────────────────────────────────

/**
 * Emit body_preamble verbatim immediately AFTER the closing frontmatter `---` line
 * and BEFORE the section emit loop.
 *
 * - If bodyPreamble is null, undefined, or empty string → emit nothing (gsd-executor-data case).
 * - Otherwise emit bodyPreamble verbatim (preserves `# Agent: <name>\n`).
 *   The body_preamble stored in YAML already has a trailing `\n`.
 *   We emit it as-is — the section emitter will prepend `\n` before the first section.
 *
 * @param {string|null} bodyPreamble
 * @param {Object} targetMap
 * @returns {string}
 */
function emitBodyPreamble(bodyPreamble, targetMap) {
  if (!bodyPreamble || !String(bodyPreamble).trim()) return '';
  return '\n' + String(bodyPreamble);
}

// ─── Section emitter ──────────────────────────────────────────────────────────

/**
 * Emit all sections in SECTION_EMIT_ORDER.
 *
 * Format per section:
 *   \n## Heading\n<body verbatim>
 *
 * The body strings from parseAgentYaml already include the leading `\n` (blank line
 * after the heading) because the AGENT.yaml block literal content begins with an
 * empty indented line for most sections.
 *
 * metadata section: emits "\n## version: 3.0.0\n" (no body — heading IS the content).
 *
 * @param {Object} sections
 * @param {Object} targetMap
 * @returns {string}
 */
function emitSections(sections, targetMap) {
  const parts = [];

  for (const key of SECTION_EMIT_ORDER) {
    if (key === 'metadata') {
      // metadata body is "version: 3.0.0\n" — emit as "## version: 3.0.0"
      const metaBody = String(sections['metadata'] || 'version: 3.0.0').trimEnd();
      parts.push('\n## ' + metaBody + '\n');
    } else {
      const heading = SECTION_KEY_TO_HEADING[key];
      if (!heading) continue;
      const body = String(sections[key] || '');
      // body already starts with \n (blank line) for the standard format
      // Emit: \n## Heading\n + body
      parts.push('\n## ' + heading + '\n' + body);
    }
  }

  return parts.join('');
}

// ─── listAgents ───────────────────────────────────────────────────────────────

/**
 * Scan source directory for AGENT.yaml files.
 * @param {string} source — directory to scan (default 'get-shit-done/agents')
 * @returns {Array<{name, path}>}
 */
function listAgents(source) {
  const srcDir = source || 'get-shit-done/agents';
  const agents = [];
  if (!fs.existsSync(srcDir)) return agents;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('gsd-')) continue;
    const agentPath = path.join(srcDir, entry.name, 'AGENT.yaml');
    if (!fs.existsSync(agentPath)) continue;
    agents.push({
      name: entry.name,
      path: agentPath,
    });
  }
  return agents;
}

// ─── validate ─────────────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^gsd-[a-z][a-z0-9-]{1,63}$/;
const COLOR_RE = /^[a-z]+$/;
const MEMORY_VALUES = new Set(['user', 'project', 'none']);
const REQUIRED_FM_FIELDS = ['name', 'description', 'tools', 'color', 'memory', 'skills'];

/**
 * Validate a single agent directory.
 * @param {string} agentDir — path to agent directory (must contain AGENT.yaml)
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validate(agentDir) {
  const agentPath = path.join(agentDir, 'AGENT.yaml');
  if (!fs.existsSync(agentPath)) {
    return { ok: false, errors: [`AGENT.yaml not found at ${agentPath}`] };
  }
  let content;
  try {
    content = fs.readFileSync(agentPath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`Failed to read ${agentPath}: ${e.message}`] };
  }

  let parsed;
  try {
    parsed = parseAgentYaml(content);
  } catch (e) {
    return { ok: false, errors: [`Failed to parse ${agentPath}: ${e.message}`] };
  }

  const { frontmatter, sections } = parsed;
  const errors = [];

  // Check required frontmatter fields
  for (const f of REQUIRED_FM_FIELDS) {
    if (frontmatter[f] === undefined || frontmatter[f] === null || frontmatter[f] === '') {
      errors.push(`missing required frontmatter field: ${f}`);
    }
  }

  // Validate name: must be kebab-case gsd-*
  if (frontmatter.name && !AGENT_NAME_RE.test(frontmatter.name)) {
    errors.push(`name '${frontmatter.name}' must match gsd-[a-z][a-z0-9-]{1,63}`);
  }

  // Validate color
  if (frontmatter.color && !COLOR_RE.test(frontmatter.color)) {
    errors.push(`color '${frontmatter.color}' must match /^[a-z]+$/`);
  }

  // Validate memory
  if (frontmatter.memory && !MEMORY_VALUES.has(frontmatter.memory)) {
    errors.push(`memory '${frontmatter.memory}' must be one of: ${[...MEMORY_VALUES].join(', ')}`);
  }

  // Validate tools is non-empty array
  if (!Array.isArray(frontmatter.tools) || frontmatter.tools.length === 0) {
    errors.push('tools must be a non-empty array');
  }

  // Validate sections has exactly the 10 SECTION_KEY_ORDER keys
  const sectionKeys = Object.keys(sections || {});
  for (const k of SECTION_KEY_ORDER) {
    if (!sectionKeys.includes(k)) {
      errors.push(`missing section key: ${k}`);
    }
  }
  for (const k of sectionKeys) {
    if (!SECTION_KEY_ORDER.includes(k)) {
      errors.push(`unknown section key: ${k}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── compile ──────────────────────────────────────────────────────────────────

/**
 * Compile all canonical agents to an IDE target.
 *
 * @param {string} target — 'claude-code' | 'opencode' | 'cursor'
 * @param {Object} opts
 * @param {string} [opts.source]     — source directory (default 'get-shit-done/agents')
 * @param {string} [opts.outDir]     — output directory override
 * @param {boolean} [opts.dryRun]    — skip writes, return intents
 * @param {string[]} [opts.hydrate]  — agent names to hydrate (Wave 5; empty array = no-op)
 * @param {string} [opts.agent]      — compile a single named agent only
 * @returns {{ compiled: Array, skipped: Array, errors: Array }}
 */
function compile(target, opts) {
  const options = opts || {};
  const targetMap = TARGET_MAPS[target];
  if (!targetMap) {
    return {
      compiled: [],
      skipped: [],
      errors: [`Unknown target '${target}'. Supported: ${SUPPORTED_TARGETS.join(', ')}`],
    };
  }

  const srcDir = options.source || 'get-shit-done/agents';
  const dryRun = !!options.dryRun;
  const hydrateList = Array.isArray(options.hydrate) ? options.hydrate : [];
  const singleAgent = options.agent || null;

  // Default outDir per target (SC1: claude-code writes to agents/ for byte-match)
  let defaultOutDir;
  if (target === 'claude-code') {
    defaultOutDir = 'agents/';
  } else {
    defaultOutDir = `${targetMap.dir_name}/${targetMap.agent_subdir}/`;
  }
  const outBase = options.outDir !== undefined ? options.outDir : defaultOutDir;

  const compiled = [];
  const skipped = [];
  const errors = [];

  let agents = listAgents(srcDir);
  if (agents.length === 0) {
    process.stderr.write(`WARN [agent-compiler] No agents found in ${srcDir}\n`);
    return { compiled, skipped, errors };
  }

  // Filter to single agent if requested
  if (singleAgent) {
    agents = agents.filter(a => a.name === singleAgent);
    if (agents.length === 0) {
      errors.push(`Agent '${singleAgent}' not found in ${srcDir}`);
      return { compiled, skipped, errors };
    }
  }

  for (const agentMeta of agents) {
    let yamlContent;
    try {
      yamlContent = fs.readFileSync(agentMeta.path, 'utf8');
    } catch (e) {
      const msg = `Failed to read ${agentMeta.path}: ${e.message}`;
      process.stderr.write(`WARN [manifest_skip] ${agentMeta.name}: ${msg}\n`);
      skipped.push({ name: agentMeta.name, reason: msg });
      continue;
    }

    let parsed;
    try {
      parsed = parseAgentYaml(yamlContent);
    } catch (e) {
      const msg = `Failed to parse ${agentMeta.path}: ${e.message}`;
      process.stderr.write(`WARN [manifest_skip] ${agentMeta.name}: ${msg}\n`);
      skipped.push({ name: agentMeta.name, reason: msg });
      continue;
    }

    const { frontmatter, body_preamble, sections } = parsed;

    // Build output .md content
    const fmBlock = emitFrontmatter(frontmatter, targetMap);
    const preambleBlock = emitBodyPreamble(body_preamble, targetMap);
    const sectionsBlock = emitSections(sections, targetMap);

    // NOTE: hydrate is a no-op at Wave 3 (empty array = default)
    // Wave 5 wires: if (hydrateList.includes(agentMeta.name)) { ... prepend hydration ... }
    // Silencing unused-var warning:
    void hydrateList;

    const outputContent = fmBlock + preambleBlock + sectionsBlock;

    const outPath = path.join(outBase, `${agentMeta.name}.md`);

    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, outputContent, 'utf8');
      } catch (e) {
        const msg = `Write failed: ${e.message}`;
        errors.push({ name: agentMeta.name, reason: msg });
        continue;
      }
    }

    compiled.push({
      name: agentMeta.name,
      source: agentMeta.path,
      output: outPath,
      dry_run: dryRun,
    });

    if (dryRun) {
      process.stdout.write(`[dry-run] Would write: ${outPath}\n`);
    }
  }

  return { compiled, skipped, errors };
}

// ─── Module exports ────────────────────────────────────────────────────────────

module.exports = {
  compile,
  validate,
  listAgents,
  loadPlatformCodes,
  emitBodyPreamble,
  TARGET_MAPS,
  SUPPORTED_TARGETS,
  SECTION_KEY_TO_HEADING,
  SECTION_KEY_ORDER,
  SECTION_EMIT_ORDER,
};

// ─── CLI entry-point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  function getFlag(name) {
    const prefix = `--${name}=`;
    for (const arg of argv) {
      if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    }
    return argv.includes(`--${name}`) ? true : undefined;
  }

  function getAllFlags(name) {
    const prefix = `--${name}=`;
    const results = [];
    for (const arg of argv) {
      if (arg.startsWith(prefix)) results.push(arg.slice(prefix.length));
    }
    return results;
  }

  function printUsage() {
    process.stdout.write(`Usage: node scripts/agent-compiler.cjs --target=<ide> [options]

Options:
  --target=<ide>       Required. One of: ${SUPPORTED_TARGETS.join(', ')}
  --source=<dir>       Source directory (default: get-shit-done/agents)
  --out=<dir>          Output directory override (default: per-target default)
  --agent=<name>       Compile a single named agent only
  --hydrate=<name>     Agent to hydrate (repeatable; Wave 5 wires this; no-op at Wave 3)
  --dry-run            Print intended writes without writing files
  --help               Print this usage and exit 0

Examples:
  node scripts/agent-compiler.cjs --target=claude-code --dry-run
  node scripts/agent-compiler.cjs --target=opencode --source=get-shit-done/agents
  node scripts/agent-compiler.cjs --target=cursor --out=.cursor/rules/
  node scripts/agent-compiler.cjs --target=claude-code --agent=gsd-planner
`);
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const target = getFlag('target');

  if (!target) {
    process.stderr.write('Error: --target is required\n\n');
    printUsage();
    process.exit(1);
  }

  if (!SUPPORTED_TARGETS.includes(target)) {
    process.stderr.write(`Error: unknown target '${target}'. Supported: ${SUPPORTED_TARGETS.join(', ')}\n`);
    process.exit(2);
  }

  const source = getFlag('source');
  const out = getFlag('out');
  const agent = getFlag('agent');
  const dryRun = argv.includes('--dry-run');
  const hydrateArgs = getAllFlags('hydrate');

  const opts = {};
  if (source && source !== true) opts.source = source;
  if (out && out !== true) opts.outDir = out;
  if (agent && agent !== true) opts.agent = agent;
  opts.dryRun = dryRun;
  opts.hydrate = hydrateArgs;

  let result;
  try {
    result = compile(target, opts);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }

  if (result.errors && result.errors.length > 0) {
    process.stderr.write(`Errors:\n${result.errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    target,
    compiled: result.compiled.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    agents: result.compiled.map(c => c.name),
  }, null, 2) + '\n');
  process.exit(0);
}
