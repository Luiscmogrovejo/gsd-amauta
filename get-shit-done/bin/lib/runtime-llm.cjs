'use strict';

/**
 * Every model call the harness initiates for itself goes through here (ORC-05).
 *
 * The harness is a plugin of a host runtime and uses that runtime's model. Backend order:
 *   1. the host runtime CLI -- `claude -p` today; Phase 94 (OCX-07) adds an `opencode`
 *      branch to resolveBackend() and nothing else changes;
 *   2. a direct HTTP API call ONLY when GSD_LLM_BACKEND === 'api' is set explicitly;
 *   3. otherwise a typed, non-fatal "no model backend" result.
 *
 * The presence of ANTHROPIC_API_KEY in the environment NEVER selects the API. A user who
 * holds a key for some other purpose must not be billed by this harness. The variable is
 * read in exactly one place in this file -- inside the `GSD_LLM_BACKEND === 'api'` branch
 * of callApi() -- and nowhere else in the product.
 *
 * Security notes that are load-bearing, not decoration:
 *   - The prompt is UNTRUSTED input (file corpora, memory text, user questions). It is
 *     handed to the CLI on **stdin** and to the API in a JSON body. It is never
 *     interpolated into a shell string or a command line on any platform.
 *   - Since the CVE-2024-27980 fix (Node 20.12.2+), `child_process.spawn` refuses a `.cmd`
 *     or `.bat` target without a shell -- and the real `claude` on Windows IS an npm
 *     `claude.cmd` shim. This module therefore spawns such a target through
 *     `cmd.exe /d /s /c`, and builds that command line from **fixed literal tokens and
 *     allowlisted values only**. Anything that cannot be proven safe for cmd.exe's
 *     re-parsing (the system prompt, which is free text) is moved onto stdin instead of
 *     being escaped -- re-opening that CVE to save a line would be a shipped security
 *     defect. See buildCmdLine() and CMD_SAFE_TOKEN.
 *   - The opt-in API branch never puts the key on a command line: it travels in a `0o600`
 *     curl config file inside a `0o700` temp directory which is removed in a `finally`.
 *
 * @module runtime-llm
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const platform = require('./platform.cjs');

/** Name of the host runtime CLI looked up on PATH when no override is set. */
const DEFAULT_CLI_NAME = 'claude';

/**
 * Environment variables that override CLI resolution, in precedence order.
 * `GSD_SHUNT_CLAUDE_BIN` is kept because `gsd-shunt.cjs` has always honoured it and
 * operators' settings files carry it; `GSD_LLM_CLI_BIN` is the new, backend-neutral name
 * and wins when both are set. Either may be a plain path or a JSON array of strings
 * (`["C:\\path\\node.exe","C:\\path\\fake.cjs"]`), the same idiom `GSD_CURL` uses.
 */
const CLI_OVERRIDE_VARS = ['GSD_LLM_CLI_BIN', 'GSD_SHUNT_CLAUDE_BIN'];

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Rate-limit backoff, moved here from `gsd-memory.cjs` so every caller benefits.
 * Live evidence: `gsd-memory learn` hit "Too many requests" during a previous milestone.
 * Only rate-limit-shaped failures retry; every other failure returns immediately.
 */
const RATE_LIMIT_PATTERN = /too many requests|rate.?limit|429/i;
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000];

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_API_MAX_TOKENS = 2000;

/**
 * Characters a token may contain before it is allowed onto a `cmd.exe` command line.
 * Deliberately closed: no `"` (quote breakout), no `%` (delayed/percent expansion), no
 * `& | < > ^ ( )` (cmd metacharacters), no whitespace, no newline. A resolved executable
 * path may contain spaces, so paths are handled by quoteCmdPath(), not by this class.
 */
const CMD_SAFE_TOKEN = /^[A-Za-z0-9_.:=+,@/\\-]*$/;

/** A model alias or concrete model id. Closed class: safe for a cmd.exe command line. */
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Sleep synchronously. `callModel` is synchronous because `gsd-memory.cjs`'s distillation
 * path is, so the backoff cannot be a timer.
 *
 * @param {number} ms milliseconds to block for; non-positive values return at once.
 * @returns {void}
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Parse a CLI override value into a command and leading arguments.
 *
 * @param {string} raw the raw environment value.
 * @returns {{command: string, args: string[]}} command plus any leading arguments.
 */
