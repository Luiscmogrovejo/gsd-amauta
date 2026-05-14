'use strict';
/**
 * skill-compiler.cjs — One-way skill compiler for Phase 43 / SKILL-03.
 *
 * Reads canonical SKILL.md files from get-shit-done/skills/<name>/SKILL.md,
 * applies per-IDE name-map tables, and emits IDE-specific output.
 *
 * Three exported functions (testable):
 *   compile(target, opts)     — compile all skills to an IDE target
 *   validate(skillDir)        — validate a single skill directory
 *   listSkills(source)        — scan source dir and return skill metadata
 *
 * CLI: node scripts/skill-compiler.cjs --target=<ide> [--source=<dir>]
 *                                       [--out=<dir>] [--dry-run] [--help]
 *
 * Supported targets: claude, opencode, cursor
 */

const fs = require('node:fs');
const path = require('node:path');

// ─── Target name-map tables ───────────────────────────────────────────────────

const TARGET_MAPS = {
  claude: {
    frontmatter_aliases: {
      // Claude uses canonical field names as-is
      'name': 'name',
      'description': 'description',
      'category': 'category',
      'version': 'version',
      'security_class': 'security_class',
      'allowed-tools': 'allowed-tools',
      'depends_on': 'depends_on',
    },
    tool_aliases: {
      // Claude uses canonical tool names (identity)
      'Read': 'Read',
      'Edit': 'Edit',
      'Write': 'Write',
      'Grep': 'Grep',
      'Glob': 'Glob',
      'Bash': 'Bash',
      'Task': 'Task',
      'WebFetch': 'WebFetch',
      'WebSearch': 'WebSearch',
    },
    out_dir: '.claude/skills/',
    // No extra fields
    extra_fields: {},
  },
  opencode: {
    frontmatter_aliases: {
      'name': 'name',
      'description': 'description',
      'category': 'category',
      'version': 'version',
      'security_class': 'security_class',
      'allowed-tools': 'allowed-tools',
      'depends_on': 'depends_on',
    },
    tool_aliases: {
      // opencode uses canonical tool names (identity)
      'Read': 'Read',
      'Edit': 'Edit',
      'Write': 'Write',
      'Grep': 'Grep',
      'Glob': 'Glob',
      'Bash': 'Bash',
      'Task': 'Task',
      'WebFetch': 'WebFetch',
      'WebSearch': 'WebSearch',
    },
    out_dir: '.opencode/skills/',
    // opencode adds compatibility field
    extra_fields: { compatibility: 'opencode' },
  },
  cursor: {
    frontmatter_aliases: {
      'name': 'name',
      'description': 'description',
      'category': 'category',
      'version': 'version',
      'security_class': 'securityClass',
      'allowed-tools': 'allowedTools',
      'depends_on': 'dependsOn',
    },
    tool_aliases: {
      // cursor uses snake_case tool names
      'Read': 'read_file',
      'Edit': 'edit_file',
      'Write': 'write_file',
      'Grep': 'grep',
      'Glob': 'glob',
      'Bash': 'bash',
      'Task': 'task',
      'WebFetch': 'web_fetch',
      'WebSearch': 'web_search',
    },
    out_dir: '.cursor/skills/',
    extra_fields: {},
  },
};

const SUPPORTED_TARGETS = Object.keys(TARGET_MAPS);

// ─── Platform codes loader (reads get-shit-done/references/platform-codes.yaml) ──

