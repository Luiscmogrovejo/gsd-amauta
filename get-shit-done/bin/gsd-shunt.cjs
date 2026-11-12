#!/usr/bin/env node
'use strict';

/**
 * gsd-shunt — route I/O-heavy work to a cheap worker model.
 *
 *   gsd-shunt bulk-read  --question "<q>" --paths <file> [<file>...]
 *   gsd-shunt code-write --spec "<spec>" --reference <file> [<file>...] [--target <file>] [--force]
 *   gsd-shunt stats [--json]
 *
 * bulk-read  : the worker reads the files and answers the question in
 *              bullets with line numbers. The corpus never enters the
 *              caller's context; only the answer does.
 * code-write : the worker writes a pattern-following file (tests, stubs,
 *              config) from a spec and at least one reference file. With
 *              --target the code goes straight to disk and only the path
 *              is printed.
 *
 * It is a plain CLI on purpose: it works from the main thread and from any
 * subagent (most GSD agents have no Task tool), and the model is pinned
 * here, not left to a profile lookup.
 *
 * Backends (ORC-05, plan 88-17 — decided once in lib/runtime-llm.cjs): the host
 * runtime CLI in headless mode first, and a direct Messages API call only when
 * GSD_SHUNT_BACKEND=api (or GSD_LLM_BACKEND=api) is set explicitly. The presence
 * of an API key in the environment never selects the API.
 * Model: GSD_SHUNT_MODEL, default `haiku`.
 * Not for debugging, design decisions or security review — the worker
 * reports locations for those and the caller decides.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeLlm = require('./lib/runtime-llm.cjs');

const MAX_INPUT_CHARS = intEnv('GSD_SHUNT_MAX_INPUT_CHARS', 600000); // ~150k tokens
const TIMEOUT_MS = intEnv('GSD_SHUNT_TIMEOUT_MS', 180000);
const LOG = process.env.GSD_SHUNT_LOG || path.join(os.homedir(), '.amauta', 'shunt', 'log.jsonl');

const READER_SYSTEM = [
  'You are a precise code and document analyst working for another agent that wants to save context.',
  'Answer only the question asked, from the files provided. Do not use tools.',
  'Output structured bullets only: no greeting, no intro, no closing summary.',
  'Each file is given with line numbers. Lead every bullet with the exact name or `path:line` it refers to; use nested bullets for detail.',
  'Quote code only when asked, at most 15 lines per quote.',
  'If something asked about is not in the files, write "not found in <files>" instead of guessing.',
  'For anything needing judgement you are unsure of (bugs, concurrency, security), list the locations and write "needs main-model review" instead of concluding.',
  'Keep the whole answer under about 400 words unless asked for more.',
].join('\n');

const WRITER_SYSTEM = [
  'You generate one code file from a spec and reference files. Do not use tools.',
  'Match the reference files\' patterns, conventions, naming, imports and style exactly.',
  'Output only the file content: no explanation, no markdown fences, no leading or trailing commentary.',
  'If the spec is ambiguous, make the choice that best matches the reference code.',
].join('\n');

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function die(msg, code) {
  process.stderr.write(`gsd-shunt: ${msg}\n`);
  process.exit(code || 1);
}

/** parseArgs(argv) — flags take one value, except list flags which take many. */
function parseArgs(argv) {
  const LIST = new Set(['paths', 'reference']);
  const BOOL = new Set(['force', 'json', 'help']);
  const out = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOL.has(key)) { out[key] = true; i++; continue; }
      if (LIST.has(key)) {
        const vals = [];
        i++;
        while (i < argv.length && !argv[i].startsWith('--')) vals.push(argv[i++]);
        out[key] = (out[key] || []).concat(vals);
        continue;
      }
      out[key] = argv[i + 1];
      i += 2;
      continue;
    }
    out._.push(a);
    i++;
  }
  return out;
}

function numbered(text) {
  const lines = text.split('\n');
  const w = String(lines.length).length;
  return lines.map((l, i) => String(i + 1).padStart(w, ' ') + '\t' + l).join('\n');
}

/** fileBlock(p, withNumbers) — one file wrapped in XML tags for clear boundaries. */
function fileBlock(p, withNumbers) {
  let st;
  try { st = fs.statSync(p); } catch { die(`file not found: ${p}`, 2); }
  if (!st.isFile()) die(`not a file: ${p}`, 2);
  const text = fs.readFileSync(p, 'utf8');
  const body = withNumbers ? numbered(text) : text;
  return `<file path="${p}">\n${body}\n</file>`;
}

function buildCorpus(paths, withNumbers) {
  const blocks = paths.map(p => fileBlock(p, withNumbers));
  const corpus = blocks.join('\n\n');
  if (corpus.length > MAX_INPUT_CHARS) {
    die(`input is ${corpus.length} chars, over the ${MAX_INPUT_CHARS} limit; split the paths into smaller calls`, 2);
  }
  return corpus;
}

