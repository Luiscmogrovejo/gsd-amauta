/**
 * Config — Planning config CRUD operations
 */

const fs = require('fs');
const path = require('path');
const { output, error } = require('./core.cjs');
const platform = require('./platform.cjs');

const VALID_CONFIG_KEYS = new Set([
  // TK-2229: the EXPLICIT project id for this repository. Read by
  // amauta.py's _resolve_project_id(), which prefers it over any inference.
  'project_id',
  'mode', 'granularity', 'parallelization', 'commit_docs', 'model_profile',
  'search_gitignored', 'brave_search', 'current_milestone',
  'workflow.research', 'workflow.plan_check', 'workflow.verifier',
  'workflow.nyquist_validation', 'workflow.ui_phase', 'workflow.ui_safety_gate',
  'workflow._auto_chain_active',
  'git.branching_strategy', 'git.phase_branch_template', 'git.milestone_branch_template',
  'planning.commit_docs', 'planning.search_gitignored',
  'telemetry.enabled', 'telemetry.sink_url',
]);

/**
 * HARNESS-level keys (Phase 89 plan 89-08, RET-05, decision D6).
 *
 * Every key above is per PROJECT and lives in `<cwd>/.planning/config.json`.
 * These six govern ONE shared PostgreSQL store that every project's memories
 * and code chunks live in, so they live in `~/.amauta/config.json`: two projects
 * with different embedding models would be exactly the mixed-vector store the
 * product refuses to query.
 *
 * This set is only the ROUTING decision. Types, defaults, the model enum
 * (derived from get-shit-done/config/embedding-models.json), validation, the
 * backup and the audit line are all in services/harness_config.py, which this
 * module spawns — there is deliberately no second implementation here, so the
 * Python services and this CLI cannot disagree about a key.
 */
const HARNESS_CONFIG_KEYS = new Set([
  'retrieval.embedding_model.memory',
  'retrieval.embedding_model.code_index',
  'retrieval.rerank_model',
  'retrieval.embedding_provider',
  'retrieval.embedding_dimensions',
  'retrieval.rerank_enabled',
]);

/**
 * Where services/harness_config.py is: the repository layout first, then the
 * installed one.
 *
 * @returns {string} absolute path of the script
 * @throws {Error} when neither location has it
 */
function harnessConfigScript() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'services', 'harness_config.py'),
    path.resolve(__dirname, '..', '..', 'services', 'harness_config.py'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('services/harness_config.py not found (looked in ' + candidates.join(', ') + ')');
}

/**
 * Run the harness resolver and return its one JSON document.
 *
 * @param {string[]} args - `get <key>`, `get --all`, `set <key> <value>`
 * @returns {{status: number, payload: object}} exit status and parsed stdout
 * @throws {Error} when the resolver cannot be started or prints no JSON
 * @example
 *   harnessConfig(['get', 'retrieval.rerank_model']).payload.value  // 'rerank-3'
 */
function harnessConfig(args) {
  const script = harnessConfigScript();
  const result = platform.spawnPython([script, ...args], {
    encoding: 'utf-8',
    cwd: path.dirname(path.dirname(script)),
  });
  if (result.error) {
    throw new Error('cannot run the harness config resolver: ' + result.error.message);
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let payload;
  try {
    payload = JSON.parse(lines[lines.length - 1]);
  } catch (_err) {
    throw new Error('the harness config resolver printed no JSON (exit ' + result.status + ')');
  }
  return { status: result.status, payload };
}

/** `a, b (project); x, y (harness, ~/.amauta/config.json)` for the unknown-key error. */
function validKeyList() {
  return `${[...VALID_CONFIG_KEYS].sort().join(', ')} (project scope, .planning/config.json); `
    + `${[...HARNESS_CONFIG_KEYS].sort().join(', ')} (harness scope, ~/.amauta/config.json)`;
}

function cmdConfigEnsureSection(cwd, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  const planningDir = path.join(cwd, '.planning');

  // Ensure .planning directory exists
  try {
    if (!fs.existsSync(planningDir)) {
      fs.mkdirSync(planningDir, { recursive: true });
    }
  } catch (err) {
    error('Failed to create .planning directory: ' + err.message);
  }

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    const result = { created: false, reason: 'already_exists' };
    output(result, raw, 'exists');
    return;
  }

  // Detect Brave Search API key availability
  const homedir = require('os').homedir();
  const braveKeyFile = path.join(homedir, '.gsd', 'brave_api_key');
  const hasBraveSearch = !!(process.env.BRAVE_API_KEY || fs.existsSync(braveKeyFile));

  // Load user-level defaults from ~/.gsd/defaults.json if available
  const globalDefaultsPath = path.join(homedir, '.gsd', 'defaults.json');
  let userDefaults = {};
  try {
    if (fs.existsSync(globalDefaultsPath)) {
      userDefaults = JSON.parse(fs.readFileSync(globalDefaultsPath, 'utf-8'));
      // Migrate deprecated "depth" key to "granularity"
      if ('depth' in userDefaults && !('granularity' in userDefaults)) {
        const depthToGranularity = { quick: 'coarse', standard: 'standard', comprehensive: 'fine' };
        userDefaults.granularity = depthToGranularity[userDefaults.depth] || userDefaults.depth;
        delete userDefaults.depth;
        try { fs.writeFileSync(globalDefaultsPath, JSON.stringify(userDefaults, null, 2), 'utf-8'); } catch {}
      }
    }
  } catch (err) {
    // Ignore malformed global defaults, fall back to hardcoded
  }

  // Create default config (user-level defaults override hardcoded defaults)
  const hardcoded = {
    model_profile: 'balanced',
    commit_docs: true,
    search_gitignored: false,
    branching_strategy: 'none',
    phase_branch_template: 'gsd/phase-{phase}-{slug}',
    milestone_branch_template: 'gsd/{milestone}-{slug}',
    workflow: {
      research: true,
      plan_check: true,
      verifier: true,
      nyquist_validation: true,
    },
    parallelization: true,
    brave_search: hasBraveSearch,
  };
  const defaults = {
    ...hardcoded,
    ...userDefaults,
    workflow: { ...hardcoded.workflow, ...(userDefaults.workflow || {}) },
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    const result = { created: true, path: '.planning/config.json' };
    output(result, raw, 'created');
  } catch (err) {
    error('Failed to create config.json: ' + err.message);
  }
}