/**
 * Load the platform-codes.yaml IDE registry.
 *
 * Resolution order for yaml path:
 *   1. Explicit `refPath` argument
 *   2. PLATFORM_CODES_YAML env var
 *   3. Default: <repo-root>/get-shit-done/references/platform-codes.yaml
 *
 * Returns {} (empty map) on any error — compiler falls back to hard-coded
 * TARGET_MAPS values (zero-breakage back-compat).
 *
 * Return shape: { <ide_id>: { ide_id, dir_name, skill_subdir, cli_name }, ... }
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

  // Minimal line-by-line parser (mirrors parseFrontmatter style, no deps)
  // Handles:
  //   top-level key  → ides: (2-space indent children)
  //   IDE id keys    → "  claude-code:" (2-space indent)
  //   scalar fields  → "    field_name: value" (4-space indent)
  //   # comments and blank lines → skip
  const result = {};
  let inIdes = false;
  let currentIde = null;

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

    // Top-level 'ides:' key
    if (/^ides:\s*$/.test(trimmed)) {
      inIdes = true;
      continue;
    }

    if (!inIdes) continue;

    // IDE id keys at 2-space indent: "  <ide-id>:"
    const ideMatch = trimmed.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (ideMatch) {
      currentIde = ideMatch[1];
      result[currentIde] = { ide_id: currentIde, dir_name: '', skill_subdir: '', cli_name: '' };
      continue;
    }

    // Field values at 4-space indent: "    field_name: value"
    if (currentIde) {
      const fieldMatch = trimmed.match(/^    ([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (fieldMatch) {
        const key = fieldMatch[1];
        let val = fieldMatch[2].trim();
        // Strip surrounding quotes if present
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
  // Map yaml ide_id to TARGET_MAPS key. 'claude-code' yaml id maps to 'claude' TARGET_MAPS key.
  const mapKey = ideId === 'claude-code' ? 'claude' : ideId;
  if (TARGET_MAPS[mapKey]) {
    // Rebuild out_dir from yaml fields: '<dir_name>/<skill_subdir>/'
    TARGET_MAPS[mapKey].out_dir = `${codes.dir_name}/${codes.skill_subdir}/`;
    TARGET_MAPS[mapKey].dir_name = codes.dir_name;
    TARGET_MAPS[mapKey].skill_subdir = codes.skill_subdir;
    TARGET_MAPS[mapKey].cli_name = codes.cli_name;
    TARGET_MAPS[mapKey].ide_id = codes.ide_id;
  }
}

// ─── YAML frontmatter parser (minimal, no deps) ────────────────────────────

/**
 * Parse YAML frontmatter text into a plain object.
 * Handles: scalar values, quoted strings, list items (- item), empty lists.
 */
function parseFrontmatter(text) {
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
        // Collect list items
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
        // Inline list
        result[key] = val.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        i++;
        continue;
      } else {
        // Strip quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
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

/**
 * Split SKILL.md content into { frontmatterText, body }.
 * Returns null if no valid frontmatter block found.
 */
function splitSkillMd(content) {
  const parts = content.split('---');
  if (parts.length < 3) return null;
  return {
    frontmatterText: parts[1].trim(),
    body: parts.slice(2).join('---').trimStart(),
  };
}

// ─── Validation helpers ────────────────────────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,32}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DEPENDS_ENTRY_RE = /^[a-z][a-z0-9-]+(@\d+\.\d+\.\d+|@latest)?$/;
const SECURITY_CLASSES = new Set(['read-only', 'read-write', 'admin']);
const REQUIRED_FIELDS = ['name', 'description', 'category', 'version', 'security_class', 'allowed-tools'];

/**
 * Validate parsed frontmatter data. Returns array of error strings.
 */
function validateFrontmatterData(data) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (data[f] === undefined || data[f] === null || data[f] === '') {
      errors.push(`missing required field: ${f}`);
    }
  }
  if (data.name && !NAME_RE.test(data.name)) {
    errors.push(`name '${data.name}' must match ^[a-z][a-z0-9-]{1,63}$`);
  }
  if (data.category && !CATEGORY_RE.test(data.category)) {
    errors.push(`category '${data.category}' must match ^[a-z][a-z0-9-]{1,32}$`);
  }
  if (data.version && !VERSION_RE.test(data.version)) {
    errors.push(`version '${data.version}' must be semver x.y.z`);
  }
  if (data.security_class && !SECURITY_CLASSES.has(data.security_class)) {
    errors.push(`security_class '${data.security_class}' must be one of ${[...SECURITY_CLASSES].sort().join(', ')}`);
  }
  const tools = data['allowed-tools'] || data['allowedTools'] || data['allowed_tools'];
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push('allowed-tools must be a non-empty array');
  }
  const deps = data['depends_on'] || data['dependsOn'] || [];
  if (Array.isArray(deps)) {
    for (const entry of deps) {
      if (!DEPENDS_ENTRY_RE.test(entry)) {
        errors.push(`depends_on entry '${entry}' must match ^[a-z][a-z0-9-]+(@\\d+\\.\\d+\\.\\d+|@latest)?$`);
      }
    }
  }
  return errors;
}