function stripFences(text) {
  const t = text.trim();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t) + '\n';
}

function logEvent(event) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(event) + '\n');
  } catch {
    // Metrics are best-effort.
  }
}

// ─── Backends ───────────────────────────────────────────────────────────────

function resolveApiModel(model) {
  try {
    return require('./lib/model-registry.cjs').resolveModelId(model) || model;
  } catch {
    return model;
  }
}

/**
 * Ask the host runtime for a model answer (ORC-05, plan 88-17).
 *
 * Every backend decision lives in get-shit-done/bin/lib/runtime-llm.cjs. This function
 * only maps the shunt's own per-tool override onto the shared one and keeps the result
 * shape report() and logEvent() already read.
 *
 * Before plan 88-17 the backend was `GSD_SHUNT_BACKEND`, or else a ternary on whether
 * the Anthropic API-key variable was set — so the MERE PRESENCE of a key selected the
 * direct Messages API ahead of the runtime CLI the user is already paying for.
 * Presence is not consent: the API is now reached only through an explicit opt-in.
 *
 * GSD_SHUNT_BACKEND keeps working and maps straight onto GSD_LLM_BACKEND's values
 * (`api` / `cli`); it is an explicit per-tool opt-in, which ORC-05 allows.
 *
 * @param {string} system the worker's system prompt (a module constant).
 * @param {string} prompt the corpus and question; UNTRUSTED, so it travels on stdin.
 * @param {number} maxTokens output cap for the opt-in API branch.
 * @returns {Promise<{text: string, backend: string, model: string, truncated: boolean,
 *                    input_tokens: ?number, output_tokens: ?number, cost_usd: ?number}>}
 * @throws {Error} when the chosen backend is unavailable or fails; main() turns that into
 *   an exit-1 with the message, exactly as before.
 */
async function callWorker(system, prompt, maxTokens) {
  if (process.env.GSD_SHUNT_WORKER === '1') die('refusing to run inside a shunt worker (recursion guard)', 2);
  const model = process.env.GSD_SHUNT_MODEL || 'haiku';

  const env = Object.assign({}, process.env, {
    GSD_LLM_BACKEND: process.env.GSD_SHUNT_BACKEND || process.env.GSD_LLM_BACKEND || '',
  });
  const resolved = runtimeLlm.resolveBackend(env);
  if (resolved.backend === 'none') die(`could not run a model: ${resolved.reason}`, 1);

  const res = runtimeLlm.callModel({
    system,
    prompt,
    maxTokens,
    // `haiku` is a CONFIGURED alias (a deliberate small-model choice for this worker),
    // not a hard-coded stand-in for the runtime default, so it is always sent. The
    // direct API needs a concrete id; the CLI accepts the alias.
    model: resolved.backend === 'api' ? resolveApiModel(model) : model,
  }, { env, timeoutMs: TIMEOUT_MS });

  if (!res.ok) throw new Error(res.detail || res.reason);
  res.model = model;
  return res;
}