function parseOverride(raw) {
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
        return { command: parsed[0], args: parsed.slice(1) };
      }
    } catch {
      // A malformed override is treated as a plain path, exactly as resolveTool does.
    }
  }
  return { command: raw, args: [] };
}

/**
 * Resolve the host runtime CLI without running it.
 *
 * Resolution order: `GSD_LLM_CLI_BIN`, then `GSD_SHUNT_CLAUDE_BIN`, then `claude` looked up
 * with `platform.which()` (which uses `where` and PATHEXT on Windows). A literal `which`
 * is rejected by the product lint from plan 88-15, so the lookup must go through there.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] environment to read.
 * @param {{platform?: string}} [opts] `platform` is injectable for tests.
 * @returns {{command: string, args: string[], source: string}|null} null when nothing resolved.
 * @example
 *   resolveCli({ GSD_LLM_CLI_BIN: '/usr/local/bin/claude' });
 *   // -> { command: '/usr/local/bin/claude', args: [], source: 'GSD_LLM_CLI_BIN' }
 */
function resolveCli(env = process.env, opts = {}) {
  for (const name of CLI_OVERRIDE_VARS) {
    const raw = String(env[name] || '').trim();
    if (raw) return Object.assign(parseOverride(raw), { source: name });
  }
  const found = platform.which(DEFAULT_CLI_NAME, { env, platform: opts.platform });
  return found ? { command: found, args: [], source: 'PATH' } : null;
}

/**
 * Decide which backend a call would use, WITHOUT making a call.
 *
 * PHASE 94 / OCX-07 EXTENSION POINT: the `opencode` backend is added HERE and nowhere
 * else. It belongs ahead of the `claude` lookup as another host-runtime candidate; the
 * typed result, the API opt-in rule and every caller stay untouched.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] environment to read.
 * @param {{platform?: string}} [opts] `platform` is injectable for tests.
 * @returns {{backend: 'cli'|'api'|'none', reason: string, cli: ({command: string, args: string[], source: string}|null)}}
 * @example
 *   resolveBackend({}).backend;                          // 'none' on a machine with no claude
 *   resolveBackend({ GSD_LLM_BACKEND: 'api' }).backend;  // 'api' -- explicit opt-in only
 */
function resolveBackend(env = process.env, opts = {}) {
  const explicit = String(env.GSD_LLM_BACKEND || '').trim().toLowerCase();

  if (explicit === 'api') {
    return { backend: 'api', reason: 'GSD_LLM_BACKEND=api (explicit opt-in)', cli: null };
  }

  const cli = resolveCli(env, opts);
  if (cli) {
    return { backend: 'cli', reason: `host runtime CLI via ${cli.source}`, cli };
  }
  if (explicit === 'cli') {
    return {
      backend: 'none',
      reason: 'GSD_LLM_BACKEND=cli but no host runtime CLI could be resolved',
      cli: null,
    };
  }
  return {
    backend: 'none',
    reason: 'no host runtime CLI on PATH and no GSD_LLM_BACKEND=api opt-in',
    cli: null,
  };
}

/**
 * Quote an executable path for a `cmd.exe /d /s /c` command line.
 *
 * @param {string} p the resolved path; it is produced by `where`/an operator override, not
 *   by untrusted input.
 * @returns {string} the path wrapped in double quotes.
 * @throws {Error} when the path contains a character that cannot be quoted safely.
 */