// ─── In-JS depends_on cycle detection ─────────────────────────────────────

/**
 * Topological sort with cycle detection.
 * @param {Object} graph — {name: [dep, ...]}
 * @returns {string[]} topological order or throws Error with cycle info
 */
function topoSort(graph) {
  // Strip @version from dep entries
  const stripVersion = (s) => s.split('@')[0];
  const normalized = {};
  for (const [node, deps] of Object.entries(graph)) {
    normalized[stripVersion(node)] = (deps || []).map(stripVersion);
  }

  const visited = new Set();
  const inProgress = new Set();
  const order = [];

  function dfs(node, path) {
    if (inProgress.has(node)) {
      const idx = path.indexOf(node);
      throw new Error(`Cycle detected: ${path.slice(idx).concat(node).join(' -> ')}`);
    }
    if (visited.has(node)) return;
    inProgress.add(node);
    path.push(node);
    for (const dep of normalized[node] || []) {
      dfs(dep, path);
    }
    path.pop();
    inProgress.delete(node);
    visited.add(node);
    order.push(node);
  }

  for (const node of Object.keys(normalized)) {
    if (!visited.has(node)) dfs(node, []);
  }
  return order;
}

// ─── Compiler output builder ───────────────────────────────────────────────

/**
 * Build the compiled SKILL.md content for a target.
 * Returns { content, intended_frontmatter } for dry-run inspection.
 */
function buildOutput(data, body, targetMap) {
  const aliases = targetMap.frontmatter_aliases;
  const toolAliases = targetMap.tool_aliases;

  // Re-map tool names in allowed-tools
  const canonicalTools = data['allowed-tools'] || data['allowed_tools'] || [];
  const remappedTools = canonicalTools.map(t => toolAliases[t] || t);

  // Re-map depends_on entries (keep @version, only remap name part if needed)
  const deps = data['depends_on'] || [];

  // Build ordered frontmatter fields
  const fields = {
    [aliases['name'] || 'name']: data.name,
    [aliases['description'] || 'description']: data.description,
    [aliases['category'] || 'category']: data.category,
    [aliases['version'] || 'version']: data.version,
    [aliases['security_class'] || 'security_class']: data.security_class,
    [aliases['allowed-tools'] || 'allowed-tools']: remappedTools,
    [aliases['depends_on'] || 'depends_on']: deps,
  };

  // Add extra fields (e.g. opencode compatibility)
  for (const [k, v] of Object.entries(targetMap.extra_fields || {})) {
    fields[k] = v;
  }

  // Emit YAML frontmatter
  const yamlLines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        yamlLines.push(`${k}: []`);
      } else {
        yamlLines.push(`${k}:`);
        for (const item of v) yamlLines.push(`  - ${item}`);
      }
    } else {
      // Quote description (may contain special chars)
      if (k === 'description' || (typeof v === 'string' && /[:#{}[\],&*?|<>=!%@`]/.test(v))) {
        yamlLines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
      } else {
        yamlLines.push(`${k}: ${v}`);
      }
    }
  }
  yamlLines.push('---');

  const content = yamlLines.join('\n') + '\n' + (body || '');
  return { content, intended_frontmatter: fields };
}

// ─── listSkills ────────────────────────────────────────────────────────────

/**
 * Scan source directory for SKILL.md files.
 * @param {string} source — directory to scan (default 'get-shit-done/skills')
 * @returns {Array<{name, version, category, security_class, path}>}
 */
