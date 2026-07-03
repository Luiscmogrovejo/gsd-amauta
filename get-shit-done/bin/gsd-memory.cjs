#!/usr/bin/env node

/**
 * Amauta Memory CLI — PostgreSQL-backed memory and Shared Knowledge Base (SKB)
 * for Claude Code agents.
 *
 * Communicates with amauta-daemon.py on localhost:18799 via HTTP.
 * Memory entries have source-aware scoring:
 *   lesson-learned +4, best-practice +4, auto_learning +3,
 *   web_search_result +3, session-learning +3, distilled +2,
 *   rpetd_phase +1, task_event +0, agent +0
 *
 * Usage: node gsd-memory.cjs <command> [args]
 *
 * Commands:
 *   search <query>       Search memories with source-aware scoring
 *   store <text>         Store a memory entry
 *   learn <text>         Shortcut: store with auto_learning source
 *   list                 List recent memories
 *   count                Count total memories
 *   skb-search <query>   Search shared knowledge base
 *   skb-add              Add entry to shared knowledge base
 *   skb-list             List SKB entries
 *   semantic-search <q>  Search using embedding cosine similarity
 *   backfill-embeddings  Generate embeddings for memories without them
 *   embedding-stats      Show embedding coverage statistics
 *   cross-project <q>    Search learnings across all projects
 *   infer-tags [dir]     Infer technology tags from project files
 *   health               Check PostgreSQL availability via daemon
 *
 * Options:
 *   --source <src>       Memory source (default: agent)
 *   --agent <id>         Filter by agent ID
 *   --project <id>       Filter by project ID
 *   --tags <t1,t2>       Comma-separated tags
 *   --limit <n>          Number of results (default: 20)
 *   --offset <n>         Pagination offset (default: 0)
 *   --json               Output raw JSON
 *   --category <cat>     SKB category filter
 *   --importance <n>     SKB importance (1-10, default: 5)
 *   --task <id>          Source task ID for SKB entries
 *
 * Environment (auto-loaded from .env):
 *   GSD_AMAUTA_PORT      Daemon port (default: 18799)
 *   GSD_AMAUTA_HOST      Daemon host (default: 127.0.0.1)
 */

const http = require('http');
// https module removed — Claude CLI used for distillation, curl for API fallback
const path = require('path');
const fs = require('fs');

// ── Load .env file (skipped in test mode) ─────────────
(function loadDotenv() {
  if (process.env.GSD_AMAUTA_NO_AUTO_START) return;
  for (const f of [path.join(__dirname, '..', '..', '.env'), '/srv/amauta/.env']) {
    try {
      for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k && !(k in process.env)) process.env[k] = v;
      }
      break;
    } catch { /* next */ }
  }
})();

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);

// File-based fallback paths (vanilla GSD mode)
const PLANNING_DIR = path.resolve(process.cwd(), '.planning');
const STATE_FILE = path.join(PLANNING_DIR, 'STATE.md');
const MEMORY_DIR = path.join(PLANNING_DIR, 'memory');

const SOURCE_LABELS = {
  'lesson-learned': '\x1b[93mlesson\x1b[0m',
  'best-practice': '\x1b[92mbest-pr\x1b[0m',
  'auto_learning': '\x1b[96mauto\x1b[0m',
  'web_search_result': '\x1b[95mweb\x1b[0m',
  'session-learning': '\x1b[94msession\x1b[0m',
  'distilled': '\x1b[36mdistill\x1b[0m',
  'rpetd_phase': '\x1b[90mrpetd\x1b[0m',
  'task_event': '\x1b[90mtask\x1b[0m',
  'agent': '\x1b[37magent\x1b[0m',
};

// ═══════════════════════════════════════════════════════
// DATA-05/DATA-06: Auto-detect project_id
// ═══════════════════════════════════════════════════════

/**
 * DATA-05: Auto-detect project_id from CWD basename.
 * DATA-06: Override with '__test__' in test mode.
 */
function autoProjectId(explicit) {
  if (process.env.NODE_ENV === 'test' || process.env.GSD_TEST_MODE === '1') {
    return '__test__';
  }
  return explicit || path.basename(process.cwd());
}

// ═══════════════════════════════════════════════════════
// Tag Synonym Normalization (shared with Python stores)
// Phase 10 LEARN-04: rules loaded from get-shit-done/config/tag-rules.json
// ═══════════════════════════════════════════════════════

let _TAG_RULES_CACHE = null;
function loadTagRules() {
  if (_TAG_RULES_CACHE) return _TAG_RULES_CACHE;
  const candidates = [
    path.resolve(__dirname, '..', 'config', 'tag-rules.json'),
    path.resolve(process.env.HOME || '', '.claude', 'get-shit-done', 'config', 'tag-rules.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _TAG_RULES_CACHE = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return _TAG_RULES_CACHE;
      }
    } catch (e) {
      // fall through to next candidate
    }
  }
  // Hardcoded fallback — never crash, log warning on first miss
  if (!loadTagRules._warned) {
    console.warn('[gsd-memory] tag-rules.json not found; using hardcoded defaults');
    loadTagRules._warned = true;
  }
  _TAG_RULES_CACHE = {
    banned: ['best-practice', 'general', 'lesson', 'insight'],
    synonyms: {
      db: 'database', postgres: 'postgresql', pg: 'postgresql',
      k8s: 'kubernetes', ts: 'typescript', js: 'javascript',
      py: 'python', ci: 'ci-cd',
    },
    vocabulary: {},
    tiers: {
      domain: ['postgresql', 'kubernetes', 'redis', 'react', 'nodejs', 'python'],
      technique: ['connection-pool', 'memoization', 'idempotency'],
      scope: ['backend', 'frontend', 'database', 'api', 'testing', 'security'],
      meta: ['pattern', 'pitfall', 'convention'],
    },
  };
  return _TAG_RULES_CACHE;
}

// Determine which tier a tag belongs to (returns 0..3, lower = more specific)
function tagTier(tag, rules) {
  if ((rules.tiers.domain || []).includes(tag)) return 0;
  if ((rules.tiers.technique || []).includes(tag)) return 1;
  if ((rules.tiers.scope || []).includes(tag)) return 2;
  if ((rules.tiers.meta || []).includes(tag)) return 3;
  return 2; // unknown tags default to "scope" tier
}

/**
 * Phase 10 LEARN-04: Normalize, strip banned, enforce cap of 5 tags by tier ranking.
 * @param {string[]|string} input - array or comma-separated string
 * @returns {{tags: string[], warnings: string[], error: string|null}}
 */
function normalizeTags(input) {
  const rules = loadTagRules();
  const warnings = [];
  let tags = Array.isArray(input)
    ? input
    : String(input || '').split(',').map(s => s.trim()).filter(Boolean);

  // Lowercase + synonym normalization + dedupe
  const seen = new Set();
  tags = tags
    .map(t => String(t || '').toLowerCase().trim())
    .filter(Boolean)
    .map(t => (rules.synonyms[t] || t))
    .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });

  // Strip banned tags
  const bannedSet = new Set(rules.banned || []);
  const stripped = tags.filter(t => bannedSet.has(t));
  tags = tags.filter(t => !bannedSet.has(t));
  if (stripped.length > 0) {
    warnings.push(`Stripped banned tags: ${stripped.join(', ')}`);
  }

  // Reject if nothing left
  if (tags.length === 0) {
    const suggest = Object.values(rules.vocabulary || {})
      .flat()
      .slice(0, 4)
      .join(', ');
    return {
      tags: [],
      warnings,
      error: `Rejected: all tags are generic (${stripped.join(', ') || 'empty'}). Add specific tags like '${suggest || 'postgresql, connection-pool'}'. See learning-format.md.`,
    };
  }

  // Auto-trim to 5 by tier ranking (lower tier = kept first)
  if (tags.length > 5) {
    const before = tags.length;
    const withTier = tags.map(t => ({ tag: t, tier: tagTier(t, rules) }));
    withTier.sort((a, b) => a.tier - b.tier);
    tags = withTier.slice(0, 5).map(x => x.tag);
    warnings.push(`Trimmed ${before}->5 tags, kept: [${tags.join(', ')}]`);
  }

  return { tags, warnings, error: null };
}

/**
 * Phase 10 LEARN-04: Backward-compat wrapper — returns just the flat tag list.
 * Mirrors the `normalize_tags_list()` pattern in pg_store.py (Plan 10-04 Task 1).
 * Use this at legacy call sites that only expect an array and do not need
 * warnings or error reporting. New callers should use `normalizeTags()` directly
 * and destructure `{tags, warnings, error}`.
 */
function normalizeTagsList(input) {
  const r = normalizeTags(input);
  return r.tags || [];
}

// ═══════════════════════════════════════════════════════
// Phase 10 LEARN-02: Structured LEARNING block parsing
// ═══════════════════════════════════════════════════════

const CATEGORY_SET = new Set([
  'workflow', 'process', 'delivery', 'pattern', 'policy',
  'architecture', 'convention', 'pitfall', 'tool-usage',
]);
const MAX_WHAT = 120;
const MAX_WHY  = 200;
const MAX_WHEN = 80;

/**
 * Parse a single LEARNING block into {what, why, when, category, tags, raw}.
 * Returns null on unrecoverable failure (caller falls back to free-text).
 */
function parseLearningBlock(block) {
  if (!block || typeof block !== 'string') return null;
  const raw = block.trim();
  // Grab the "LEARNING: ..." first line as the default WHAT
  const firstLineMatch = raw.match(/^LEARNING:\s*(.+?)(?:\n|$)/);
  const headerWhat = firstLineMatch ? firstLineMatch[1].trim() : null;

  // Pull indented field lines (case-insensitive field names, multiline)
  function pick(name) {
    const re = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'mi');
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  const what     = pick('WHAT') || headerWhat;
  const why      = pick('WHY');
  const whenStr  = pick('WHEN');
  const category = (pick('CATEGORY') || '').toLowerCase();
  const tagsStr  = pick('TAGS');

  if (!what) return null;

  return {
    what,
    why: why || null,
    when: whenStr || null,
    category: CATEGORY_SET.has(category) ? category : 'pattern',
    category_defaulted: !CATEGORY_SET.has(category),
    tags: tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
    raw,
  };
}

/**
 * Split a D-phase content string into individual LEARNING blocks.
 * Uses \nLEARNING: (newline-prefixed) to avoid mid-sentence splits per RISK-5.
 * Returns an array of block strings each starting with "LEARNING:".
 */
function splitLearningBlocks(text) {
  if (!text) return [];
  const prefixed = text.startsWith('LEARNING:') ? '\n' + text : text;
  const parts = prefixed.split(/\nLEARNING:/);
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    out.push('LEARNING:' + parts[i]);
  }
  return out;
}

/**
 * Enforce length caps. Returns {error} or null on success.
 * Cap violations are recoverable — callers may either reject outright
 * or truncate and keep going (see cmdParseLearning for the latter).
 */