function quoteCmdPath(p) {
  if (/["%\r\n]/.test(p)) {
    throw new Error(`runtime-llm: refusing to build a cmd.exe command line for a path containing " or %: ${p}`);
  }
  return `"${p}"`;
}

/**
 * Build the `cmd.exe /d /s /c` command line for a `.cmd`/`.bat` runtime CLI.
 *
 * Every element is either the quoted target path or a token that matches CMD_SAFE_TOKEN
 * (or the empty string, emitted as `""`). Nothing else is ever concatenated: free text --
 * the prompt and the system prompt -- travels on stdin instead. A token that fails the
 * allowlist throws rather than being escaped, because escaping for cmd.exe is exactly the
 * mistake CVE-2024-27980 was about.
 *
 * @param {string} target the resolved `.cmd`/`.bat` path.
 * @param {string[]} args argument tokens, all of which must be allowlist-safe.
 * @returns {string} the command line handed to cmd.exe with windowsVerbatimArguments.
 * @throws {Error} when an argument is not allowlist-safe.
 * @example
 *   buildCmdLine('C:\\n\\claude.cmd', ['-p', '--output-format', 'json']);
 *   // -> '"C:\\n\\claude.cmd" -p --output-format json'
 */
function buildCmdLine(target, args) {
  const parts = [quoteCmdPath(target)];
  for (const a of args) {
    if (a === '') { parts.push('""'); continue; }
    if (!CMD_SAFE_TOKEN.test(a)) {
      throw new Error(
        'runtime-llm: refusing to place a value on a cmd.exe command line that is not ' +
        'allowlist-safe; free text must travel on stdin (CVE-2024-27980)',
      );
    }
    parts.push(a);
  }
  return parts.join(' ');
}

/**
 * Build the runtime CLI argument vector.
 *
 * The argv is `gsd-shunt.cjs`'s `callCli`, verbatim, minus `--model` when no alias is
 * configured: 88-CONTEXT.md's rule is "`claude -p` with the runtime's default model unless
 * a model alias is configured".
 *
 * @param {{system: ?string, model: ?string, systemOnStdin: boolean}} spec
 * @returns {string[]} the argument vector after the executable.
 */
function buildCliArgs(spec) {
  const args = ['-p'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.system && !spec.systemOnStdin) args.push('--system-prompt', spec.system);
  args.push(
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
  );
  return args;
}

/**
 * Compose the stdin payload.
 *
 * On the `cmd.exe` path the system prompt cannot go on the command line (see
 * buildCmdLine), so it is fenced into the stdin payload instead. The fence is explicit so
 * the model is told where the instructions end and the untrusted material begins.
 *
 * @param {?string} system the system prompt, or null.
 * @param {string} prompt the user prompt (untrusted).
 * @param {boolean} systemOnStdin true when the system prompt must travel on stdin.
 * @returns {string} the bytes written to the child's stdin.
 */
function buildStdin(system, prompt, systemOnStdin) {
  if (!systemOnStdin || !system) return prompt;
  return `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt}`;
}

/**
 * Parse the runtime CLI's `--output-format json` envelope.
 *
 * @param {string} stdout raw stdout from the CLI.
 * @param {string} bin the binary name, for error messages.
 * @returns {{text: string, truncated: boolean, input_tokens: ?number, output_tokens: ?number, cost_usd: ?number}}
 * @throws {Error} when the output is not JSON or the CLI reported an error.
 */
function parseCliJson(stdout, bin) {
  let j;
  try { j = JSON.parse(stdout); } catch { throw new Error(`${bin} output not JSON: ${String(stdout).slice(0, 200)}`); }
  if (j.is_error) throw new Error(`${bin} reported an error: ${String(j.result).slice(0, 300)}`);
  const u = j.usage || {};
  return {
    text: String(j.result || ''),
    truncated: j.stop_reason === 'max_tokens',
    input_tokens:
      (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || null,
    output_tokens: u.output_tokens || null,
    cost_usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
  };
}

/**
 * One CLI attempt. Never retries; callModel owns the backoff loop.
 *
 * @param {{system: ?string, prompt: string, model: ?string}} spec the call.
 * @param {{command: string, args: string[], source: string}} cli the resolved CLI.
 * @param {object} cfg resolved options (env, platform, timeoutMs, spawn).
 * @returns {{ok: true, text: string, truncated: boolean, input_tokens: ?number, output_tokens: ?number, cost_usd: ?number, spawnForm: string, systemDelivery: string, commandLine: ?string}}
 * @throws {Error} on a spawn error, a non-zero exit, or unparseable output.
 */
function cliAttempt(spec, cli, cfg) {
  const isWin = cfg.platform === 'win32';
  const isShim = isWin && /\.(cmd|bat)$/i.test(cli.command);
  const model = spec.model == null ? null : String(spec.model);
  if (model !== null && !MODEL_TOKEN.test(model)) {
    throw new Error(`runtime-llm: refusing a model alias that is not a plain token: ${JSON.stringify(model)}`);
  }

  const cliArgs = buildCliArgs({ system: spec.system, model, systemOnStdin: isShim });
  const input = buildStdin(spec.system, spec.prompt, isShim);
  const childEnv = Object.assign({}, cfg.env, { GSD_SHUNT: 'off', GSD_SHUNT_WORKER: '1' });
  const spawnOpts = {
    input,
    encoding: 'utf8',
    timeout: cfg.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: childEnv,
    windowsHide: true,
  };

  let r;
  let commandLine = null;
  let spawnForm;
  if (isShim) {
    const comspec = cfg.env.ComSpec || cfg.env.COMSPEC || 'cmd.exe';
    commandLine = buildCmdLine(cli.command, [...cli.args, ...cliArgs]);
    spawnForm = 'cmd.exe /d /s /c';
    r = cfg.spawn(comspec, ['/d', '/s', '/c', commandLine],
      Object.assign({}, spawnOpts, { windowsVerbatimArguments: true }));
  } else {
    spawnForm = 'direct';
    r = cfg.spawn(cli.command, [...cli.args, ...cliArgs], spawnOpts);
  }

  if (r.error) throw new Error(`could not run ${cli.command}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${cli.command} exited ${r.status}: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  const parsed = parseCliJson(r.stdout, cli.command);
  return Object.assign({ ok: true }, parsed, {
    spawnForm,
    systemDelivery: isShim ? 'stdin' : 'argv',
    commandLine,
  });
}

/**
 * The default API transport: `curl` reading a `0o600` config file from a `0o700` temp
 * directory, so the key never reaches argv and never survives the call.
 *
 * @param {{body: string, apiKey: string, timeoutMs: number, env: NodeJS.ProcessEnv}} req
 * @returns {{status: number, text: string}} HTTP-ish result; curl exits non-zero on failure.
 * @throws {Error} when curl cannot be run or exits non-zero.
 */
function curlTransport(req) {
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-llm-'));
    fs.chmodSync(tmpDir, 0o700);
    const bodyPath = path.join(tmpDir, 'body.json');
    const cfgPath = path.join(tmpDir, 'curl.cfg');
    fs.writeFileSync(bodyPath, req.body, { mode: 0o600 });
    fs.writeFileSync(cfgPath, [
      'silent',
      `max-time = ${Math.max(1, Math.round(req.timeoutMs / 1000))}`,
      'request = "POST"',
      `url = "${API_URL}"`,
      `header = "x-api-key: ${req.apiKey}"`,
      `header = "anthropic-version: ${API_VERSION}"`,
      'header = "content-type: application/json"',
      `data = "@${bodyPath}"`,
      '',
    ].join('\n'), { mode: 0o600 });

    // A BARE `curl` is resolved by the OS loader, so on Windows the System32 copy always
    // wins. GSD_CURL overrides it (a path, or a JSON array when a launcher needs leading
    // arguments); the key still travels in the config file, never on the command line.
    const tool = platform.resolveTool('GSD_CURL', 'curl', { env: req.env });
    const out = execFileSync(tool.command, [...tool.args, '--config', cfgPath], {
      timeout: req.timeoutMs + 5000,
      encoding: 'utf8',
      env: req.env,
      windowsHide: true,
    });
    return { status: 200, text: String(out || '') };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * The opt-in direct API branch. Reached ONLY when GSD_LLM_BACKEND === 'api'.
 *
 * @param {{system: ?string, prompt: string, model: ?string, maxTokens: ?number}} spec
 * @param {object} cfg resolved options (env, timeoutMs, transport).
 * @returns {{ok: true, text: string, truncated: boolean, input_tokens: ?number, output_tokens: ?number, cost_usd: ?number}
 *          |{ok: false, reason: 'no_backend'|'api_failed', detail: string}}
 */
function callApi(spec, cfg) {
  // The ONLY read of ANTHROPIC_API_KEY in the product, and it is inside the explicit
  // GSD_LLM_BACKEND=api opt-in. Presence alone never reaches this line.
  const apiKey = String(cfg.env.ANTHROPIC_API_KEY || '');
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no_backend',
      detail: 'GSD_LLM_BACKEND=api but ANTHROPIC_API_KEY is empty',
    };
  }
  const payload = { model: spec.model || undefined, max_tokens: spec.maxTokens || DEFAULT_API_MAX_TOKENS };
  if (spec.system) payload.system = spec.system;
  payload.messages = [{ role: 'user', content: spec.prompt }];
  const body = JSON.stringify(payload);

  let res;
  try {
    res = cfg.transport({
      url: API_URL,
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      env: cfg.env,
    });
  } catch (e) {
    return { ok: false, reason: 'api_failed', detail: String((e && e.message) || e).split('\n')[0] };
  }
  let j;
  try { j = JSON.parse(res.text); } catch {
    return { ok: false, reason: 'api_failed', detail: 'API response not parseable' };
  }
  if (res.status && res.status !== 200) {
    return { ok: false, reason: 'api_failed', detail: `API ${res.status}: ${(j.error && j.error.message) || ''}`.trim() };
  }
  if (j.error) {
    return { ok: false, reason: 'api_failed', detail: `API error: ${j.error.message || ''}`.trim() };
  }
  const u = j.usage || {};
  return {
    ok: true,
    text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    truncated: j.stop_reason === 'max_tokens',
    input_tokens: u.input_tokens || null,
    output_tokens: u.output_tokens || null,
    cost_usd: null,
  };
}

/**
 * Make one model call on behalf of the harness.
 *
 * Synchronous on purpose: `gsd-memory.cjs`'s distillation loop is synchronous, and a
 * synchronous result is trivially `await`ed by the asynchronous callers.
 *
 * NEVER throws for a missing backend -- that is the single most important property of this
 * module. It throws only on a programming error (a bad argument, a value that cannot be
 * placed safely on a cmd.exe command line).
 *
 * @param {{system?: ?string, prompt: string, maxTokens?: ?number, model?: ?string}} spec
 *   `model` omitted or null means "let the host runtime pick its default model".
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, timeoutMs?: number,
 *          retryDelaysMs?: number[], sleep?: function(number): void,
 *          spawn?: function, transport?: function}} [opts] injection points for tests.
 * @returns {{ok: true, text: string, backend: 'cli'|'api', model: ?string, attempts: number,
 *            truncated: boolean, input_tokens: ?number, output_tokens: ?number,
 *            cost_usd: ?number, spawnForm?: string, systemDelivery?: string, commandLine?: ?string}
 *          |{ok: false, reason: 'no_backend'|'cli_failed'|'api_failed', detail: string,
 *            backend: 'cli'|'api'|'none', attempts: number}}
 * @throws {TypeError} when `prompt` is not a string.
 * @example
 *   const r = callModel({ prompt: 'say hi', model: 'haiku' });
 *   if (!r.ok && r.reason === 'no_backend') return null;  // degrade, never throw
 */
function callModel(spec, opts = {}) {
  if (!spec || typeof spec.prompt !== 'string') {
    throw new TypeError('runtime-llm: callModel needs { prompt: string }');
  }
  const cfg = {
    env: opts.env || process.env,
    platform: opts.platform || process.platform,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    retryDelaysMs: Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS,
    sleep: opts.sleep || sleepSync,
    spawn: opts.spawn || spawnSync,
    transport: opts.transport || curlTransport,
    onRetry: opts.onRetry || null,
  };
  const call = {
    system: spec.system == null ? null : String(spec.system),
    prompt: spec.prompt,
    model: spec.model == null ? null : String(spec.model),
    maxTokens: spec.maxTokens == null ? null : spec.maxTokens,
  };

  const resolved = resolveBackend(cfg.env, { platform: cfg.platform });

  if (resolved.backend === 'none') {
    return { ok: false, reason: 'no_backend', detail: resolved.reason, backend: 'none', attempts: 0 };
  }

  if (resolved.backend === 'api') {
    const out = callApi(call, cfg);
    return Object.assign(out, { backend: 'api', model: call.model, attempts: 1 });
  }

  // CLI backend, with the rate-limit backoff that used to live in gsd-memory.cjs.
  let attempts = 0;
  let lastDetail = '';
  for (let attempt = 0; attempt <= cfg.retryDelaysMs.length; attempt++) {
    attempts += 1;
    try {
      const out = cliAttempt(call, resolved.cli, cfg);
      return Object.assign(out, { backend: 'cli', model: call.model, attempts });
    } catch (e) {
      const msg = String((e && e.message) || e);
      lastDetail = msg.split('\n')[0];
      if (RATE_LIMIT_PATTERN.test(msg) && attempt < cfg.retryDelaysMs.length) {
        const delay = cfg.retryDelaysMs[attempt];
        if (cfg.onRetry) cfg.onRetry({ attempt: attempt + 1, delayMs: delay, detail: lastDetail });
        cfg.sleep(delay);
        continue;
      }
      break;
    }
  }
  return { ok: false, reason: 'cli_failed', detail: lastDetail, backend: 'cli', attempts };
}

module.exports = {
  resolveBackend,
  resolveCli,
  callModel,
  buildCliArgs,
  buildCmdLine,
  buildStdin,
  RATE_LIMIT_PATTERN,
  DEFAULT_RETRY_DELAYS_MS,
  API_URL,
  CMD_SAFE_TOKEN,
};