function listSkills(source) {
  const srcDir = source || 'get-shit-done/skills';
  const skills = [];
  if (!fs.existsSync(srcDir)) return skills;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(srcDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const split = splitSkillMd(content);
      if (!split) continue;
      const data = parseFrontmatter(split.frontmatterText);
      skills.push({
        name: data.name || entry.name,
        version: data.version || '0.0.0',
        category: data.category || '',
        security_class: data.security_class || '',
        path: skillPath,
      });
    } catch (e) {
      // Skip unparseable skills silently
    }
  }
  return skills;
}

// ─── Phase 53 POLISH-01: JSON Schema shape validator ──────────────────────

/**
 * Lightweight check that a value looks like a JSON Schema object.
 * Mirrors Python-side _validate_json_schema in services/skill_schema.py.
 * Phase 53 POLISH-01: used by validate() for input_schema / output_schema fields.
 *
 * @param {*} schema — value to check
 * @param {string} fieldName — field name for error messages
 * @returns {string|null} error string, or null if valid/absent
 */
function validateJsonSchemaShape(schema, fieldName) {
  if (schema === null || schema === undefined) return null;
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return `${fieldName} must be a JSON Schema object, got ${typeof schema}`;
  }
  if (!('type' in schema)) {
    return `${fieldName} missing required 'type' field`;
  }
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  if (typeof schema.type === 'string' && !validTypes.includes(schema.type)) {
    return `${fieldName}.type must be one of ${JSON.stringify(validTypes)}, got ${JSON.stringify(schema.type)}`;
  }
  return null;
}

// ─── validate ─────────────────────────────────────────────────────────────