function validateLengthCaps(parsed) {
  if (parsed.what && parsed.what.length > MAX_WHAT) {
    return { error: `Rejected: WHAT is ${parsed.what.length} chars (max ${MAX_WHAT}). Trim to the executable instruction only.` };
  }
  if (parsed.why && parsed.why.length > MAX_WHY) {
    return { error: `Rejected: WHY is ${parsed.why.length} chars (max ${MAX_WHY}). Keep to one sentence of context.` };
  }
  if (parsed.when && parsed.when.length > MAX_WHEN) {
    return { error: `Rejected: WHEN is ${parsed.when.length} chars (max ${MAX_WHEN}). Keep to the conditional trigger only.` };
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// HTTP Client (matches gsd-rlm.cjs / gsd-amauta.cjs pattern)
// ═══════════════════════════════════════════════════════

function httpRequest(method, urlPath, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('Daemon not running. Start it: python3 services/amauta-daemon.py start'));
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// File-Based Fallback (when PG/daemon unavailable)
// ═══════════════════════════════════════════════════════

let _fileMode = false;
const FILE_MODE_WARN = '\x1b[93m[file mode]\x1b[0m PG unavailable — using file-based memory\n';

function ensureDirs() {
  if (!fs.existsSync(PLANNING_DIR)) fs.mkdirSync(PLANNING_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function fileSearch(query) {
  const keywords = query.toLowerCase().split(/\s+/);
  const results = [];

  // Search STATE.md
  if (fs.existsSync(STATE_FILE)) {
    const lines = fs.readFileSync(STATE_FILE, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) {
        results.push({
          text: line.trim(),
          source: 'state-file',
          score: keywords.filter(kw => lower.includes(kw)).length,
          id: `state:${i + 1}`,
          file: 'STATE.md',
        });
      }
    });
  }

  // Search memory/*.md files
  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        if (keywords.some(kw => lower.includes(kw))) {
          results.push({
            text: line.trim(),
            source: 'memory-file',
            score: keywords.filter(kw => lower.includes(kw)).length,
            id: `${file}:${i + 1}`,
            file,
          });
        }
      });
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function fileStore(text, source) {
  ensureDirs();
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (MEM-1 spec: monthly files)
  const file = path.join(MEMORY_DIR, `${month}.md`);
  const entry = `\n- [${source}] ${new Date().toISOString()}: ${text}\n`;
  fs.appendFileSync(file, entry);
  return `file:${month}`;
}

function fileLearn(text) {
  ensureDirs();
  const entry = `\n- [learning] ${new Date().toISOString()}: ${text}`;

  if (fs.existsSync(STATE_FILE)) {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    // Append under LEARNINGS section if it exists, otherwise append at end
    if (content.includes('## Learnings') || content.includes('## LEARNINGS')) {
      const updated = content.replace(
        /(## (?:Learnings|LEARNINGS)\s*\n)/i,
        `$1${entry}\n`
      );
      fs.writeFileSync(STATE_FILE, updated);
    } else {
      fs.appendFileSync(STATE_FILE, `\n\n## Learnings\n${entry}\n`);
    }
  } else {
    fs.writeFileSync(STATE_FILE, `# Amauta State\n\n## Learnings\n${entry}\n`);
  }
  return 'state:learnings';
}

function fileList() {
  const results = [];
  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md')).sort().reverse();
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().startsWith('- ['));
      lines.forEach(line => {
        results.push({ text: line.replace(/^- \[.*?\]\s*\d{4}.*?:\s*/, ''), source: 'memory-file', id: file });
      });
    });
  }
  return results;
}

function fileCount() {
  let count = 0;
  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf-8');
      count += content.split('\n').filter(l => l.trim().startsWith('- [')).length;
    });
  }
  return count;
}

/** Try daemon request; if fails, switch to file mode */
async function tryDaemon(method, urlPath, body = null) {
  try {
    const res = await httpRequest(method, urlPath, body);
    // 503 = daemon up but PG unavailable; 5xx = PG mid-request failure
    // Both trigger file-mode fallback
    if (res.status === 503 || res.status >= 500) {
      _fileMode = true;
      // Warn on write operations so operators know data was not stored in PG
      if (method === 'POST' || method === 'PUT') {
        process.stderr.write(`\x1b[93m[memory]\x1b[0m PG unavailable (${res.status}) — write falling back to file mode.\n`);
      }
      return null; // PG unavailable or daemon error
    }
    return res;
  } catch {
    _fileMode = true;
    if (method === 'POST' || method === 'PUT') {
      process.stderr.write('\x1b[93m[memory]\x1b[0m Daemon unreachable — write falling back to file mode.\n');
    }
    return null; // Daemon unreachable
  }
}

// ═══════════════════════════════════════════════════════
// Argument Parsing
// ═══════════════════════════════════════════════════════

// Phase 10 LEARN-02: flags that are ALWAYS booleans — the tokenizer must
// never consume the next argv entry as their value. Without this, a command
// like `learn --structured "LEARNING: ..."` would assign the text block to
// `args.structured` and leave `_positional` empty.
const BOOLEAN_FLAGS = new Set([
  'json',
  'structured',
  'dry-run',
  'use-llm',
  'include-noise',
  // Phase 10 LEARN-05: skb-promote requires --reviewed (human gate) and
  // must be parsed as a boolean so the next positional arg (mem-id) is not
  // swallowed as its value.
  'reviewed',
  'help',
]);

function parseArgs(argv) {
  const args = { _positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        args[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._positional.push(arg);
    }
    i++;
  }
  return args;
}

// ═══════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════

function formatScore(score) {
  if (score >= 4) return `\x1b[92m${score.toFixed(1)}\x1b[0m`;
  if (score >= 2) return `\x1b[93m${score.toFixed(1)}\x1b[0m`;
  return `\x1b[90m${score.toFixed(1)}\x1b[0m`;
}

function formatMemory(mem, index) {
  const src = SOURCE_LABELS[mem.source] || `\x1b[37m${mem.source}\x1b[0m`;
  const score = formatScore(mem.score || 0);
  const agent = mem.agent_id ? ` @${mem.agent_id}` : '';
  const tagArr = Array.isArray(mem.tags) ? mem.tags : (typeof mem.tags === 'string' && mem.tags ? mem.tags.split(',').map(t => t.trim()) : []);
  const tags = tagArr.length ? ` [${tagArr.join(', ')}]` : '';
  const date = mem.created_at ? mem.created_at.split('T')[0] : '';

  let out = `  ${index + 1}. ${score} ${src}${agent}${tags}  \x1b[2m${date}\x1b[0m\n`;
  // Truncate text to 200 chars for display
  const text = mem.text || '';
  const displayText = text.length > 200 ? text.slice(0, 200) + '...' : text;
  out += `     ${displayText}\n`;
  if (mem.id) out += `     \x1b[2m${mem.id}\x1b[0m\n`;
  return out;
}

function formatSKB(entry, index) {
  const imp = entry.importance || 5;
  const impColor = imp >= 7 ? '\x1b[91m' : imp >= 4 ? '\x1b[93m' : '\x1b[90m';
  const cat = entry.category ? `\x1b[36m[${entry.category}]\x1b[0m ` : '';
  const date = entry.created_at ? entry.created_at.split('T')[0] : '';

  let out = `  ${index + 1}. ${impColor}imp:${imp}\x1b[0m ${cat}\x1b[1m${entry.title}\x1b[0m  \x1b[2m${date}\x1b[0m\n`;
  if (entry.content) {
    const content = entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content;
    out += `     ${content}\n`;
  }
  if (entry.id) out += `     \x1b[2m${entry.id}\x1b[0m\n`;
  return out;
}

// ═══════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════

// Phase 10 LEARN-03: render a single memory result using either the
// structured card format (when metadata.what is present) or the legacy
// one-line format (for free-text entries). Keeps the legacy display
// working unchanged for old memories while new structured entries show
// their WHAT/WHY/WHEN/CATEGORY schema directly.
function renderMemoryResult(r, index) {
  const metadata = r.metadata || {};
  const structured = !!metadata.what;
  if (structured) {
    const score = (r.score || 0).toFixed(3);
    const appliedCount = r.applied_count || metadata.applied_count || 0;
    console.log(`\n[${index + 1}] ${r.id}  (score: ${score}, applied: ${appliedCount})`);
    console.log(`  WHAT: ${metadata.what}`);
    if (metadata.why)  console.log(`  WHY: ${metadata.why}`);
    if (metadata.when) console.log(`  WHEN: ${metadata.when}`);
    const cat = metadata.category || 'pattern';
    const tagArr = Array.isArray(r.tags) ? r.tags : [];
    const tags = tagArr.length ? tagArr.join(', ') : '—';
    console.log(`  CATEGORY: ${cat}   TAGS: ${tags}`);
    if (metadata.promoted_to_skb === true) {
      console.log(`  \x1b[92m[PROMOTED to ${metadata.skb_id || 'SKB'}]\x1b[0m`);
    }
  } else {
    // Legacy free-text — keep the existing formatMemory card so older
    // memories and test fixtures continue to render as before.
    process.stdout.write(formatMemory(r, index));
  }
}