function cmdConfigSet(cwd, keyPath, value, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');

  if (!keyPath) {
    error('Usage: config-set <key.path> <value>');
  }

  // Phase 89 plan 89-08: a harness-level key resolves to ~/.amauta/config.json
  // through services/harness_config.py. Nothing below this block runs for it,
  // and nothing in this block runs for a project key.
  if (HARNESS_CONFIG_KEYS.has(keyPath)) {
    if (value === undefined) {
      error('Usage: config-set <key.path> <value>');
    }
    let answer;
    try {
      answer = harnessConfig(['set', keyPath, String(value)]);
    } catch (err) {
      error(err.message);
    }
    if (answer.status !== 0) {
      error(answer.payload.message || `config-set ${keyPath} was refused`);
    }
    const saved = answer.payload;
    output({
      updated: true, key: keyPath, value: saved.value, scope: 'harness',
      path: saved.path, previous: saved.previous, backup: saved.backup,
      reembed: saved.reembed,
    }, raw, `${keyPath}=${saved.value}`);
    return;
  }

  if (!VALID_CONFIG_KEYS.has(keyPath)) {
    error(`Unknown config key: "${keyPath}". Valid keys: ${validKeyList()}`);
  }

  // Parse value (handle booleans and numbers)
  let parsedValue = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (!isNaN(value) && value !== '') parsedValue = Number(value);

  // Load existing config or start with empty object
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    error('Failed to read config.json: ' + err.message);
  }

  // Set nested value using dot notation (e.g., "workflow.research")
  const keys = keyPath.split('.');
  let current = config;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = parsedValue;

  // Write back atomically via temp+rename
  try {
    const tmpPath = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);
    const result = { updated: true, key: keyPath, value: parsedValue };
    output(result, raw, `${keyPath}=${parsedValue}`);
  } catch (err) {
    error('Failed to write config.json: ' + err.message);
  }
}

function cmdConfigGet(cwd, keyPath, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');

  if (!keyPath) {
    error('Usage: config-get <key.path>');
  }

  // Phase 89 plan 89-08: `config-get --all` prints, per key, the effective
  // value, its default, its SOURCE (env / harness / project / default) and
  // whether a re-embed is pending. The six harness keys come from the resolver;
  // every project key is reported from this project's file.
  if (keyPath === '--all') {
    let answer;
    try {
      answer = harnessConfig(['get', '--all']);
    } catch (err) {
      error(err.message);
    }
    if (answer.status !== 0) {
      error(answer.payload.message || 'config-get --all failed');
    }
    let project = {};
    try {
      if (fs.existsSync(configPath)) project = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      error('Failed to read config.json: ' + err.message);
    }
    const dig = (obj, dotted) => dotted.split('.').reduce(
      (cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), obj);
    const rows = answer.payload.keys.map((k) => ({
      key: k.key, value: k.value, default: k.default, source: k.source, scope: 'harness',
      pending_reembed: k.pending_reembed, active_model: k.active_model, phase: k.phase,
      store: k.store, restart_required: k.restart_required,
    }));
    for (const key of [...VALID_CONFIG_KEYS].sort()) {
      const found = dig(project, key);
      rows.push({
        key, value: found === undefined ? null : found, default: null,
        source: found === undefined ? 'unset' : 'project', scope: 'project',
        pending_reembed: false,
      });
    }
    const text = rows.map((r) => `${r.key}=${JSON.stringify(r.value)} `
      + `default=${JSON.stringify(r.default)} source=${r.source} scope=${r.scope} `
      + `pending_reembed=${r.pending_reembed}`).join('\n');
    output({ keys: rows }, raw, text);
    return;
  }

  if (HARNESS_CONFIG_KEYS.has(keyPath)) {
    let answer;
    try {
      answer = harnessConfig(['get', keyPath]);
    } catch (err) {
      error(err.message);
    }
    if (answer.status !== 0) {
      error(answer.payload.message || `config-get ${keyPath} failed`);
    }
    const k = answer.payload;
    output({
      key: k.key, value: k.value, default: k.default, source: k.source, scope: 'harness',
      pending_reembed: k.pending_reembed, active_model: k.active_model, phase: k.phase,
      store: k.store, path: k.path,
    }, raw, String(k.value));
    return;
  }

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      error('No config.json found at ' + configPath);
    }
  } catch (err) {
    if (err.message.startsWith('No config.json')) throw err;
    error('Failed to read config.json: ' + err.message);
  }

  // Traverse dot-notation path (e.g., "workflow.auto_advance")
  const keys = keyPath.split('.');
  let current = config;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== 'object') {
      error(`Key not found: ${keyPath}`);
    }
    current = current[key];
  }

  if (current === undefined) {
    error(`Key not found: ${keyPath}`);
  }

  output(current, raw, String(current));
}

module.exports = {
  HARNESS_CONFIG_KEYS,
  VALID_CONFIG_KEYS,
  cmdConfigEnsureSection,
  cmdConfigSet,
  cmdConfigGet,
};