/**
 * Validate a single skill directory.
 * @param {string} skillDir — path to skill directory (must contain SKILL.md)
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validate(skillDir) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return { ok: false, errors: [`SKILL.md not found at ${skillPath}`] };
  }
  let content;
  try {
    content = fs.readFileSync(skillPath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`Failed to read ${skillPath}: ${e.message}`] };
  }
  const split = splitSkillMd(content);
  if (!split) {
    return { ok: false, errors: ['No valid YAML frontmatter block (missing --- delimiters)'] };
  }
  const data = parseFrontmatter(split.frontmatterText);
  const errors = validateFrontmatterData(data);
  // Phase 53 POLISH-01: validate optional JSON Schema fields when present
  const inputErr = validateJsonSchemaShape(data.input_schema || data['input_schema'], 'input_schema');
  if (inputErr) errors.push(inputErr);
  const outputErr = validateJsonSchemaShape(data.output_schema || data['output_schema'], 'output_schema');
  if (outputErr) errors.push(outputErr);
  return { ok: errors.length === 0, errors };
}

// ─── compile ──────────────────────────────────────────────────────────────

/**
 * Compile all canonical skills to an IDE target.
 * @param {string} target — 'claude' | 'opencode' | 'cursor'
 * @param {Object} opts
 * @param {string} [opts.source]  — source directory (default 'get-shit-done/skills')
 * @param {string} [opts.outDir]  — output directory override
 * @param {boolean} [opts.dryRun] — skip writes, return intents
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

  const srcDir = options.source || 'get-shit-done/skills';
  const outBase = options.outDir || targetMap.out_dir;
  const dryRun = !!options.dryRun;

  const compiled = [];
  const skipped = [];
  const errors = [];

  // Load all skills
  const skills = listSkills(srcDir);
  if (skills.length === 0) {
    process.stderr.write(`WARN [skill-compiler] No skills found in ${srcDir}\n`);
    return { compiled, skipped, errors };
  }

  // Build depends_on graph and check for cycles
  const graph = {};
  for (const s of skills) {
    try {
      const content = fs.readFileSync(s.path, 'utf8');
      const split = splitSkillMd(content);
      const data = split ? parseFrontmatter(split.frontmatterText) : {};
      graph[s.name] = data['depends_on'] || [];
    } catch (e) {
      graph[s.name] = [];
    }
  }

  try {
    topoSort(graph);
  } catch (cycleErr) {
    const msg = cycleErr.message;
    process.stderr.write(`ERROR [skill-compiler] ${msg}\n`);
    errors.push(msg);
    return { compiled, skipped, errors };
  }

  // Compile each skill
  for (const skillMeta of skills) {
    const skillPath = skillMeta.path;
    let content;
    try {
      content = fs.readFileSync(skillPath, 'utf8');
    } catch (e) {
      const msg = `Failed to read ${skillPath}: ${e.message}`;
      process.stderr.write(`WARN [manifest_skip] ${skillMeta.name}: ${msg}\n`);
      skipped.push({ name: skillMeta.name, reason: msg });
      continue;
    }

    const split = splitSkillMd(content);
    if (!split) {
      const msg = 'No valid YAML frontmatter block';
      process.stderr.write(`WARN [manifest_skip] ${skillMeta.name}: ${msg}\n`);
      skipped.push({ name: skillMeta.name, reason: msg });
      continue;
    }

    const data = parseFrontmatter(split.frontmatterText);
    const valErrors = validateFrontmatterData(data);
    if (valErrors.length > 0) {
      const msg = valErrors.join('; ');
      process.stderr.write(`WARN [manifest_skip] ${skillMeta.name}: ${msg}\n`);
      skipped.push({ name: skillMeta.name, reason: msg });
      continue;
    }

    const { content: outputContent, intended_frontmatter } = buildOutput(data, split.body, targetMap);
    const outPath = path.join(outBase, skillMeta.name, 'SKILL.md');

    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, outputContent, 'utf8');
      } catch (e) {
        const msg = `Write failed: ${e.message}`;
        errors.push({ name: skillMeta.name, reason: msg });
        continue;
      }
    }

    compiled.push({
      name: skillMeta.name,
      source: skillPath,
      output: outPath,
      dry_run: dryRun,
      intended_frontmatter,
    });

    if (dryRun) {
      process.stdout.write(`[dry-run] Would write: ${outPath}\n`);
    }
  }

  return { compiled, skipped, errors };
}

// ─── Module exports ────────────────────────────────────────────────────────

module.exports = { compile, validate, listSkills, loadPlatformCodes, validateJsonSchemaShape, TARGET_MAPS, SUPPORTED_TARGETS };

// ─── CLI entry-point ───────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  function getFlag(name) {
    const prefix = `--${name}=`;
    const bare = `--${name}`;
    for (const arg of argv) {
      if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    }
    return argv.includes(bare) ? true : undefined;
  }

  function printUsage() {
    process.stdout.write(`Usage: node scripts/skill-compiler.cjs --target=<ide> [options]

Options:
  --target=<ide>       Required. One of: ${SUPPORTED_TARGETS.join(', ')}
  --source=<dir>       Source directory (default: get-shit-done/skills)
  --out=<dir>          Output directory override (default: per-target default)
  --dry-run            Print intended writes without writing files
  --help               Print this usage and exit 0

Examples:
  node scripts/skill-compiler.cjs --target=opencode --dry-run
  node scripts/skill-compiler.cjs --target=claude --source=get-shit-done/skills
  node scripts/skill-compiler.cjs --target=cursor --out=.cursor/skills/
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
    process.exit(1);
  }

  const source = getFlag('source');
  const out = getFlag('out');
  const dryRun = argv.includes('--dry-run');

  const opts = {};
  if (source && source !== true) opts.source = source;
  if (out && out !== true) opts.outDir = out;
  opts.dryRun = dryRun;

  let result;
  try {
    result = compile(target, opts);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }

  if (result.errors && result.errors.length > 0) {
    // Check if any error is a cycle error (exit code 2)
    const hasCycle = result.errors.some(e =>
      (typeof e === 'string' && e.toLowerCase().includes('cycle')) ||
      (typeof e === 'object' && e.reason && e.reason.toLowerCase().includes('cycle'))
    );
    process.stderr.write(`Errors:\n${result.errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n')}\n`);
    process.exit(hasCycle ? 2 : 1);
  }

  process.stdout.write(JSON.stringify({
    target,
    compiled: result.compiled.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    skills: result.compiled.map(c => c.name),
  }, null, 2) + '\n');
  process.exit(0);
}
