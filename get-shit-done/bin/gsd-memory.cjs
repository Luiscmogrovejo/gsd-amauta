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
 * Environment:
 *   GSD_AMAUTA_PORT      Daemon port (default: 18799)
 *   GSD_AMAUTA_HOST      Daemon host (default: 127.0.0.1)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

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
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(MEMORY_DIR, `${date}.md`);
  const entry = `\n- [${source}] ${new Date().toISOString()}: ${text}\n`;
  fs.appendFileSync(file, entry);
  return `file:${date}`;
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

function parseArgs(argv) {
  const args = { _positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
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

async function cmdSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory search <query> [--agent <id>] [--project <id>] [--source <src>] [--limit <n>] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '20', 10) };
  if (args.agent) body.agent_id = args.agent;
  if (args.project) body.project_id = args.project;
  if (args.source) body.source = args.source;

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
    console.log(`\x1b[2mNo memories found for: "${query}"\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[1mMemory Search: "${query}"\x1b[0m  (${results.length} results)\n`);
  results.forEach((mem, i) => process.stdout.write(formatMemory(mem, i)));
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
  if (args.project) body.project_id = args.project;
  if (args.tags) body.tags = args.tags.split(',').map(t => t.trim());
  if (args.metadata) {
    try { body.metadata = JSON.parse(args.metadata); } catch { /* ignore */ }
  }

  const res = await tryDaemon('POST', '/api/memory/store', body);

  if (!res) {
    // File-based fallback
    process.stderr.write(FILE_MODE_WARN);
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

async function cmdLearn(args) {
  // Shortcut: store with auto_learning source
  // In file mode, use fileLearn for STATE.md integration
  const text = args._positional.join(' ');
  if (!text) {
    console.error('Usage: amauta-memory learn <text>');
    process.exit(1);
  }

  const body = { text, source: 'auto_learning' };
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
    console.error('SKB requires PostgreSQL. Daemon unavailable — start with: python3 ~/.claude/get-shit-done/services/amauta-daemon.py start');
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
    console.error('SKB requires PostgreSQL. Daemon unavailable — start with: python3 ~/.claude/get-shit-done/services/amauta-daemon.py start');
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
    console.error('SKB requires PostgreSQL. Daemon unavailable — start with: python3 ~/.claude/get-shit-done/services/amauta-daemon.py start');
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
  if (args.tags) body.tags = args.tags.split(',').map(t => t.trim().toLowerCase());
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
// Semantic Search (pgvector embeddings)
// ═══════════════════════════════════════════════════════

async function cmdSemanticSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: amauta-memory semantic-search <query> [--project <id>] [--source <src>] [--limit <n>] [--json]');
    process.exit(1);
  }

  const body = { query, limit: parseInt(args.limit || '20', 10) };
  if (args.project) body.project_id = args.project;
  if (args.source) body.source = args.source;

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
const AUTO_DISTILL_THRESHOLD = parseInt(process.env.GSD_MEMORY_DISTILL_THRESHOLD || '100', 10);

async function maybeAutoDistill() {
  try {
    const res = await tryDaemon('GET', '/api/memory/count');
    if (!res || res.status !== 200) return;
    const count = res.data.count || 0;
    if (count >= AUTO_DISTILL_THRESHOLD) {
      process.stderr.write(`\x1b[2mAuto-distill: ${count} entries exceed threshold (${AUTO_DISTILL_THRESHOLD}). Running distill...\x1b[0m\n`);
      await cmdDistill({ threshold: '0.7', 'dry-run': false, _positional: [] });
    }
  } catch { /* silent */ }
}

async function cmdDistill(args) {
  const threshold = parseFloat(args.threshold || '0.7');
  const dryRun = !!args['dry-run'];

  // Fetch all memories
  const res = await tryDaemon('GET', '/api/memory/list?limit=1000');
  if (!res || res.status !== 200) {
    console.error('Error: Cannot fetch memories (daemon unavailable or error).');
    process.exit(1);
  }

  const entries = res.data.results || [];
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
      // Store merged entry with distilled source
      const mergedText = keep.text + '\n---\n' +
        remove.map(r => `[merged from ${r.source}]: ${(r.text || '').slice(0, 200)}`).join('\n');
      const mergeBody = {
        text: mergedText.slice(0, 4000),
        source: 'distilled',
        agent_id: keep.agent_id || '',
        // Send metadata as object — the daemon/pg_store.py handles JSON.stringify internally.
        // Previously this was JSON.stringify'd here, causing double-encoding in PG.
        metadata: {
          merged_from: group.map(e => e.id),
          original_count: group.length,
          distilled_at: new Date().toISOString(),
        },
      };
      const storeRes = await tryDaemon('POST', '/api/memory/store', mergeBody);

      // Only delete originals if the merged entry was stored successfully
      // This prevents leaving orphaned merged entries with no originals on store failure
      if (storeRes && storeRes.status === 200) {
        for (const entry of group) {
          if (entry.id) {
            await tryDaemon('POST', '/api/memory/delete', { id: entry.id }).catch(e => 
              process.stderr.write(`[distill] delete entry ${entry.id} failed: ${e.message || e}\n`));
          }
        }
      } else {
        process.stderr.write(`\x1b[93m[distill]\x1b[0m Store failed for group — originals preserved to avoid data loss.\n`);
      }
    }

    mergedCount++;
    removedCount += remove.length;
    console.log('');
  }

  console.log(`\x1b[1mSummary:\x1b[0m ${groups.length} groups, ${mergedCount} merged, ${removedCount} entries removed.`);
  if (dryRun) {
    console.log('\x1b[33mDry run — no changes made. Run without --dry-run to apply.\x1b[0m');
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
    'list': cmdList,
    'count': cmdCount,
    'distill': cmdDistill,
    'cross-project': cmdCrossProject,
    'semantic-search': cmdSemanticSearch,
    'backfill-embeddings': cmdBackfillEmbeddings,
    'embedding-stats': cmdEmbeddingStats,
    'infer-tags': cmdInferTags,
    'skb-search': cmdSKBSearch,
    'skb-add': cmdSKBAdd,
    'skb-list': cmdSKBList,
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

main();