function report(kind, res, inputChars) {
  const parts = [`worker=${res.model}`, `backend=${res.backend}`, `input_chars=${inputChars}`];
  if (res.input_tokens) parts.push(`in=${res.input_tokens}`);
  if (res.output_tokens) parts.push(`out=${res.output_tokens}`);
  if (res.cost_usd !== null) parts.push(`cost=$${res.cost_usd.toFixed(4)}`);
  process.stderr.write(`[gsd-shunt ${kind}] ${parts.join(' ')}\n`);
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdBulkRead(args) {
  if (!args.question) die('bulk-read needs --question "<question>"', 2);
  if (!args.paths || args.paths.length === 0) die('bulk-read needs --paths <file> [<file>...]', 2);
  const corpus = buildCorpus(args.paths, true);
  const prompt = `${corpus}\n\n<question>\n${args.question}\n</question>`;
  const res = await callWorker(READER_SYSTEM, prompt, 2000);
  if (!res.text.trim()) die('worker returned an empty answer', 1);
  process.stdout.write(res.text.trim() + '\n');
  if (res.truncated) process.stderr.write('[gsd-shunt bulk-read] WARNING: answer hit the output limit and is cut off\n');
  report('bulk-read', res, corpus.length);
  logEvent({
    ts: Math.floor(Date.now() / 1000), event: 'bulk-read', files: args.paths.length,
    input_bytes: corpus.length, output_bytes: res.text.length,
    model: res.model, backend: res.backend, cost_usd: res.cost_usd,
  });
}

async function cmdCodeWrite(args) {
  if (!args.spec) die('code-write needs --spec "<what to generate>"', 2);
  if (!args.reference || args.reference.length === 0) {
    die('code-write needs --reference <file>: without a pattern to match, the output fits nothing in the project', 2);
  }
  if (args.target && fs.existsSync(args.target) && !args.force) {
    die(`target exists: ${args.target} (pass --force to overwrite)`, 2);
  }
  const corpus = buildCorpus(args.reference, false);
  const targetLine = args.target ? `\nThe file will be saved as: ${args.target}` : '';
  const prompt = `<reference_files>\n${corpus}\n</reference_files>\n\n<spec>\n${args.spec}${targetLine}\n</spec>`;
  const res = await callWorker(WRITER_SYSTEM, prompt, 16000);
  const code = stripFences(res.text);
  if (!code.trim()) die('worker returned no code', 1);
  if (res.truncated) {
    die('worker output hit the length limit, so the file would be incomplete; nothing was written. Split the spec into smaller files.', 1);
  }
  if (args.target) {
    fs.mkdirSync(path.dirname(path.resolve(args.target)), { recursive: true });
    fs.writeFileSync(args.target, code);
    process.stdout.write(`wrote ${args.target} (${code.split('\n').length - 1} lines)\n`);
  } else {
    process.stdout.write(code);
  }
  report('code-write', res, corpus.length);
  logEvent({
    ts: Math.floor(Date.now() / 1000), event: 'code-write', files: args.reference.length,
    input_bytes: corpus.length, output_bytes: code.length, to_disk: !!args.target,
    model: res.model, backend: res.backend, cost_usd: res.cost_usd,
  });
}

/** summarize(events) — totals for `stats`; pure, for tests. */
function summarize(events) {
  const s = {
    blocked: 0, warned: 0, blocked_bytes: 0,
    bulk_reads: 0, code_writes: 0, worker_input_bytes: 0, worker_output_bytes: 0,
    worker_cost_usd: 0, by_agent: {},
  };
  for (const e of events) {
    if (e.event === 'blocked' || e.event === 'warned') {
      s[e.event]++;
      s.blocked_bytes += e.bytes || 0;
      const a = e.agent || 'main';
      s.by_agent[a] = (s.by_agent[a] || 0) + 1;
    } else if (e.event === 'bulk-read' || e.event === 'code-write') {
      s[e.event === 'bulk-read' ? 'bulk_reads' : 'code_writes']++;
      s.worker_input_bytes += e.input_bytes || 0;
      s.worker_output_bytes += e.output_bytes || 0;
      s.worker_cost_usd += e.cost_usd || 0;
    }
  }
  // Bytes kept out of the caller's context: blocked whole reads, plus the
  // corpus the worker read minus the answer that came back.
  s.est_tokens_kept_out = Math.round(
    (s.blocked_bytes + Math.max(0, s.worker_input_bytes - s.worker_output_bytes)) / 4);
  s.worker_cost_usd = Math.round(s.worker_cost_usd * 10000) / 10000;
  return s;
}

function cmdStats(args) {
  let events = [];
  try {
    events = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    // No log yet.
  }
  const s = summarize(events);
  if (args.json) { process.stdout.write(JSON.stringify(s) + '\n'); return; }
  process.stdout.write([
    `log: ${LOG} (${events.length} events)`,
    `whole reads blocked: ${s.blocked} (warned only: ${s.warned}), ${Math.round(s.blocked_bytes / 1024)} KB`,
    `worker calls: ${s.bulk_reads} bulk-read, ${s.code_writes} code-write, cost $${s.worker_cost_usd.toFixed(4)}`,
    `estimated tokens kept out of the expensive context: ~${s.est_tokens_kept_out} (bytes/4; an upper bound, since a blocked read may be followed by targeted reads)`,
    `by agent: ${Object.entries(s.by_agent).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
  ].join('\n') + '\n');
}

function usage() {
  process.stdout.write([
    'gsd-shunt — route I/O-heavy work to a cheap worker model',
    '',
    '  gsd-shunt bulk-read  --question "<q>" --paths <file> [<file>...]',
    '  gsd-shunt code-write --spec "<spec>" --reference <file> [<file>...] [--target <file>] [--force]',
    '  gsd-shunt stats [--json]',
    '',
    'Env: GSD_SHUNT_MODEL (default haiku), GSD_SHUNT_BACKEND (api|cli),',
    '     GSD_SHUNT_TIMEOUT_MS, GSD_SHUNT_MAX_INPUT_CHARS, GSD_SHUNT_LOG',
  ].join('\n') + '\n');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) return usage();
  if (cmd === 'bulk-read') return cmdBulkRead(args);
  if (cmd === 'code-write') return cmdCodeWrite(args);
  if (cmd === 'stats') return cmdStats(args);
  die(`unknown command: ${cmd} (try: gsd-shunt help)`, 2);
}

if (require.main === module) {
  main().catch((e) => die(e.message, 1));
}
module.exports = { parseArgs, numbered, stripFences, summarize };