async function cmdSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory search <query> [--agent <id>] [--project <id>] [--source <src>] [--limit <n>] [--tags <t1,t2>] [--category <cat>] [--include-noise] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '20', 10) };
  if (args.agent) body.agent_id = args.agent;
  if (args.project) body.project_id = args.project;
  if (args.source) body.source = args.source;
  // MEM-01: --include-noise bypasses default exclusion of task_event/rpetd_phase
  if (args['include-noise']) body.include_noise = true;
  // Phase 10 LEARN-03: forward --tags and --category to daemon search.
  // tags accepts either an already-split array or a comma string.
  if (args.tags) {
    body.tags = Array.isArray(args.tags)
      ? args.tags
      : String(args.tags).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (args.category) body.category = args.category;

  const res = await tryDaemon('POST', '/api/memory/search', body);

  if (!res) {
    // File-based fallback
    process.stderr.write(FILE_MODE_WARN);
    const results = fileSearch(query).slice(0, body.limit);
    if (args.json) {
      console.log(JSON.stringify({ results, count: results.length, mode: 'file' }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log(`\x1b[2mNo memories found for: "${query}"\x1b[0m`);
      return;
    }
    console.log(`\n\x1b[1mMemory Search: "${query}"\x1b[0m  (${results.length} results, file mode)\n`);
    results.forEach((mem, i) => renderMemoryResult(mem, i));
    console.log('');
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  if (results.length === 0) {
    console.log(`\x1b[2mNo memories found for: "${query}"\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[1mMemory Search: "${query}"\x1b[0m  (${results.length} results)\n`);
  results.forEach((mem, i) => renderMemoryResult(mem, i));
  console.log('');
}

async function cmdStore(args) {
  const text = args._positional.join(' ');
  if (!text) {
    console.error('Usage: amauta-memory store <text> [--source <src>] [--agent <id>] [--project <id>] [--tags <t1,t2>]');
    process.exit(1);
  }

  const source = args.source || 'agent';
  const body = { text, source };
  if (args.agent) body.agent_id = args.agent;
  body.project_id = autoProjectId(args.project);
  if (args.tags) body.tags = normalizeTagsList(args.tags.split(',').map(t => t.trim()));
  // args.metadata may be a string (from CLI) or an object (from cmdLearn structured path)
  if (args.metadata) {
    if (typeof args.metadata === 'object') {
      body.metadata = args.metadata;
    } else {
      try { body.metadata = JSON.parse(args.metadata); } catch { /* ignore */ }
    }
  }

  const res = await tryDaemon('POST', '/api/memory/store', body);

  if (!res) {
    // File-based fallback
    process.stderr.write(FILE_MODE_WARN);
    // Phase 10 LEARN-02: structured metadata is lost in file mode — keep
    // the block text intact but warn so agents know to re-store once the
    // daemon is reachable.
    if (body.metadata && typeof body.metadata === 'object' && body.metadata.structured) {
      console.warn('[warn] File-mode fallback: structured metadata dropped, saved as flat text');
    }
    const id = fileStore(text, source);
    if (args.json) {
      console.log(JSON.stringify({ id, stored: true, mode: 'file' }, null, 2));
    } else {
      console.log(`\x1b[92mStored\x1b[0m ${id} (source: ${source}, file mode)`);
    }
    // TK-0054: Still check auto-distill even in file mode (counts file entries)
    await maybeAutoDistill();
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
  } else {
    console.log(`\x1b[92mStored\x1b[0m ${res.data.id} (source: ${source})`);
  }

  // TK-0054: Check if auto-distill is needed
  await maybeAutoDistill();
}

// ═══════════════════════════════════════════════════════
// Phase 10 LEARN-02: parse-learning subcommand
// ═══════════════════════════════════════════════════════

async function cmdParseLearning(args) {
  // Kill switch — disable structured parsing entirely
  if (process.env.GSD_D_STRUCTURED === 'false') {
    console.warn('Structured learning disabled (GSD_D_STRUCTURED=false), storing as free-text');
    const raw = (args._positional || []).join(' ') || '';
    console.log(JSON.stringify({
      disabled: true,
      raw,
      blocks: [{ what: raw.slice(0, MAX_WHAT), tags: [], raw }],
    }));
    return 0;
  }

  const raw = (args._positional || []).join(' ');
  if (!raw) {
    console.error('Usage: gsd-memory parse-learning "<text block containing LEARNING: ...>"');
    return 1;
  }

  const blocks = splitLearningBlocks(raw);
  if (blocks.length === 0) {
    // Free-text fallback — no LEARNING: marker found
    console.log(JSON.stringify({
      parsed: false,
      reason: 'no LEARNING: marker',
      blocks: [{ what: raw.slice(0, MAX_WHAT), tags: [], raw }],
    }));
    return 0;
  }

  const out = { parsed: true, blocks: [], warnings: [] };
  for (const b of blocks) {
    const p = parseLearningBlock(b);
    if (!p) {
      out.warnings.push(`Parse failure for block: ${b.slice(0, 40)}... — falling back to free-text`);
      out.blocks.push({ what: b.slice(0, MAX_WHAT), tags: [], raw: b, parse_failed: true });
      continue;
    }
    const capErr = validateLengthCaps(p);
    if (capErr) {
      out.warnings.push(capErr.error);
      // Truncate and keep, don't drop the learning
      if (p.what) p.what = p.what.slice(0, MAX_WHAT);
      if (p.why)  p.why  = p.why.slice(0, MAX_WHY);
      if (p.when) p.when = p.when.slice(0, MAX_WHEN);
      p.truncated = true;
    }
    const norm = normalizeTags(p.tags);
    if (norm.error) {
      out.warnings.push(norm.error);
      p.tags = [];
      p.tag_error = norm.error;
    } else {
      p.tags = norm.tags;
      if (norm.warnings.length) out.warnings.push(...norm.warnings);
    }
    out.blocks.push(p);
  }

  console.log(JSON.stringify(out));
  return 0;
}

async function cmdLearn(args) {
  // Phase 10 LEARN-02: `learn --structured` hybrid path. Keep the legacy
  // free-text path for backward compatibility with pre-Phase 10 callers.
  const isStructured = !!args.structured;
  const textFromPositional = (args._positional || []).join(' ');

  // Kill switch — force free-text path even if --structured is set
  if (isStructured && process.env.GSD_D_STRUCTURED === 'false') {
    console.warn('Structured learning disabled (GSD_D_STRUCTURED=false), storing as free-text');
    // fall through to free-text path below
  }
  const structuredActive = isStructured && process.env.GSD_D_STRUCTURED !== 'false';

  if (!structuredActive) {
    // ── Legacy free-text path — unchanged from pre-Phase 10 behavior ──
    // When the kill switch fires on a --structured call, reuse --what (or the
    // concatenated named fields) as the flat text body so the call still
    // lands a memory rather than aborting with a usage error.
    let text = textFromPositional;
    if (!text && isStructured) {
      const parts = [args.what, args.why, args.when].filter(Boolean);
      text = parts.join(' — ');
    }
    if (!text) {
      console.error('Usage: amauta-memory learn <text>  OR  learn --structured --what "..." [--why "..."] [--tags "..."]');
      process.exit(1);
    }

    const body = { text, source: 'auto_learning', project_id: autoProjectId(null) };
    if (args.agent) body.agent_id = args.agent;

    const res = await tryDaemon('POST', '/api/memory/store', body);

    if (!res) {
      process.stderr.write(FILE_MODE_WARN);
      const id = fileLearn(text);
      if (args.json) {
        console.log(JSON.stringify({ id, stored: true, mode: 'file' }, null, 2));
      } else {
        console.log(`\x1b[92mStored\x1b[0m ${id} (source: auto_learning, file mode → STATE.md)`);
      }
      // TK-0054: Still check auto-distill even in file mode (counts file entries)
      await maybeAutoDistill();
      return;
    }

    if (res.status !== 200) {
      console.error('Error:', res.data.error || 'Unknown error');
      process.exit(1);
    }

    if (args.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      console.log(`\x1b[92mStored\x1b[0m ${res.data.id} (source: auto_learning)`);
    }

    // TK-0054: Check if auto-distill is needed (same as cmdStore)
    await maybeAutoDistill();
    return;
  }

  // ── Structured path — hybrid: named flags OR text block ──
  let parsed = null;
  if (args.what || args.why || args.when || args.tags || args.category) {
    // Named-flag path: build the structured object directly.
    parsed = {
      what: args.what || null,
      why: args.why || null,
      when: args.when || null,
      category: (args.category || 'pattern').toLowerCase(),
      tags: args.tags
        ? (Array.isArray(args.tags)
            ? args.tags
            : String(args.tags).split(',').map(s => s.trim()).filter(Boolean))
        : [],
    };
    if (!CATEGORY_SET.has(parsed.category)) {
      console.warn(`[warn] Unknown category '${parsed.category}', defaulting to 'pattern'`);
      parsed.category = 'pattern';
    }
  } else if (textFromPositional) {
    // Text-block path: parse the positional argument as a LEARNING block.
    const blocks = splitLearningBlocks(textFromPositional);
    if (blocks.length === 0) {
      console.error('Rejected: --structured requires either --what flag or a text block starting with "LEARNING:"');
      process.exit(1);
    }
    parsed = parseLearningBlock(blocks[0]);
    if (!parsed) {
      console.warn('Structured parse failed, falling back to free-text storage');
      const body = { text: textFromPositional, source: 'auto_learning', project_id: autoProjectId(null) };
      if (args.agent) body.agent_id = args.agent;
      const res = await tryDaemon('POST', '/api/memory/store', body);
      if (!res) {
        process.stderr.write(FILE_MODE_WARN);
        const id = fileLearn(textFromPositional);
        if (args.json) {
          console.log(JSON.stringify({ id, stored: true, mode: 'file', fallback: 'parse_failed' }, null, 2));
        } else {
          console.log(`\x1b[92mStored\x1b[0m ${id} (source: auto_learning, file mode → STATE.md)`);
        }
        await maybeAutoDistill();
        return;
      }
      if (res.status !== 200) {
        console.error('Error:', res.data.error || 'Unknown error');
        process.exit(1);
      }
      if (args.json) console.log(JSON.stringify(res.data, null, 2));
      else console.log(`\x1b[92mStored\x1b[0m ${res.data.id} (source: auto_learning, free-text fallback)`);
      await maybeAutoDistill();
      return;
    }
  } else {
    console.error('Rejected: --structured requires either --what flag or a text block arg');
    process.exit(1);
  }

  // Required field check
  if (!parsed.what || !String(parsed.what).trim()) {
    console.error('Rejected: WHAT is required for structured learnings');
    process.exit(1);
  }

  // Length cap enforcement (hard reject — caller must trim)
  const capErr = validateLengthCaps(parsed);
  if (capErr) {
    console.error(capErr.error);
    process.exit(1);
  }

  // Tag normalization + banned strip + auto-trim
  const norm = normalizeTags(parsed.tags || []);
  if (norm.error) {
    console.error(norm.error);
    process.exit(1);
  }
  parsed.tags = norm.tags;
  if (norm.warnings.length) {
    for (const w of norm.warnings) console.warn(`[warn] ${w}`);
  }
  // Warn only when the caller did not supply ANY category signal — neither
  // as a named flag nor inside the parsed block (parseLearningBlock sets
  // category_defaulted=true when the block omits CATEGORY or uses an
  // unrecognized value).
  const categoryImplicit = !args.category && (parsed.category_defaulted !== false);
  if (parsed.category === 'pattern' && categoryImplicit) {
    console.warn(`[warn] CATEGORY defaulted to 'pattern'. Consider specifying one of: workflow, process, delivery, policy, architecture, convention, pitfall, tool-usage`);
  }

  // Build the full text for the `text` column (canonical structured block).
  const fullText = textFromPositional || [
    `LEARNING: ${parsed.what}`,
    `  WHAT: ${parsed.what}`,
    parsed.why  ? `  WHY: ${parsed.why}` : null,
    parsed.when ? `  WHEN: ${parsed.when}` : null,
    `  CATEGORY: ${parsed.category}`,
    `  TAGS: ${parsed.tags.join(', ')}`,
  ].filter(Boolean).join('\n');

  // Delegate to cmdStore with structured metadata payload.
  // cmdStore will:
  //   • forward args.metadata (object) as body.metadata → daemon jsonb column
  //   • forward args.tags → body.tags (via normalizeTagsList, already-normalized
  //     tags pass through cleanly)
  //   • log a file-mode warning if the daemon is unreachable (metadata dropped)
  args._positional = [fullText];
  args.text = fullText;
  args.tags = parsed.tags.join(',');
  args.source = args.source || 'auto_learning';
  args.metadata = {
    what: parsed.what,
    why: parsed.why,
    when: parsed.when,
    category: parsed.category,
    structured: true,
    structured_version: '1.0',
  };
  return await cmdStore(args);
}

// ═══════════════════════════════════════════════════════
// Phase 10 LEARN-05: increment-applied subcommand
// ═══════════════════════════════════════════════════════
//
// Forwards an APPLIED_LEARNING citation to the daemon. The daemon dedups by
// (mem_id, task_id) so repeat calls from the same task are idempotent — this
// is a requirement for the operator's post-D-phase scanner, which may run
// multiple times per task. There is no file-mode fallback: applied_count is
// a PG-backed column (migration 008) and cannot degrade gracefully.
async function cmdIncrementApplied(args) {
  const memId = (args._positional || [])[0];
  if (!memId || !memId.startsWith('mem-')) {
    console.error('Usage: gsd-memory increment-applied <mem-XXXX> --task <TK-XXXX> [--phase R|P|E|T|D] [--reason <text>]');
    process.exit(1);
  }
  const taskId = args.task;
  if (!taskId) {
    console.error('Rejected: --task <TK-XXXX> is required for increment-applied');
    process.exit(1);
  }
  const phase = args.phase || null;
  const reason = args.reason || null;

  const body = { task_id: taskId, phase, reason };
  let res;
  try {
    res = await httpRequest('POST', `/api/memory/${encodeURIComponent(memId)}/increment-applied`, body);
  } catch (e) {
    console.error(`increment-applied failed: ${e.message || e}`);
    console.error('  increment-applied requires the daemon to be running (no file-mode fallback)');
    process.exit(1);
  }

  if (res.status === 404) {
    console.error(`Not found: ${memId}`);
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`Error (${res.status}):`, (res.data && res.data.error) || 'unknown');
    process.exit(1);
  }

  const d = res.data || {};
  if (args.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  if (d.already_cited) {
    console.log(`Already cited: ${memId} by ${taskId} (count unchanged: ${d.applied_count})`);
  } else if (d.incremented) {
    console.log(`Incremented: ${memId} applied_count -> ${d.applied_count}`);
  } else {
    console.error(`Error: ${d.error || 'unknown response shape'}`);
    process.exit(1);
  }
}

async function cmdList(args) {
  const params = new URLSearchParams();
  if (args.project) params.set('project_id', args.project);
  if (args.source) params.set('source', args.source);
  if (args.limit) params.set('limit', args.limit);
  if (args.offset) params.set('offset', args.offset);

  const qs = params.toString();
  const url = qs ? `/api/memory/list?${qs}` : '/api/memory/list';
  const res = await tryDaemon('GET', url);

  if (!res) {
    process.stderr.write(FILE_MODE_WARN);
    const results = fileList();
    if (args.json) {
      console.log(JSON.stringify({ results, count: results.length, mode: 'file' }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('\x1b[2mNo memories stored yet.\x1b[0m');
      return;
    }
    console.log(`\n\x1b[1mMemories\x1b[0m  (${results.length} entries, file mode)\n`);
    results.forEach((mem, i) => {
      console.log(`  ${i + 1}. \x1b[37m${mem.source}\x1b[0m`);
      console.log(`     ${(mem.text || '').slice(0, 100)}`);
      console.log(`     \x1b[2m${mem.id}\x1b[0m`);
    });
    console.log('');
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  if (results.length === 0) {
    console.log('\x1b[2mNo memories stored yet.\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1mMemories\x1b[0m  (${results.length} entries)\n`);
  results.forEach((mem, i) => {
    const src = SOURCE_LABELS[mem.source] || mem.source;
    const agent = mem.agent_id ? ` @${mem.agent_id}` : '';
    const date = mem.created_at ? mem.created_at.split('T')[0] : '';
    const text = (mem.text || '').slice(0, 100);
    console.log(`  ${i + 1}. ${src}${agent}  \x1b[2m${date}\x1b[0m`);
    console.log(`     ${text}${mem.text && mem.text.length > 100 ? '...' : ''}`);
    console.log(`     \x1b[2m${mem.id}\x1b[0m`);
  });
  console.log('');
}

async function cmdCount(args) {
  const res = await tryDaemon('GET', '/api/memory/count');

  if (!res) {
    process.stderr.write(FILE_MODE_WARN);
    const count = fileCount();
    if (args.json) {
      console.log(JSON.stringify({ count, mode: 'file' }, null, 2));
    } else {
      console.log(`Memories: ${count} (file mode)`);
    }
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
  } else {
    console.log(`Memories: ${res.data.count}`);
  }
}

async function cmdSKBSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory skb-search <query> [--category <cat>] [--limit <n>] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '20', 10) };
  if (args.category) body.category = args.category;

  const res = await tryDaemon('POST', '/api/skb/search', body);

  if (!res) {
    console.error('SKB requires PostgreSQL. Daemon unavailable — start the Amauta daemon and retry.');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  if (results.length === 0) {
    console.log(`\x1b[2mNo SKB entries found for: "${query}"\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[1mSKB Search: "${query}"\x1b[0m  (${results.length} results)\n`);
  results.forEach((entry, i) => process.stdout.write(formatSKB(entry, i)));
  console.log('');
}

async function cmdSKBAdd(args) {
  const title = args._positional.join(' ');
  if (!title) {
    console.error('Usage: amauta-memory skb-add <title> --content <text> [--category <cat>] [--importance <n>] [--task <id>] [--tags <t1,t2>]');
    process.exit(1);
  }

  if (!args.content) {
    console.error('Error: --content is required');
    process.exit(1);
  }

  const body = {
    title,
    content: args.content,
    importance: parseInt(args.importance || '5', 10),
  };
  if (args.category) body.category = args.category;
  if (args.agent) body.agent_id = args.agent;
  if (args.task) body.source_task = args.task;
  if (args.tags) body.tags = args.tags.split(',').map(t => t.trim());

  const res = await tryDaemon('POST', '/api/skb/store', body);

  if (!res) {
    console.error('SKB requires PostgreSQL. Daemon unavailable — start the Amauta daemon and retry.');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
  } else {
    console.log(`\x1b[92mStored\x1b[0m ${res.data.id} (SKB: ${title})`);
  }
}

async function cmdSKBList(args) {
  const params = new URLSearchParams();
  if (args.category) params.set('category', args.category);
  if (args.limit) params.set('limit', args.limit);
  if (args.offset) params.set('offset', args.offset);

  const qs = params.toString();
  const url = qs ? `/api/skb/list?${qs}` : '/api/skb/list';
  const res = await tryDaemon('GET', url);

  if (!res) {
    console.error('SKB requires PostgreSQL. Daemon unavailable — start the Amauta daemon and retry.');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  if (results.length === 0) {
    console.log('\x1b[2mNo SKB entries yet.\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1mShared Knowledge Base\x1b[0m  (${results.length} entries)\n`);
  results.forEach((entry, i) => {
    const imp = entry.importance || 5;
    const impColor = imp >= 7 ? '\x1b[91m' : imp >= 4 ? '\x1b[93m' : '\x1b[90m';
    const cat = entry.category ? `[${entry.category}] ` : '';
    const date = entry.created_at ? entry.created_at.split('T')[0] : '';
    console.log(`  ${i + 1}. ${impColor}imp:${imp}\x1b[0m ${cat}\x1b[1m${entry.title}\x1b[0m  \x1b[2m${date}\x1b[0m`);
    console.log(`     \x1b[2m${entry.id}\x1b[0m`);
  });
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Phase 10 LEARN-05: skb-candidates subcommand
// ═══════════════════════════════════════════════════════
//
// Surfaces PG memory entries eligible for SKB promotion by applied_count.
// Two tiers based on CONTEXT.md lines 65-75:
//   - rising (5..9):     auto-promotable candidates, low review burden
//   - needs_review (>=10): REQUIRES manual review before promotion — high
//                          citation count may indicate echo-chamber effect
//
// No file-mode fallback: this query is fundamentally PG-backed.
async function cmdSkbCandidates(args) {
  if (args.help) {
    console.log('Usage: gsd-memory skb-candidates [--rising-min 5] [--needs-review-min 10] [--limit 100] [--json]');
    return;
  }
  const risingMin = parseInt(args['rising-min'] || 5, 10);
  const needsReviewMin = parseInt(args['needs-review-min'] || 10, 10);
  const limit = parseInt(args.limit || 100, 10);

  const qs = `rising_min=${risingMin}&needs_review_min=${needsReviewMin}&limit=${limit}`;
  let res;
  try {
    res = await httpRequest('GET', `/api/memory/skb-candidates?${qs}`);
  } catch (e) {
    console.error(`skb-candidates failed: ${e.message || e}`);
    console.error('  skb-candidates requires the daemon to be running (no file-mode fallback)');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`Error (${res.status}):`, (res.data && res.data.error) || 'unknown');
    process.exit(1);
  }

  const candidates = (res.data && res.data.candidates) || [];
  const needsReview = candidates.filter(c => c.needs_review);
  const rising = candidates.filter(c => c.rising);

  if (args.json) {
    console.log(JSON.stringify({
      needs_review: needsReview,
      rising,
      total: candidates.length,
      rising_min: risingMin,
      needs_review_min: needsReviewMin,
    }, null, 2));
    return;
  }

  if (candidates.length === 0) {
    console.log(`No SKB candidates found (threshold: rising>=${risingMin}, needs_review>=${needsReviewMin})`);
    return;
  }

  if (needsReview.length > 0) {
    console.log(`\n\x1b[1m=== NEEDS REVIEW\x1b[0m (applied_count >= ${needsReviewMin}) ===`);
    for (const c of needsReview) {
      const what = c.what || c.text_preview || '(no preview)';
      const tags = (c.tags || []).join(', ') || '—';
      console.log(`  \x1b[91m[${c.applied_count}x]\x1b[0m ${c.id}`);
      console.log(`    WHAT: ${what}`);
      console.log(`    CATEGORY: ${c.category || '—'}   TAGS: ${tags}`);
      console.log(`    FIRST_CITED: ${c.first_cited_at || '—'}   LAST_CITED: ${c.last_cited_at || '—'}`);
      console.log(`    \x1b[2m-> gsd-memory skb-promote ${c.id} --reviewed --reason "<why>"\x1b[0m`);
    }
  }
  if (rising.length > 0) {
    console.log(`\n\x1b[1m=== RISING\x1b[0m (applied_count ${risingMin}-${needsReviewMin - 1}) ===`);
    for (const c of rising) {
      const what = c.what || c.text_preview || '(no preview)';
      const tags = (c.tags || []).join(', ') || '—';
      console.log(`  \x1b[93m[${c.applied_count}x]\x1b[0m ${c.id}  ${what}`);
      console.log(`    TAGS: ${tags}   CATEGORY: ${c.category || '—'}`);
    }
  }
  console.log(`\nTotal: ${candidates.length}  (needs review: ${needsReview.length}, rising: ${rising.length})`);
}

// ═══════════════════════════════════════════════════════
// Phase 10 LEARN-05: skb-promote + skb-remove subcommands
// ═══════════════════════════════════════════════════════
//
// Promotion workflow (cmdSkbPromote):
//   1. GET /api/memory/<mem-id>         — fetch the source memory
//   2. Reject if metadata.promoted_to_skb is already true
//   3. POST /api/skb/store              — create the SKB row using WHAT or
//                                         the first 120 chars of the text as title
//   4. PATCH /api/memory/<mem-id>       — merge-patch metadata to mark
//                                         promoted_to_skb=true + skb_id + ts
//
// Demotion workflow (cmdSkbRemove) — reverse path:
//   1. GET /api/skb/<skb-id>            — find source_mem_id from metadata.tags
//                                         (stored as source_mem_id tag or
//                                         note on the SKB row)
//   2. DELETE /api/skb/<skb-id>         — drop the SKB row
//   3. PATCH /api/memory/<mem-id>       — clear promoted_to_skb flag
//
// --reviewed is a required boolean gate on promote: human review must be
// explicit. The operator (Plan 10-06) will prompt via AskUserQuestion and
// pass --reviewed only after the user approves.
async function cmdSkbPromote(args) {
  const memId = (args._positional || [])[0];
  if (!memId || !memId.startsWith('mem-')) {
    console.error('Usage: gsd-memory skb-promote <mem-XXXX> --reviewed [--reason <text>]');
    process.exit(1);
  }
  if (!args.reviewed) {
    console.error('Rejected: --reviewed flag is required. Human review must be explicit for SKB promotion.');
    process.exit(1);
  }

  // 1. Fetch the source memory entry
  let memRes;
  try {
    memRes = await httpRequest('GET', `/api/memory/${encodeURIComponent(memId)}`);
  } catch (e) {
    console.error(`skb-promote failed: could not fetch ${memId}: ${e.message || e}`);
    process.exit(1);
  }
  if (memRes.status === 404) {
    console.error(`Not found: ${memId}`);
    process.exit(1);
  }
  if (memRes.status !== 200) {
    console.error(`Error fetching ${memId}: ${(memRes.data && memRes.data.error) || memRes.status}`);
    process.exit(1);
  }
  const mem = memRes.data || {};
  const metadata = mem.metadata || {};
  if (metadata.promoted_to_skb === true) {
    console.error(`Already promoted: ${memId} -> ${metadata.skb_id || '?'}`);
    process.exit(1);
  }

  // 2. Build SKB payload — use structured WHAT as title if present
  const what = metadata.what || (mem.text || '').slice(0, 120);
  const skbPayload = {
    title: what || memId,
    content: mem.text || what || '',
    category: metadata.category || 'pattern',
    tags: Array.isArray(mem.tags) ? mem.tags : [],
    source_task: `promoted_from:${memId}`,
    importance: 6,
  };
  if (args.reason) skbPayload.content = `${skbPayload.content}\n\nPROMOTION_REASON: ${args.reason}`;

  // 3. Create SKB row
  let skbRes;
  try {
    skbRes = await httpRequest('POST', '/api/skb/store', skbPayload);
  } catch (e) {
    console.error(`skb-promote failed: could not create SKB entry: ${e.message || e}`);
    process.exit(1);
  }
  if (skbRes.status !== 200) {
    console.error(`Error creating SKB: ${(skbRes.data && skbRes.data.error) || skbRes.status}`);
    process.exit(1);
  }
  const skbId = skbRes.data && skbRes.data.id;
  if (!skbId) {
    console.error('skb-promote: SKB creation returned no id');
    process.exit(1);
  }

  // 4. Mark source memory as promoted
  const patchBody = {
    metadata_patch: {
      promoted_to_skb: true,
      skb_id: skbId,
      promoted_at: new Date().toISOString(),
      promotion_reason: args.reason || null,
    },
  };
  let patchRes;
  try {
    patchRes = await httpRequest('PATCH', `/api/memory/${encodeURIComponent(memId)}`, patchBody);
  } catch (e) {
    console.error(`skb-promote: SKB created (${skbId}) but failed to mark source memory promoted: ${e.message || e}`);
    process.exit(1);
  }
  if (patchRes.status !== 200) {
    console.error(`skb-promote: SKB created (${skbId}) but PATCH failed: ${(patchRes.data && patchRes.data.error) || patchRes.status}`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({ promoted: true, mem_id: memId, skb_id: skbId, reason: args.reason || null }, null, 2));
    return;
  }
  console.log(`\x1b[92mPromoted\x1b[0m ${memId} -> SKB ${skbId}`);
  if (args.reason) console.log(`  Reason: ${args.reason}`);
}

async function cmdSkbRemove(args) {
  const skbId = (args._positional || [])[0];
  if (!skbId || !skbId.startsWith('skb-')) {
    console.error('Usage: gsd-memory skb-remove <skb-XXXX>');
    process.exit(1);
  }

  // 1. Fetch the SKB entry to find source_mem_id
  let skbRes;
  try {
    skbRes = await httpRequest('GET', `/api/skb/${encodeURIComponent(skbId)}`);
  } catch (e) {
    console.error(`skb-remove failed: could not fetch ${skbId}: ${e.message || e}`);
    process.exit(1);
  }
  if (skbRes.status === 404) {
    console.error(`Not found: ${skbId}`);
    process.exit(1);
  }
  if (skbRes.status !== 200) {
    console.error(`Error fetching ${skbId}: ${(skbRes.data && skbRes.data.error) || skbRes.status}`);
    process.exit(1);
  }
  const skb = skbRes.data || {};
  // source_task format: "promoted_from:mem-XXXX" — parse the mem-id out for demotion
  let sourceMemId = null;
  if (skb.source_task && typeof skb.source_task === 'string' && skb.source_task.startsWith('promoted_from:')) {
    sourceMemId = skb.source_task.slice('promoted_from:'.length);
  }

  // 2. Delete the SKB entry
  let delRes;
  try {
    delRes = await httpRequest('DELETE', `/api/skb/${encodeURIComponent(skbId)}`);
  } catch (e) {
    console.error(`skb-remove failed: ${e.message || e}`);
    process.exit(1);
  }
  if (delRes.status !== 200) {
    console.error(`Error deleting ${skbId}: ${(delRes.data && delRes.data.error) || delRes.status}`);
    process.exit(1);
  }

  // 3. Clear promoted_to_skb flag on source memory (best effort)
  if (sourceMemId && sourceMemId.startsWith('mem-')) {
    const patchBody = {
      metadata_patch: {
        promoted_to_skb: false,
        skb_id: null,
        demoted_at: new Date().toISOString(),
      },
    };
    try {
      const patchRes = await httpRequest('PATCH', `/api/memory/${encodeURIComponent(sourceMemId)}`, patchBody);
      if (patchRes.status !== 200) {
        console.warn(`skb-remove: SKB deleted but failed to clear source memory flag: ${patchRes.status} ${(patchRes.data && patchRes.data.error) || ''}`);
      }
    } catch (e) {
      console.warn(`skb-remove: SKB deleted but failed to clear source memory flag: ${e.message || e}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ removed: true, skb_id: skbId, source_mem_id: sourceMemId }, null, 2));
    return;
  }
  console.log(`\x1b[92mRemoved SKB\x1b[0m ${skbId}${sourceMemId ? `  (source ${sourceMemId} demoted)` : ''}`);
}

// Nested dispatch for `gsd-memory skb <verb>` — supports the space-separated
// form alongside the hyphenated legacy commands (skb-search / skb-add / etc.).
// New Phase 10 commands (candidates / promote / remove) expose both forms so
// callers can use whichever style they prefer.
async function cmdSkb(args) {
  const sub = (args._positional || [])[0];
  args._positional = (args._positional || []).slice(1);
  switch (sub) {
    case 'candidates':
      return await cmdSkbCandidates(args);
    case 'promote':
      return await cmdSkbPromote(args);
    case 'remove':
      return await cmdSkbRemove(args);
    case 'search':
      return await cmdSKBSearch(args);
    case 'add':
      return await cmdSKBAdd(args);
    case 'list':
      return await cmdSKBList(args);
    default:
      console.error('Usage: gsd-memory skb <candidates|promote|remove|search|add|list> [args]');
      process.exit(1);
  }
}

async function cmdHealth(args) {
  try {
    const res = await httpRequest('GET', '/health');
    if (args.json) {
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    const d = res.data;
    console.log(`Daemon: ${d.status === 'ok' ? '\x1b[92mok\x1b[0m' : '\x1b[91merror\x1b[0m'} (PID ${d.pid})`);
    console.log(`PG:     ${d.pg_available ? '\x1b[92mconnected\x1b[0m' : '\x1b[91mnot available\x1b[0m'}`);
    if (d.pg_health) {
      console.log(`PG DSN: ${d.pg_health.dsn_host || 'unknown'}`);
    }
  } catch (err) {
    console.error(`\x1b[91mDaemon not reachable:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════
// Cross-Project Memory Search (TK-0055)
// ═══════════════════════════════════════════════════════

async function cmdCrossProject(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory cross-project <query> [--tags <t1,t2>] [--exclude <project_id>] [--limit <n>] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '10', 10) };
  if (args.tags) body.tags = normalizeTagsList(args.tags.split(',').map(t => t.trim().toLowerCase()));
  if (args.exclude) body.exclude_project = args.exclude;

  const res = await tryDaemon('POST', '/api/memory/cross-project', body);

  if (!res) {
    process.stderr.write(FILE_MODE_WARN);
    // File fallback: just do a normal search (no cross-project in file mode)
    const results = fileSearch(query).slice(0, body.limit);
    if (args.json) {
      console.log(JSON.stringify({ results, count: results.length, mode: 'file' }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('\x1b[2mNo cross-project learnings found.\x1b[0m');
      return;
    }
    console.log(`\n\x1b[1mLocal Learnings\x1b[0m  (${results.length} results)\x1b[2m  — file mode: cross-project requires PostgreSQL\x1b[0m\n`);
    results.forEach((mem, i) => process.stdout.write(formatMemory(mem, i)));
    console.log('');
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  if (results.length === 0) {
    console.log('\x1b[2mNo cross-project learnings found.\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1mCross-Project Learnings\x1b[0m  (${results.length} results)\n`);
  results.forEach((mem, i) => process.stdout.write(formatMemory(mem, i)));
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Auto-Capture (session learning before context compaction)
// ═══════════════════════════════════════════════════════

async function cmdAutoCapture(args) {
  const context = args._positional.join(' ');
  if (!context) {
    console.error('Usage: gsd-memory auto-capture <context> [--agent <id>] [--project <id>] [--reason <reason>] [--tags <t1,t2>]');
    process.exit(1);
  }

  const body = {
    context,
    agent_id: args.agent || 'unknown',
    reason: args.reason || 'context_compaction',
  };
  body.project_id = autoProjectId(args.project);
  if (args.tags) body.tags = normalizeTagsList(args.tags.split(',').map(t => t.trim()));

  const res = await tryDaemon('POST', '/api/memory/auto-capture', body);

  if (!res) {
    // File-based fallback
    process.stderr.write(FILE_MODE_WARN);
    const id = fileStore(context, 'session-learning');
    if (args.json) {
      console.log(JSON.stringify({ id, stored: true, mode: 'file' }, null, 2));
    } else {
      console.log(`\x1b[92mAuto-captured\x1b[0m ${id} (session-learning, file mode)`);
    }
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
  } else {
    console.log(`\x1b[92mAuto-captured\x1b[0m ${res.data.id} (${res.data.chars} chars, source: session-learning)`);
  }
}

// ═══════════════════════════════════════════════════════
// Semantic Search (pgvector embeddings)
// ═══════════════════════════════════════════════════════

async function cmdSemanticSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory semantic-search <query> [--project <id>] [--source <src>] [--limit <n>] [--include-noise] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '20', 10) };
  if (args.project) body.project_id = args.project;
  if (args.source) body.source = args.source;
  // MEM-01: --include-noise bypasses default exclusion of task_event/rpetd_phase
  if (args['include-noise']) body.include_noise = true;

  const res = await tryDaemon('POST', '/api/memory/semantic-search', body);

  if (!res) {
    process.stderr.write(FILE_MODE_WARN);
    // Fall back to regular file search (no embeddings in file mode)
    const results = fileSearch(query).slice(0, body.limit);
    if (args.json) {
      console.log(JSON.stringify({ results, count: results.length, mode: 'file', method: 'text' }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('\x1b[2mNo results found.\x1b[0m');
      return;
    }
    console.log(`\n\x1b[1mSemantic Search\x1b[0m  (${results.length} results, file fallback)\n`);
    results.forEach((mem, i) => process.stdout.write(formatMemory(mem, i)));
    console.log('');
    return;
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const results = res.data.results || [];
  const method = res.data.method || 'unknown';
  if (results.length === 0) {
    console.log('\x1b[2mNo semantic matches found.\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1mSemantic Search\x1b[0m  (${results.length} results, method: ${method})\n`);
  results.forEach((mem, i) => {
    const similarity = mem.semantic_similarity ? ` \x1b[36m[sim: ${mem.semantic_similarity}]\x1b[0m` : '';
    process.stdout.write(formatMemory(mem, i) + similarity + '\n');
  });
  console.log('');
}

async function cmdBackfillEmbeddings(args) {
  const batchSize = parseInt(args['batch-size'] || args.batch || '50', 10);

  const res = await tryDaemon('POST', '/api/memory/backfill-embeddings', { batch_size: batchSize });

  if (!res) {
    console.error('\x1b[91mDaemon not available.\x1b[0m Backfill requires PG daemon.');
    process.exit(1);
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const d = res.data;
  if (d.error) {
    console.error(`\x1b[91m${d.error}\x1b[0m`);
    process.exit(1);
  }

  if (d.processed === 0) {
    console.log('\x1b[92mAll memories already have embeddings.\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1mEmbedding Backfill\x1b[0m`);
  console.log(`  Processed: ${d.processed}`);
  console.log(`  Succeeded: \x1b[92m${d.succeeded}\x1b[0m`);
  if (d.failed > 0) console.log(`  Failed:    \x1b[91m${d.failed}\x1b[0m`);
  console.log(`  Remaining: ${d.remaining}`);
  console.log('');
}

async function cmdEmbeddingStats(args) {
  const res = await tryDaemon('GET', '/api/memory/embedding-stats');

  if (!res) {
    console.error('\x1b[91mDaemon not available.\x1b[0m');
    process.exit(1);
  }

  if (res.status !== 200) {
    console.error('Error:', res.data.error || 'Unknown error');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const d = res.data;
  console.log(`\n\x1b[1mEmbedding Coverage\x1b[0m`);
  console.log(`  Total memories:    ${d.total}`);
  console.log(`  With embeddings:   \x1b[92m${d.with_embedding}\x1b[0m`);
  console.log(`  Without embeddings: ${d.without_embedding}`);
  console.log(`  Coverage:          ${d.coverage_pct}%`);
  console.log(`\n\x1b[1mProvider\x1b[0m`);
  console.log(`  Active:     ${d.provider === 'none' ? '\x1b[91mnone (no API key set)\x1b[0m' : `\x1b[92m${d.provider}\x1b[0m`}`);
  console.log(`  Model:      ${d.model || 'none'}`);
  console.log(`  Dimensions: ${d.dimensions || 0}`);
  if (d.provider === 'none') {
    console.log(`\n  Set VOYAGE_API_KEY (recommended) or OPENAI_API_KEY to enable embeddings.`);
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Technology Tag Inference (TK-0056)
// ═══════════════════════════════════════════════════════

function inferTechTags(projectDir) {
  const tags = new Set();

  // ─── package.json (Node.js / JS / TS) ─────────────
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    tags.add('javascript');
    tags.add('nodejs');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      // Frameworks
      if (allDeps.react || allDeps['react-dom']) tags.add('react');
      if (allDeps.next) tags.add('nextjs');
      if (allDeps.vue) tags.add('vue');
      if (allDeps.nuxt) tags.add('nuxt');
      if (allDeps.angular || allDeps['@angular/core']) tags.add('angular');
      if (allDeps.svelte) tags.add('svelte');
      if (allDeps.express) tags.add('express');
      if (allDeps.fastify) tags.add('fastify');
      if (allDeps.nestjs || allDeps['@nestjs/core']) tags.add('nestjs');
      if (allDeps.hono) tags.add('hono');

      // Databases
      if (allDeps.pg || allDeps.postgres || allDeps.knex || allDeps.prisma || allDeps['@prisma/client']) tags.add('postgresql');
      if (allDeps.mysql2 || allDeps.mysql) tags.add('mysql');
      if (allDeps.mongodb || allDeps.mongoose) tags.add('mongodb');
      if (allDeps.redis || allDeps.ioredis) tags.add('redis');
      if (allDeps['better-sqlite3'] || allDeps.sqlite3) tags.add('sqlite');

      // ORM / query builders
      if (allDeps.prisma || allDeps['@prisma/client']) tags.add('prisma');
      if (allDeps.drizzle || allDeps['drizzle-orm']) tags.add('drizzle');
      if (allDeps.typeorm) tags.add('typeorm');
      if (allDeps.sequelize) tags.add('sequelize');
      if (allDeps.knex) tags.add('knex');

      // TypeScript
      if (allDeps.typescript || allDeps['ts-node']) tags.add('typescript');

      // Testing
      if (allDeps.jest || allDeps['@jest/core']) tags.add('jest');
      if (allDeps.vitest) tags.add('vitest');
      if (allDeps.mocha) tags.add('mocha');
      if (allDeps.playwright || allDeps['@playwright/test']) tags.add('playwright');
      if (allDeps.cypress) tags.add('cypress');

      // CSS / Styling
      if (allDeps.tailwindcss) tags.add('tailwindcss');

      // State management
      if (allDeps.zustand) tags.add('zustand');
      if (allDeps.redux || allDeps['@reduxjs/toolkit']) tags.add('redux');

      // Build tools
      if (allDeps.vite) tags.add('vite');
      if (allDeps.webpack) tags.add('webpack');
      if (allDeps.turbo || allDeps.turborepo) tags.add('turborepo');

      // Auth
      if (allDeps['next-auth'] || allDeps['@auth/core']) tags.add('auth');

      // GraphQL
      if (allDeps.graphql || allDeps['@apollo/client'] || allDeps['@apollo/server']) tags.add('graphql');

      // tRPC
      if (allDeps['@trpc/server'] || allDeps['@trpc/client']) tags.add('trpc');

      // Docker marker from scripts
      const scripts = pkg.scripts || {};
      const scriptStr = JSON.stringify(scripts);
      if (scriptStr.includes('docker')) tags.add('docker');

    } catch { /* ignore parse errors */ }
  }

  // ─── requirements.txt / pyproject.toml (Python) ────
  const reqPath = path.join(projectDir, 'requirements.txt');
  const pyprojectPath = path.join(projectDir, 'pyproject.toml');
  const setupPyPath = path.join(projectDir, 'setup.py');

  if (fs.existsSync(reqPath) || fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath)) {
    tags.add('python');

    let depText = '';
    if (fs.existsSync(reqPath)) depText += fs.readFileSync(reqPath, 'utf-8');
    if (fs.existsSync(pyprojectPath)) depText += fs.readFileSync(pyprojectPath, 'utf-8');

    const lower = depText.toLowerCase();
    if (lower.includes('django')) tags.add('django');
    if (lower.includes('flask')) tags.add('flask');
    if (lower.includes('fastapi')) tags.add('fastapi');
    if (lower.includes('sqlalchemy')) tags.add('sqlalchemy');
    if (lower.includes('psycopg')) tags.add('postgresql');
    if (lower.includes('celery')) tags.add('celery');
    if (lower.includes('pytest')) tags.add('pytest');
    if (lower.includes('pytorch') || lower.includes('torch')) tags.add('pytorch');
    if (lower.includes('tensorflow')) tags.add('tensorflow');
    if (lower.includes('pandas')) tags.add('pandas');
    if (lower.includes('numpy')) tags.add('numpy');
    if (lower.includes('redis')) tags.add('redis');
    if (lower.includes('pydantic')) tags.add('pydantic');
    if (lower.includes('aiohttp') || lower.includes('httpx')) tags.add('async-http');
  }

  // ─── Dockerfile ────────────────────────────────────
  const dockerfilePath = path.join(projectDir, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    tags.add('docker');
    try {
      const content = fs.readFileSync(dockerfilePath, 'utf-8');
      const fromLine = content.match(/^FROM\s+(\S+)/im);
      if (fromLine) {
        const img = fromLine[1].toLowerCase();
        if (img.includes('node')) tags.add('nodejs');
        if (img.includes('python')) tags.add('python');
        if (img.includes('golang') || img.includes('go:')) tags.add('golang');
        if (img.includes('rust')) tags.add('rust');
        if (img.includes('nginx')) tags.add('nginx');
        if (img.includes('postgres')) tags.add('postgresql');
        if (img.includes('redis')) tags.add('redis');
      }
    } catch { /* ignore */ }
  }

  // ─── docker-compose.yml ────────────────────────────
  const composePaths = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const cp of composePaths) {
    const composePath = path.join(projectDir, cp);
    if (fs.existsSync(composePath)) {
      tags.add('docker');
      tags.add('docker-compose');
      try {
        const content = fs.readFileSync(composePath, 'utf-8').toLowerCase();
        if (content.includes('postgres')) tags.add('postgresql');
        if (content.includes('redis')) tags.add('redis');
        if (content.includes('mongo')) tags.add('mongodb');
        if (content.includes('rabbit')) tags.add('rabbitmq');
        if (content.includes('kafka')) tags.add('kafka');
        if (content.includes('elasticsearch')) tags.add('elasticsearch');
        if (content.includes('nginx')) tags.add('nginx');
      } catch { /* ignore */ }
      break;
    }
  }

  // ─── Go ────────────────────────────────────────────
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    tags.add('golang');
    try {
      const content = fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf-8').toLowerCase();
      if (content.includes('gin-gonic')) tags.add('gin');
      if (content.includes('fiber')) tags.add('fiber');
      if (content.includes('pgx') || content.includes('pq')) tags.add('postgresql');
    } catch { /* ignore */ }
  }

  // ─── Rust ──────────────────────────────────────────
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) {
    tags.add('rust');
    try {
      const content = fs.readFileSync(path.join(projectDir, 'Cargo.toml'), 'utf-8').toLowerCase();
      if (content.includes('actix')) tags.add('actix');
      if (content.includes('axum')) tags.add('axum');
      if (content.includes('tokio')) tags.add('tokio');
      if (content.includes('diesel') || content.includes('sqlx')) tags.add('postgresql');
    } catch { /* ignore */ }
  }

  // ─── Terraform / IaC ──────────────────────────────
  if (fs.existsSync(path.join(projectDir, 'main.tf')) ||
      fs.existsSync(path.join(projectDir, 'terraform'))) {
    tags.add('terraform');
    tags.add('infrastructure-as-code');
  }

  // ─── tsconfig.json → confirm TypeScript ───────────
  if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    tags.add('typescript');
  }

  return Array.from(tags).sort();
}

async function cmdInferTags(args) {
  const dir = args._positional[0] || process.cwd();
  const resolvedDir = path.resolve(dir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`Error: directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const inferredTags = inferTechTags(resolvedDir);

  if (args.json) {
    console.log(JSON.stringify({ directory: resolvedDir, tags: inferredTags, count: inferredTags.length }, null, 2));
    return;
  }

  if (inferredTags.length === 0) {
    console.log(`\x1b[2mNo technology tags inferred from: ${resolvedDir}\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[1mInferred Technology Tags\x1b[0m  (${inferredTags.length} tags)\n`);
  console.log(`  Directory: ${resolvedDir}\n`);
  inferredTags.forEach(tag => {
    console.log(`  \x1b[96m${tag}\x1b[0m`);
  });
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Distill — Compact old memory entries (TK-0053)
// ═══════════════════════════════════════════════════════

/**
 * Simple word-overlap similarity (Jaccard-like).
 * Returns 0-1 where 1 = identical word sets.
 */
function textSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// TK-0054: Auto-distill trigger — runs after store if count exceeds threshold
const AUTO_DISTILL_THRESHOLD = parseInt(process.env.GSD_MEMORY_DISTILL_THRESHOLD || '500', 10);
const AUTO_DISTILL_COOLDOWN_MS = parseInt(process.env.GSD_MEMORY_DISTILL_COOLDOWN || '300000', 10); // 5 min default
let _lastAutoDistillAt = 0;

async function maybeAutoDistill() {
  try {
    // Debounce: skip if auto-distill ran recently (prevents O(n^2) on every store)
    const now = Date.now();
    if (now - _lastAutoDistillAt < AUTO_DISTILL_COOLDOWN_MS) return;

    // Use server-side distill-status endpoint for threshold check
    const res = await tryDaemon('GET', '/api/memory/distill-status');
    let count = 0;
    let needsDistill = false;
    if (res && res.status === 200) {
      count = res.data.total || 0;
      needsDistill = res.data.needs_distill || false;
    } else {
      // File mode fallback — count file-based entries
      count = fileCount();
      needsDistill = count >= AUTO_DISTILL_THRESHOLD;
    }
    if (needsDistill) {
      _lastAutoDistillAt = now;
      process.stderr.write(`\x1b[2mAuto-distill: ${count} entries exceed threshold. Running distill...\x1b[0m\n`);
      // MEM-M5: auto-distill must use the LLM provider chain (Claude Sonnet >
      // Haiku > Ollama > concatenation) — the canary from plan 66-01 proved
      // the path executes; without 'use-llm' every auto-triggered distill
      // silently degraded to concatenation (signal-lossy, never surfaced).
      await cmdDistill({ threshold: '0.7', 'dry-run': false, 'use-llm': true, _positional: [] });
    }
  } catch { /* silent */ }
}

// ── LLM Distill Helpers (02-03) ─────────────────────────────────────────────

function isOllamaAvailable() {
  try {
    const { execSync } = require('child_process');
    execSync('which ollama', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function selectOllamaModel() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('ollama list', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (output.includes('qwen3:8b')) return 'qwen3:8b';
    if (output.includes('llama3.2:3b')) return 'llama3.2:3b';
    // Fallback: first available model
    const lines = output.trim().split('\n').slice(1);
    if (lines.length > 0) {
      const firstModel = lines[0].split(/\s+/)[0];
      if (firstModel) return firstModel;
    }
    return null;
  } catch {
    return null;
  }
}

function llmSummarize(entries, model) {
  const { execSync } = require('child_process');
  const combinedText = entries.map((e, i) =>
    `[Entry ${i + 1} | source: ${e.source || 'unknown'}]:\n${(e.text || '').slice(0, 800)}`
  ).join('\n\n');

  const prompt = `You are a knowledge distillation assistant. Summarize these ${entries.length} related memory entries into ONE coherent entry that preserves all key facts, decisions, and lessons learned. Output ONLY the summary, no preamble.\n\n${combinedText}`;

  try {
    const result = execSync(
      `ollama run ${model}`,
      {
        input: prompt,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const summary = result.trim();
    if (summary.length < 20) return null; // Too short, likely error
    return summary.slice(0, 4000);
  } catch (err) {
    process.stderr.write(`[distill] LLM summarization failed: ${err.message || err}\n`);
    return null;
  }
}

/**
 * Claude CLI summarization — uses `claude --print` available in Claude Code sessions.
 * No API key needed — uses the active Claude Code authentication.
 * Falls back to Anthropic HTTP API if ANTHROPIC_API_KEY is set and CLI unavailable.
 * @param {Array} entries - Memory entries to summarize
 * @param {string} model - Claude model shortname: 'sonnet' or 'haiku'
 * @returns {string|null}
 */
// Rate-limit backoff (live evidence: `gsd-memory learn` hit "Too many
// requests" during this milestone). Only rate-limit-shaped errors get a
// synchronous retry; every other error falls through immediately to the
// existing provider chain (Haiku > Ollama > concatenation) unchanged.
const CLAUDE_RATE_LIMIT_PATTERN = /too many requests|rate.?limit|429/i;
const CLAUDE_RATE_LIMIT_BACKOFF_MS = [2000, 8000]; // max 2 retries, exponential

function _sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function claudeSummarize(entries, model) {
  const { execSync } = require('child_process');
  const combinedText = entries.map((e, i) =>
    `[Entry ${i + 1} | source: ${e.source || 'unknown'}]:\n${(e.text || '').slice(0, 800)}`
  ).join('\n\n');

  const prompt = `You are a knowledge distillation assistant. Summarize these ${entries.length} related memory entries into ONE coherent entry that preserves all key facts, decisions, and lessons learned. Output ONLY the summary, no preamble.\n\n${combinedText}`;

  // Try claude CLI first (available in Claude Code sessions, no API key needed).
  // Retry loop: max 2 retries (3 total attempts), only on rate-limit-shaped errors.
  for (let attempt = 0; attempt <= CLAUDE_RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    try {
      const result = execSync(
        `claude --print --model ${model}`,
        { input: prompt, timeout: 60000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const summary = (result || '').trim();
      if (summary.length >= 20) return summary.slice(0, 4000);
      process.stderr.write(`[distill] Claude CLI (${model}) returned short output (${summary.length} chars)\n`);
      break; // short output is not a rate-limit condition — fall through to API fallback
    } catch (cliErr) {
      const cliMsg = cliErr.message || '';
      if (CLAUDE_RATE_LIMIT_PATTERN.test(cliMsg) && attempt < CLAUDE_RATE_LIMIT_BACKOFF_MS.length) {
        const backoffMs = CLAUDE_RATE_LIMIT_BACKOFF_MS[attempt];
        process.stderr.write(
          `[distill] Claude CLI (${model}) rate-limited — retrying in ${backoffMs}ms ` +
          `(attempt ${attempt + 1}/${CLAUDE_RATE_LIMIT_BACKOFF_MS.length})\n`
        );
        _sleepSync(backoffMs);
        continue;
      }
      process.stderr.write(`[distill] Claude CLI (${model}) unavailable: ${cliMsg.split('\n')[0]}\n`);
      break;
    }
  }

  // Fall back to Anthropic HTTP API if key is available
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const modelId = model === 'sonnet' ? 'claude-sonnet-4-5-20250514'
        : model === 'haiku' ? 'claude-haiku-4-5-20251001' : model;
      const body = JSON.stringify({
        model: modelId, max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      const curlCmd = `curl -s --max-time 30 -X POST https://api.anthropic.com/v1/messages ` +
        `-H "x-api-key: ${apiKey}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" ` +
        `-d ${JSON.stringify(body)}`;
      const apiResult = execSync(curlCmd, { timeout: 35000, encoding: 'utf8' });
      const parsed = JSON.parse(apiResult);
      if (parsed.content && parsed.content[0] && parsed.content[0].text) {
        const summary = parsed.content[0].text.trim();
        if (summary.length >= 20) return summary.slice(0, 4000);
      }
    } catch (apiErr) {
      process.stderr.write(`[distill] Claude API (${model}) fallback failed: ${apiErr.message.split('\n')[0]}\n`);
    }
  }

  return null;
}

// MEM-L3: distill eligibility pagination — a single limit=1000 fetch capped
// eligibility at the newest 1000 rows, silently ignoring older duplicates in
// a large table. Page through offset=0,500,1000,... until a page returns
// fewer than PAGE_SIZE rows OR the hard cap is reached, whichever comes
// first — bounded so this can never become an unbounded loop against a
// huge gsd_memory table.
const DISTILL_ELIGIBILITY_PAGE_SIZE = 500;
const DISTILL_ELIGIBILITY_HARD_CAP = 5000; // hard cap: max rows considered per distill run

async function cmdDistill(args) {
  const threshold = parseFloat(args.threshold || '0.7');
  const dryRun = !!args['dry-run'];

  // DATA-03: Never re-merge distilled entries — they are output of prior distill runs.
  // Including them causes cascading mega-entries with nested [merged from distilled] markers.
  const rawEntries = [];
  let offset = 0;
  while (rawEntries.length < DISTILL_ELIGIBILITY_HARD_CAP) {
    const pageRes = await tryDaemon(
      'GET',
      `/api/memory/list?limit=${DISTILL_ELIGIBILITY_PAGE_SIZE}&offset=${offset}&exclude_source=distilled`
    );
    if (!pageRes || pageRes.status !== 200) {
      if (offset === 0) {
        console.error('Error: Cannot fetch memories (daemon unavailable or error).');
        process.exit(1);
      }
      break; // later page failed — proceed with what we already have
    }
    const page = pageRes.data.results || [];
    rawEntries.push(...page);
    if (page.length < DISTILL_ELIGIBILITY_PAGE_SIZE) break; // last page
    offset += DISTILL_ELIGIBILITY_PAGE_SIZE;
  }
  if (rawEntries.length > DISTILL_ELIGIBILITY_HARD_CAP) {
    rawEntries.length = DISTILL_ELIGIBILITY_HARD_CAP;
  }

  // Phase 10 LEARN-02: skip structured entries — they are already concise
  // (<=120 char WHAT) and merging would destroy the WHAT/WHY/WHEN/TAGS structure.
  const entries = rawEntries.filter((entry) => {
    const meta = entry && entry.metadata;
    if (meta && typeof meta === 'object' && meta.what) {
      if (process.env.DEBUG) console.warn(`[distill] skipping structured entry ${entry.id}`);
      return false;
    }
    return true;
  });

  if (entries.length < 5) {
    console.log(`\x1b[2mOnly ${entries.length} entries — distill not needed (minimum 5).\x1b[0m`);
    return;
  }

  // Group similar entries (simple O(n^2) — fine for <1000 entries)
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < entries.length; i++) {
    if (assigned.has(i)) continue;
    const group = [entries[i]];
    assigned.add(i);

    for (let j = i + 1; j < entries.length; j++) {
      if (assigned.has(j)) continue;
      const sim = textSimilarity(entries[i].text || '', entries[j].text || '');
      if (sim >= threshold) {
        group.push(entries[j]);
        assigned.add(j);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  if (groups.length === 0) {
    console.log('\x1b[2mNo duplicate groups found at threshold ' + threshold + '.\x1b[0m');
    return;
  }

  // Determine LLM availability for this distill run (02-03, updated: Claude > Ollama chain)
  const useLlm = !!args['use-llm'];
  let ollamaModel = null;
  let ollamaAvailable = false;
  // Claude CLI is always available in Claude Code sessions (no API key needed)
  const claudeAvailable = useLlm;

  if (useLlm) {
    console.log('  Using Claude Code provider chain (Sonnet > Haiku > Ollama > concatenation)');
    // Always check Ollama as a fallback
    if (isOllamaAvailable()) {
      ollamaModel = selectOllamaModel();
      if (ollamaModel) {
        ollamaAvailable = true;
      }
    }
  }

  // Report
  let mergedCount = 0;
  let removedCount = 0;

  console.log(`\n\x1b[1mDistill Report\x1b[0m  (threshold: ${threshold}, ${dryRun ? 'DRY RUN' : 'LIVE'})\n`);

  for (const group of groups) {
    // Keep the longest/most detailed entry as the merge target
    const sorted = group.sort((a, b) => (b.text || '').length - (a.text || '').length);
    const keep = sorted[0];
    const remove = sorted.slice(1);

    console.log(`  \x1b[1mGroup\x1b[0m (${group.length} entries):`);
    console.log(`    \x1b[92mKEEP\x1b[0m:   ${(keep.text || '').slice(0, 80)}... \x1b[2m[${keep.source}]\x1b[0m`);
    for (const r of remove) {
      console.log(`    \x1b[91mMERGE\x1b[0m:  ${(r.text || '').slice(0, 80)}... \x1b[2m[${r.source}]\x1b[0m`);
    }

    if (!dryRun) {
      // Determine merge text and strategy: Claude Sonnet > Claude Haiku > Ollama > concatenation
      let mergedText;
      let distillStrategy;

      // Helper for concatenation fallback
      const concatFallback = () => {
        const text = keep.text + '\n---\n' +
          remove.map(r => `[merged from ${r.source}]: ${(r.text || '').slice(0, 200)}`).join('\n');
        return text.slice(0, 4000);
      };

      if (claudeAvailable) {
        // Try Claude Sonnet first
        const sonnetResult = claudeSummarize(group, 'sonnet');
        if (sonnetResult) {
          mergedText = sonnetResult;
          distillStrategy = 'claude-sonnet';
        } else {
          // Try Claude Haiku as fallback
          const haikuResult = claudeSummarize(group, 'haiku');
          if (haikuResult) {
            mergedText = haikuResult;
            distillStrategy = 'claude-haiku';
          } else if (ollamaAvailable) {
            // Fall back to Ollama
            const ollamaResult = llmSummarize(group, ollamaModel);
            if (ollamaResult) {
              mergedText = ollamaResult;
              distillStrategy = 'ollama';
            } else {
              mergedText = concatFallback();
              distillStrategy = 'concatenation';
            }
          } else {
            mergedText = concatFallback();
            distillStrategy = 'concatenation';
          }
        }
      } else if (ollamaAvailable) {
        const ollamaResult = llmSummarize(group, ollamaModel);
        if (ollamaResult) {
          mergedText = ollamaResult;
          distillStrategy = 'ollama';
        } else {
          mergedText = concatFallback();
          distillStrategy = 'concatenation';
        }
      } else {
        mergedText = concatFallback();
        distillStrategy = 'concatenation';
      }

      // Kill-switch rule: never silently degrade. If the caller asked for the
      // LLM path (use-llm) but every provider in the chain failed and we fell
      // back to concatenation (signal-lossy — loses the distinct facts LLM
      // summarization would have preserved), say so loudly.
      if (useLlm && distillStrategy === 'concatenation') {
        process.stderr.write('[distill] WARNING: LLM unavailable — degraded to concatenation (signal-lossy)\n');
      }

      // MEMR-05 (MEM-M4): signal-preserving merge — carry forward the SUM of
      // applied_count across the group (citations must not reset to zero on
      // distill), the distinct original source strings (merged_sources — read
      // by pg_store.py's _carried_source_bonus to keep the citation/source
      // ranking advantage alive post-merge), and the union of citation
      // records (deduped by task_id so re-distilling an already-merged group
      // doesn't create duplicate citation entries).
      const appliedCountSum = group.reduce((sum, e) => sum + (e.applied_count || 0), 0);
      const mergedSources = [...new Set(group.map(e => e.source))];
      const citationsByTaskId = new Map();
      for (const e of group) {
        const cites = (e.metadata && e.metadata.citations) || [];
        for (const c of cites) {
          const key = (c && c.task_id) || JSON.stringify(c);
          if (!citationsByTaskId.has(key)) citationsByTaskId.set(key, c);
        }
      }
      const mergedCitations = [...citationsByTaskId.values()];

      const mergeBody = {
        text: mergedText,
        source: 'distilled',
        agent_id: keep.agent_id || '',
        applied_count: appliedCountSum,
        // Send metadata as object — the daemon/pg_store.py handles JSON.stringify internally.
        // Previously this was JSON.stringify'd here, causing double-encoding in PG.
        metadata: {
          merged_from: group.map(e => e.id),
          original_count: group.length,
          distilled_at: new Date().toISOString(),
          distill_strategy: distillStrategy,
          distill_model: distillStrategy === 'claude-sonnet' ? 'claude-sonnet-4-5-20250514'
            : distillStrategy === 'claude-haiku' ? 'claude-haiku-4-5-20251001'
            : distillStrategy === 'ollama' ? ollamaModel
            : null,
          merged_sources: mergedSources,
          citations: mergedCitations,
        },
      };

      console.log(`    Strategy: ${distillStrategy}${distillStrategy !== 'concatenation' ? ` (${mergeBody.metadata.distill_model})` : ''}`);

      const storeRes = await tryDaemon('POST', '/api/memory/store', mergeBody);

      // Only delete originals if the merged entry was stored successfully
      // This prevents leaving orphaned merged entries with no originals on store failure
      if (storeRes && storeRes.status === 200) {
        // Delete ONLY the duplicate entries, NOT the 'keep' entry (which is merged into the new one)
        for (const entry of remove) {
          if (entry.id) {
            await tryDaemon('POST', '/api/memory/delete', { id: entry.id }).catch(e =>
              process.stderr.write(`[distill] delete entry ${entry.id} failed: ${e.message || e}\n`));
          }
        }
        // Also delete the original 'keep' entry since it's been replaced by the merged entry
        if (keep.id) {
          await tryDaemon('POST', '/api/memory/delete', { id: keep.id }).catch(e =>
            process.stderr.write(`[distill] delete keep entry ${keep.id} failed: ${e.message || e}\n`));
        }
      } else {
        process.stderr.write(`\x1b[93m[distill]\x1b[0m Store failed for group — originals preserved to avoid data loss.\n`);
      }
    }

    mergedCount++;
    removedCount += remove.length + 1;  // +1 for the 'keep' entry also deleted
    console.log('');
  }

  console.log(`\x1b[1mSummary:\x1b[0m ${groups.length} groups, ${mergedCount} merged, ${removedCount} entries removed.`);
  if (dryRun) {
    console.log('\x1b[33mDry run — no changes made. Run without --dry-run to apply.\x1b[0m');
  }
}

// ═══════════════════════════════════════════════════════
// Infrastructure Status (Smart Detection)
// ═══════════════════════════════════════════════════════

async function cmdStatus(args) {
  const pkg = require('../../package.json');
  const rlmPort = parseInt(process.env.GSD_RLM_PORT || '18798', 10);

  // Helper: check RLM health via HTTP GET to its /health endpoint
  function checkRlmHealth() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: rlmPort,
        path: '/health',
        method: 'GET',
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ running: res.statusCode === 200, port: rlmPort });
        });
      });
      req.on('error', () => resolve({ running: false, port: rlmPort }));
      req.on('timeout', () => { req.destroy(); resolve({ running: false, port: rlmPort }); });
      req.end();
    });
  }

  try {
    // Try daemon health first
    const healthRes = await httpRequest('GET', '/health');
    const h = healthRes.data;

    // Check RLM health in parallel
    const rlmHealth = await checkRlmHealth();

    if (args.json) {
      // Fetch all details for JSON output
      const result = {
        version: pkg.version,
        health: h,
        rlm_status: rlmHealth.running ? 'running' : 'offline',
        rlm_port: rlmHealth.port,
      };
      try {
        const infraRes = await httpRequest('GET', '/api/infra');
        result.infra = infraRes.data;
      } catch { /* optional */ }
      try {
        const distillRes = await httpRequest('GET', '/api/memory/distill-status');
        if (distillRes.status === 200) result.memory_stats = distillRes.data;
      } catch { /* optional */ }
      try {
        const tagRes = await httpRequest('GET', '/api/memory/tag-stats');
        if (tagRes.status === 200) result.tag_stats = tagRes.data;
      } catch { /* optional */ }

      // Embedding coverage for JSON
      try {
        const embRes = await httpRequest('GET', '/api/memory/embedding-coverage');
        if (embRes.status === 200) result.embedding_coverage = embRes.data;
      } catch { /* optional */ }

      // SKB stats for JSON
      try {
        const skbRes = await httpRequest('GET', '/api/skb/list?limit=1');
        if (skbRes.status === 200) result.skb_stats = skbRes.data;
      } catch { /* optional */ }

      // Agent performance for JSON
      try {
        const agents = ['executor-backend', 'executor-frontend', 'executor-infra', 'executor-general'];
        const perfMap = {};
        for (const agent of agents) {
          try {
            const perfRes = await httpRequest('GET', `/api/agent-performance?agent_id=${agent}`);
            if (perfRes.status === 200 && perfRes.data) perfMap[agent] = perfRes.data;
          } catch { /* skip */ }
        }
        if (Object.keys(perfMap).length > 0) result.agent_performance = perfMap;
      } catch { /* optional */ }

      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Header with version
    console.log(`\n\x1b[1mGSD-Amauta v${pkg.version} Status\x1b[0m\n`);

    // Backend detection
    const backend = h.backend || (h.pg_available ? 'postgresql' : 'file');
    const backendColor = backend === 'postgresql' ? '\x1b[92m' :
                         backend === 'sqlite' ? '\x1b[93m' : '\x1b[91m';
    console.log(`  Backend:    ${backendColor}${backend}\x1b[0m`);

    // Connection details
    if (h.pg_health && h.pg_health.status === 'ok') {
      console.log(`  PG Host:    ${h.pg_health.dsn_host || 'unknown'}`);
    } else if (h.sqlite_health && h.sqlite_health.status === 'ok') {
      console.log(`  DB Path:    ${h.sqlite_health.path || 'unknown'}`);
    }

    // Features
    const features = h.features || [];
    if (features.length > 0) {
      console.log(`  Features:   ${features.join(', ')}`);
    }

    // Embeddings
    const hasEmbeddings = features.includes('embeddings');
    const hasVoyage = process.env.VOYAGE_API_KEY || false;
    const hasOpenAI = process.env.OPENAI_API_KEY || false;
    if (hasEmbeddings && (hasVoyage || hasOpenAI)) {
      console.log(`  Embeddings: \x1b[92mavailable\x1b[0m (${hasVoyage ? 'Voyage AI' : 'OpenAI'})`);
    } else if (hasEmbeddings) {
      console.log(`  Embeddings: \x1b[93mnot active\x1b[0m (no VOYAGE_API_KEY or OPENAI_API_KEY)`);
    } else {
      console.log(`  Embeddings: \x1b[90mnot available\x1b[0m (requires PostgreSQL + pgvector)`);
    }

    // Try to get enhanced memory statistics
    try {
      const distillRes = await httpRequest('GET', '/api/memory/distill-status');
      if (distillRes.status === 200) {
        const ds = distillRes.data;
        console.log(`  Memories:   ${ds.total} stored`);

        // Per-source breakdown
        if (ds.by_source && Object.keys(ds.by_source).length > 0) {
          const sorted = Object.entries(ds.by_source).sort((a, b) => b[1] - a[1]);
          const parts = sorted.map(([src, cnt]) => {
            const label = SOURCE_LABELS[src] || src;
            return `${label}: ${cnt}`;
          });
          console.log(`  By source:  ${parts.join(', ')}`);
        }

        // Distillation status
        if (ds.needs_distill) {
          console.log(`  Distill:    \x1b[93mrecommended\x1b[0m (${ds.total} >= ${ds.distill_threshold} threshold)`);
        } else {
          console.log(`  Distill:    \x1b[92mok\x1b[0m (${ds.total} < ${ds.distill_threshold} threshold)`);
        }
      }
    } catch { /* distill-status endpoint may not exist yet */ }

    // Tag distribution
    try {
      const tagRes = await httpRequest('GET', '/api/memory/tag-stats');
      if (tagRes.status === 200 && tagRes.data.unique_tags > 0) {
        const tags = tagRes.data.tags;
        const top5 = Object.entries(tags).slice(0, 5);
        const tagStr = top5.map(([t, c]) => `\x1b[96m${t}\x1b[0m(${c})`).join(', ');
        console.log(`  Tags:       ${tagRes.data.unique_tags} unique — top: ${tagStr}`);
      }
    } catch { /* tag-stats endpoint may not exist yet */ }

    // Embedding coverage
    try {
      const embRes = await httpRequest('GET', '/api/memory/embedding-coverage');
      if (embRes.status === 200 && embRes.data) {
        const ec = embRes.data;
        const pct = ec.total > 0 ? Math.round((ec.with_embeddings / ec.total) * 100) : 0;
        const color = pct >= 80 ? '\x1b[92m' : pct >= 50 ? '\x1b[93m' : '\x1b[91m';
        console.log(`  Embeddings: ${color}${pct}%\x1b[0m coverage (${ec.with_embeddings}/${ec.total} memories)`);
      }
    } catch { /* embedding-coverage endpoint may not exist yet */ }

    // SKB (Shared Knowledge Base) stats
    try {
      const skbRes = await httpRequest('GET', '/api/skb/list?limit=1');
      if (skbRes.status === 200 && skbRes.data) {
        const entries = skbRes.data.total || skbRes.data.count || 0;
        console.log(`  SKB:        ${entries} entries`);
      }
    } catch { /* skb endpoint may not exist yet */ }

    // Agent performance summary
    try {
      const agents = ['executor-backend', 'executor-frontend', 'executor-infra', 'executor-general'];
      const perfParts = [];
      for (const agent of agents) {
        try {
          const perfRes = await httpRequest('GET', `/api/agent-performance?agent_id=${agent}`);
          if (perfRes.status === 200 && perfRes.data && perfRes.data.total_tasks > 0) {
            const p = perfRes.data;
            const rateColor = p.pass_rate >= 80 ? '\x1b[92m' : p.pass_rate >= 60 ? '\x1b[93m' : '\x1b[91m';
            perfParts.push(`${agent.replace('executor-', '')}: ${rateColor}${p.pass_rate}%\x1b[0m (${p.total_tasks})`);
          }
        } catch { /* individual agent query may fail */ }
      }
      if (perfParts.length > 0) {
        console.log(`  Agents:     ${perfParts.join(', ')}`);
      }
    } catch { /* agent performance queries failed */ }

    // Task counts
    try {
      const infraRes = await httpRequest('GET', '/api/infra');
      const infra = infraRes.data;

      if (infra.task_counts) {
        const tc = infra.task_counts;
        const total = Object.values(tc).reduce((a, b) => a + b, 0);
        const parts = [];
        if (tc.pending) parts.push(`${tc.pending} pending`);
        if (tc['in-progress']) parts.push(`${tc['in-progress']} in-progress`);
        if (tc.done) parts.push(`${tc.done} done`);
        if (tc.validation) parts.push(`${tc.validation} validation`);
        console.log(`  Tasks:      ${total} (${parts.join(', ')})`);
      }
    } catch { /* infra endpoint may not exist yet */ }

    // Daemon info
    console.log(`  Daemon:     \x1b[92mrunning\x1b[0m (PID ${h.pid}, port ${h.port})`);

    // RLM info
    if (rlmHealth.running) {
      console.log(`  RLM:        \x1b[92mrunning\x1b[0m (port ${rlmHealth.port})`);
    } else {
      console.log(`  RLM:        \x1b[90moffline\x1b[0m`);
    }
    console.log('');

  } catch (err) {
    // Check RLM even when daemon is offline
    const rlmHealth = await checkRlmHealth();

    if (args.json) {
      console.log(JSON.stringify({
        version: pkg.version,
        daemon: 'offline',
        error: err.message,
        rlm_status: rlmHealth.running ? 'running' : 'offline',
        rlm_port: rlmHealth.port,
      }, null, 2));
      return;
    }
    console.log(`\n\x1b[1mGSD-Amauta v${pkg.version} Status\x1b[0m\n`);
    console.log(`  Daemon:     \x1b[91moffline\x1b[0m`);
    console.log(`  Backend:    \x1b[93mfile mode\x1b[0m (daemon not running)`);

    // Show file-mode counts
    const memCount = fileCount();
    console.log(`  Memories:   ${memCount} (file mode)`);

    // RLM info
    if (rlmHealth.running) {
      console.log(`  RLM:        \x1b[92mrunning\x1b[0m (port ${rlmHealth.port})`);
    } else {
      console.log(`  RLM:        \x1b[90moffline\x1b[0m`);
    }

    console.log(`\n  Start daemon: python3 services/amauta-daemon.py start`);
    console.log('');
  }
}

function printUsage() {
  console.log(`
\x1b[1mAmauta Memory CLI\x1b[0m — PostgreSQL-backed memory for Claude Code agents

\x1b[1mMemory Commands:\x1b[0m
  search <query>       Search memories (source-aware scoring)
  store <text>         Store a memory entry
  learn <text>         Store with auto_learning source (shortcut)
  list                 List recent memories
  count                Count total memories
  distill              Compact old entries (merge duplicates)
  auto-capture <text>  Store session context before compaction

\x1b[1mSemantic Search (pgvector):\x1b[0m
  semantic-search <q>  Search using embedding similarity (requires OPENAI_API_KEY)
  backfill-embeddings  Generate embeddings for existing memories
  embedding-stats      Show embedding coverage statistics

\x1b[1mCross-Project Commands:\x1b[0m
  cross-project <q>    Search learnings across all projects
  infer-tags [dir]     Infer technology tags from project files

\x1b[1mSKB Commands:\x1b[0m
  skb-search <query>   Search shared knowledge base
  skb-add <title>      Add SKB entry (requires --content)
  skb-list             List SKB entries

\x1b[1mSystem:\x1b[0m
  status               Show backend, features, and counts
  health               Check daemon & PG status

\x1b[1mOptions:\x1b[0m
  --source <src>       Memory source (agent, lesson-learned, auto_learning, etc.)
  --agent <id>         Agent ID filter
  --project <id>       Project ID filter
  --tags <t1,t2>       Comma-separated tags
  --exclude <id>       Exclude project ID (for cross-project)
  --category <cat>     SKB category
  --importance <n>     SKB importance (1-10)
  --limit <n>          Result limit (default: 20)
  --offset <n>         Pagination offset
  --threshold <0-1>    Similarity threshold for distill (default: 0.7)
  --dry-run            Preview distill without changes
  --use-llm            Use LLM summarization (Claude Sonnet > Haiku > Ollama > concat)
  --json               Raw JSON output
  --content <text>     SKB entry content (required for skb-add)
  --task <id>          Source task ID for SKB entries
`);
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  const commands = {
    'search': cmdSearch,
    'store': cmdStore,
    'learn': cmdLearn,
    'parse-learning': cmdParseLearning,
    'increment-applied': cmdIncrementApplied,
    'list': cmdList,
    'count': cmdCount,
    'distill': cmdDistill,
    'auto-capture': cmdAutoCapture,
    'cross-project': cmdCrossProject,
    'semantic-search': cmdSemanticSearch,
    'backfill-embeddings': cmdBackfillEmbeddings,
    'embedding-stats': cmdEmbeddingStats,
    'infer-tags': cmdInferTags,
    'skb': cmdSkb,
    'skb-search': cmdSKBSearch,
    'skb-add': cmdSKBAdd,
    'skb-list': cmdSKBList,
    'skb-candidates': cmdSkbCandidates,
    'skb-promote': cmdSkbPromote,
    'skb-remove': cmdSkbRemove,
    'status': cmdStatus,
    'health': cmdHealth,
    'help': () => { printUsage(); },
  };

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    console.error(`\x1b[91mError:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}

// ── Test exports (02-03, Phase 10 LEARN-02/04) ──────────────────────────────
// Exported for unit testing only. Not part of the public CLI API.
if (require.main !== module) {
  module.exports = {
    _test_isOllamaAvailable: isOllamaAvailable,
    _test_selectOllamaModel: selectOllamaModel,
    _test_llmSummarize: llmSummarize,
    _test_claudeSummarize: claudeSummarize,
    // Phase 10 LEARN-04: tag governance helpers
    loadTagRules,
    normalizeTags,
    normalizeTagsList,
    tagTier,
    // Phase 10 LEARN-02: structured learning parser
    parseLearningBlock,
    splitLearningBlocks,
    validateLengthCaps,
    CATEGORY_SET,
    MAX_WHAT,
    MAX_WHY,
    MAX_WHEN,
  };
} else {
  main();
}
