'use strict';
/**
 * Plan 88-14 (the ratchet): a lint that fails when a POSIX literal is added anywhere under tests/.
 *
 * Every Windows failure plan 88-14 fixed came from a POSIX literal in a test: a Windows path
 * interpolated into Python source, a literal /tmp, HOME without USERPROFILE, a ":" joined PATH,
 * `ps`/`lsof`, a bare `python3`, a `#!` fake with a chmod. This test finds them so a newly added one
 * fails here instead of on a Windows cell. Plan 88-12 itself added POSIX-only `ps -ww` and `lsof`
 * AFTER the Windows decision had been taken, which is why a one-time cleanup is not enough.
 *
 * Shape (copied from get-shit-done/bin/lib/planning-drift.cjs and its DRIFT_EXCEPTION_STALE):
 * tests/posix-literal-exceptions.json is a COUNTED BASELINE, with no cap, of every existing hit:
 * one entry per (rule, file) with the current hit count, the reason, and the plan that removes it.
 * It is a SCHEDULE, not a permission. The test fails on:
 *   POSIX_LITERAL_NEW              a hit in a (rule, file) pair that has no entry
 *   POSIX_LITERAL_COUNT_ROSE       an entry whose count has risen (the baseline may shrink, never grow)
 *   POSIX_LITERAL_EXCEPTION_STALE  an entry that no longer matches anything (or whose count fell):
 *                                  delete / lower it, so the file cannot rot
 * Plans 88-15 and 88-18 each end with their own `owner_plan` entries removed; the stale check is
 * what proves they did.
 *
 * Eight rules, one subtest each, so a failure names the rule. Two of them (POSIX_SHEBANG_FAKE and
 * POSIX_PY_INTERP) detect with two signals inside a window instead of a parse, so they are
 * ADVISORY by construction; they are errors, not warnings, because an advisory rule that cannot
 * fail teaches nothing.
 *
 * Extension point: RULES and SCAN_ROOTS below are module-level constants. Plan 88-15 appends the
 * PRODUCT roots (get-shit-done/, services/, scripts/, bin/, hooks/) to SCAN_ROOTS and its extra
 * rules to RULES once get-shit-done/bin/lib/platform.cjs and services/_platform.py exist to point
 * violators at.
 *
 * This file and nothing else is excluded from the scan (SELF_EXCLUDE): it holds every pattern as
 * source text and a violation sample for each rule.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Directories scanned. `exts` selects the file types, `exclude` skips subtrees (repo-relative,
 * forward slashes). tests/fixtures is excluded on purpose: it deliberately holds odd content
 * (vulnerable samples, destructive migrations) that is DATA for other tests, not test code.
 * Plan 88-15 appends the product roots here.
 */
const SCAN_ROOTS = [
  { dir: 'tests', exts: ['.cjs', '.py'], exclude: ['tests/fixtures'] },
  // Plan 88-15 appends the PRODUCT roots. 88-CONTEXT.md: "No new literal
  // python3 spawn, os.kill(pid, 0), lsof, ps, which, /tmp or process.env.HOME
  // may be added outside [the two shared modules]; a lint test enforces it for
  // product code AND for tests."
  { dir: 'get-shit-done/bin', exts: ['.cjs', '.js'], exclude: [] },
  { dir: 'bin', exts: ['.cjs', '.js'], exclude: [] },
  { dir: 'scripts', exts: ['.cjs', '.js', '.py'], exclude: [] },
  { dir: 'hooks', exts: ['.cjs', '.js'], exclude: [] },
  { dir: 'services', exts: ['.py'], exclude: [] },
  { dir: '.', exts: ['.py'], exclude: [], files: ['amauta.py'] },
];

/**
 * The two shared platform modules. They are the ONLY files exempt from the
 * product rules, and the exemption lives HERE, in the rule definitions — not
 * in the exceptions file, because a path-based exemption anyone can add to a
 * JSON file is not a boundary.
 */
const SHARED_PLATFORM_MODULES = [
  'get-shit-done/bin/lib/platform.cjs',
  'services/_platform.py',
];

/** Repo-relative paths of the roots that hold PRODUCT code (as opposed to tests/). */
const PRODUCT_ROOTS = ['get-shit-done/bin', 'bin', 'scripts', 'hooks', 'services', 'amauta.py'];

/**
 * Whether a scanned file is product code (so the product-only rules apply).
 * @param {string} rel forward-slash repo-relative path
 * @returns {boolean}
 */
function isProductFile(rel) {
  if (SHARED_PLATFORM_MODULES.includes(rel)) return false;
  return PRODUCT_ROOTS.some((r) => rel === r || rel.startsWith(`${r}/`));
}

/**
 * Whether a scanned file is test code (so the test-only rules apply).
 * @param {string} rel forward-slash repo-relative path
 * @returns {boolean}
 */
function isTestFile(rel) {
  return rel.startsWith('tests/');
}

/**
 * Files that are not scanned because they contain every pattern as source text or as a
 * deliberate violation sample (the lint itself).
 */
const SELF_EXCLUDE = ['tests/88-14-no-posix-literals.test.cjs'];

/** Failure codes of the exceptions comparison. */
const CODES = {
  NEW: 'POSIX_LITERAL_NEW',
  COUNT_ROSE: 'POSIX_LITERAL_COUNT_ROSE',
  EXCEPTION_STALE: 'POSIX_LITERAL_EXCEPTION_STALE',
};

/** Owner values an exceptions entry may carry: the plan that removes the hit, or "none" (permanent, with a reason). */
const OWNER_PLANS = ['88-15', '88-16', '88-17', '88-18', '88-19', 'none'];

const HOME_SIBLING = /USERPROFILE|homeEnv|home-env|applyHomeEnv|useHome/;
const SHEBANG_SIBLING = /0o755|0755|chmod/;
const PY_HINT = /(?:^|[\n`])\s*(?:import |from \w+ import |def |with open)|\bsys\.(?:path|argv|stderr|stdout)\b|\bos\.path\b|\bprint\(|python3? -c/;
/** An expression that is itself path-valued: path.*, __dirname, os.tmpdir(), a temp/home name. */
const PATHY_EXPR = /\bpath\.\w+|__dirname|\btmpdir\b|\bmkdtemp|\bhomedir\b/;
/** `const NAME = path.join(...)` and kin: identifiers known to hold a filesystem path. */
const PATH_DEF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.(?:join|resolve|dirname|normalize)|os\.tmpdir|fs\.mkdtempSync|require\.resolve|process\.cwd)\b/g;
const SAFE_EXPR = /^\s*(pyLiteral|JSON\.stringify)\s*\(/;

/**
 * Whether a trimmed line is a comment in the given language.
 * @param {string} line
 * @param {string} ext '.cjs' or '.py'
 * @returns {boolean}
 */
function isCommentLine(line, ext) {
  const t = line.trim();
  if (ext === '.py') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Count lines matching any of `res` (comment lines are skipped).
 * @param {string[]} lines
 * @param {string} ext
 * @param {RegExp[]} res
 * @returns {number[]} 0-based indexes of matching lines
 */
function matchLines(lines, ext, res) {
  const hits = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line, ext)) return;
    if (res.some((re) => re.test(line))) hits.push(i);
  });
  return hits;
}

/**
 * Yield the template literals of a JavaScript source with their start offset. A crude tokenizer
 * (strings, comments, nested ${} and templates); good enough for the advisory interpolation rule.
 *
 * @param {string} src
 * @returns {Generator<{start: number, text: string}>}
 */
function* templates(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '`') {
      const start = i;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            else if (src[i] === '`') {
              i += 1;
              while (i < n && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
            }
            i += 1;
          }
          continue;
        }
        if (src[i] === '`') break;
        i += 1;
      }
      yield { start, text: src.slice(start, i + 1) };
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * The ${...} expressions inside one template literal.
 * @param {string} tpl
 * @returns {string[]}
 */
function expressionsOf(tpl) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = tpl.indexOf('${', i);
    if (j < 0) return out;
    let depth = 1;
    let k = j + 2;
    while (k < tpl.length && depth) {
      if (tpl[k] === '{') depth += 1;
      else if (tpl[k] === '}') depth -= 1;
      k += 1;
    }
    out.push(tpl.slice(j + 2, k - 1));
    i = k;
  }
}

/**
 * The rule table. `detect(ctx)` returns the 0-based line indexes (or offsets mapped to lines) of
 * the hits in one file; the count of a (rule, file) pair is its length.
 * ctx = { lines: string[], text: string, ext: '.cjs'|'.py' }
 *
 * @type {{id: string, use: string, exts: string[], detect: (ctx: {lines: string[], text: string, ext: string}) => number[]}[]}
 */
const RULES = [
  // -- Plan 88-15: the PRODUCT rules. 88-CONTEXT.md requires a lint for the
  //    product half too. Each is scope:'product', so the two shared platform
  //    modules and every test file are outside them by construction.
  {
    id: 'POSIX_OS_KILL_PROBE',
    scope: 'product',
    use: '_platform.pid_alive (a probe) / _platform.terminate (a signal)',
    exts: ['.py'],
    // On Windows os.kill with any signal but the console-control events calls
    // TerminateProcess, so `os.kill(pid, 0)` KILLS the process it checks.
    detect: ({ lines, ext }) => matchLines(lines, ext, [/\bos\.kill\s*\(/]),
  },
  {
    id: 'POSIX_SIGKILL',
    scope: 'product',
    use: '_platform.terminate(force=True)',
    exts: ['.py'],
    // Anchored on `signal.SIGKILL`, the MECHANISM. A user-facing message that
    // merely names SIGKILL is text, not a signal, and is not a violation.
    detect: ({ lines, ext }) => matchLines(lines, ext, [/\bsignal\.SIGKILL\b/]),
  },
  {
    id: 'POSIX_FORK',
    scope: 'product',
    use: '_platform.daemonize / _platform.detached_popen_kwargs',
    exts: ['.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, [
      /\bos\.fork\s*\(\s*\)/, /\bos\.setsid\s*\(\s*\)/, /\bstart_new_session\s*=/,
    ]),
  },
  {
    id: 'POSIX_FCNTL',
    scope: 'product',
    use: '_platform.file_lock',
    exts: ['.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, [/^\s*import\s+fcntl\b/, /\bfcntl\.(?:flock|lockf)\b/]),
  },
  {
    id: 'POSIX_ENV_HOME',
    scope: 'product',
    use: 'homeDir() from platform.cjs / home_dir() from _platform.py',
    exts: ['.cjs', '.js', '.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, ext === '.py'
      ? [/os\.environ\.get\(\s*["']HOME["']/, /os\.environ\[\s*["']HOME["']\s*\]/, /os\.getenv\(\s*["']HOME["']/]
      : [/process\.env\.HOME\b/]),
  },
  {
    id: 'POSIX_DEVNULL',
    scope: 'product',
    use: "the stdio option (stdio: ['ignore','pipe','ignore'])",
    exts: ['.cjs', '.js'],
    // NAMED EXCLUSION, measured in task 88-15-01: scripts/agent-compiler.cjs's
    // HOOKS_COMMENT_BLOCK carries `2>/dev/null` as EMITTED TEXT -- it is the
    // frontmatter the compiler writes into agents/, whose bytes are pinned by
    // the canaries (34 compiled agents carry the line). It is not a spawn
    // string and it stays. Everything else must use the stdio option.
    detect: ({ lines, ext, rel }) => {
      if (rel === 'scripts/agent-compiler.cjs') return [];
      return matchLines(lines, ext, [/(?:execSync|exec|spawnSync|spawn)\([^)]*2>\/dev\/null/]);
    },
  },
  {
    id: 'POSIX_TMP',
    scope: 'both',
    use: 'fs.mkdtempSync(path.join(os.tmpdir(), ...)) / pytest tmp_path',
    exts: ['.cjs', '.py'],
    // a string literal that IS /tmp or starts with /tmp/
    detect: ({ lines, ext }) => matchLines(lines, ext, [/(['"`])\/tmp(?:\/|\1)/]),
  },
  {
    id: 'POSIX_HOME_ONLY',
    scope: 'test',
    use: 'tests/support/home-env.cjs (homeEnv / applyHomeEnv): HOME, USERPROFILE, HOMEDRIVE, HOMEPATH together',
    exts: ['.cjs', '.py'],
    detect: ({ lines, ext }) => {
      const cjs = /(?<![A-Za-z0-9_])HOME["']?\s*(?::|=(?!=))/;
      const py = /["']HOME["']\s*[:\]]|setenv\(\s*["']HOME["']|(?<![A-Za-z0-9_])HOME=/;
      const hits = [];
      lines.forEach((raw, i) => {
        if (isCommentLine(raw, ext)) return;
        // a local named HOME (const HOME = ...) is not an environment assignment
        const line = raw.replace(/\b(?:const|let|var)\s+HOME\b/g, '');
        if (!(ext === '.py' ? py : cjs).test(line)) return;
        const window = lines.slice(Math.max(0, i - 8), i + 9).join('\n');
        if (!HOME_SIBLING.test(window)) hits.push(i);
      });
      return hits;
    },
  },
  {
    id: 'POSIX_PATH_COLON',
    scope: 'test',
    use: 'path.delimiter / os.pathsep (tests/support/fake-exe.cjs prependPath)',
    exts: ['.cjs', '.py'],
    detect: ({ lines, ext }) => {
      const cjs = [
        /\bPATH["']?\s*[:=][^\n]*\}:/,
        /\bPATH["']?\s*[:=][^\n]*['"`]:['"`]/,
        /\bPATH\b[^\n]*\.join\(\s*['"]:['"]\s*\)/,
        /\bPATH=[^\s'"`]*:/,
      ];
      const py = [/\bPATH\b[^\n]*["']:["']\.join/, /\bPATH\b[^\n]*\+\s*["']:["']/, /\bPATH=[^\s'"]*:/];
      return matchLines(lines, ext, ext === '.py' ? py : cjs);
    },
  },
  {
    id: 'POSIX_PS',
    scope: 'both',
    // NAMED EXCLUSION, measured in task 88-15-01: `docker ps` is NOT the POSIX
    // `ps` (services/infra_detect.py 390, 438, 618 and
    // services/amauta-daemon.py 981). The pattern is anchored on the argv-LIST
    // form `["ps"` / `['ps'`, which `["docker", "ps"` cannot match, so
    // docker ps is excluded by construction, not by an exceptions entry.
    use: 'the live-store-canary helpers (tests) / _platform.process_command and port_holders (product)',
    exts: ['.cjs', '.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, ext === '.py'
      ? [/\[\s*["'](?:ps|lsof)["']/, /subprocess\.\w+\(\s*["'](?:ps|lsof)\b/]
      : [
        /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]ps['"]/,
        /\b(?:execSync|exec)\(\s*[`'"](?:ps|lsof)\s/,
        /['"]lsof['"]/,
      ]),
  },
  {
    id: 'POSIX_WHICH',
    scope: 'both',
    use: 'the platform helper (a PATHEXT-aware which)',
    exts: ['.cjs', '.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, ext === '.py'
      ? [/\[\s*["']which["']/]
      : [/['"`]which\s+[\w$.{}\-/]/, /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]which['"]/]),
  },
  {
    id: 'POSIX_PY3_LITERAL',
    scope: 'both',
    // NAMED EXCLUSION: a user-facing MESSAGE or a documentation string that
    // merely names python3 ("Start it: python3 services/amauta-daemon.py") is
    // not a spawn. The patterns are anchored on a spawn call or an inline
    // `python3 -c` command, so prose is excluded by construction.
    use: 'resolvePython / spawnPython / runPython / launchPython from platform.cjs',
    exts: ['.cjs', '.py'],
    detect: ({ lines, ext }) => matchLines(lines, ext, ext === '.py'
      ? [/\[\s*["']python3["']/, /subprocess\.\w+\(\s*["']python3\b/]
      : [
        /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]python3['"]/,
        /\b(?:execSync|exec)\(\s*[`'"]python3\s/,
        /['"`]python3 -c/,
      ]),
  },
  {
    id: 'POSIX_SHEBANG_FAKE',
    scope: 'test',
    use: 'tests/support/fake-exe.cjs (writeFakeExe)',
    exts: ['.cjs', '.py'],
    // two signals inside a window: a "#!" string and a chmod / 0o755 nearby
    detect: ({ lines, ext }) => {
      const sheb = ext === '.py' ? /["']#!/ : /['"`]#!/;
      const hits = [];
      lines.forEach((raw, i) => {
        if (isCommentLine(raw, ext) || !sheb.test(raw)) return;
        const window = lines.slice(Math.max(0, i - 3), i + 9).join('\n');
        if (SHEBANG_SIBLING.test(window)) hits.push(i);
      });
      return hits;
    },
  },
  {
    id: 'POSIX_PY_INTERP',
    scope: 'test',
    use: 'tests/support/py-embed.cjs (pyArgs, or pyLiteral inside a larger expression)',
    exts: ['.cjs'],
    // two signals: a template literal that looks like Python source, and a ${} in it that is a
    // path-like expression not routed through pyLiteral / JSON.stringify
    detect: ({ text }) => {
      const hits = [];
      const pathVars = new Set([...text.matchAll(PATH_DEF)].map((m) => m[1]));
      const isPathExpr = (expr) => PATHY_EXPR.test(expr) || pathVars.has(expr.trim());
      for (const { start, text: tpl } of templates(text)) {
        if (!tpl.includes('${') || !PY_HINT.test(tpl)) continue;
        for (const expr of expressionsOf(tpl)) {
          if (SAFE_EXPR.test(expr) || !isPathExpr(expr)) continue;
          // report the line of the template start (stable for counting)
          hits.push(text.slice(0, start).split('\n').length - 1);
        }
      }
      return hits;
    },
  },
];

/**
 * Whether a repo-relative path is excluded from scanning.
 * @param {string} rel forward-slash path relative to the repo root
 * @param {{exclude: string[]}} root
 * @returns {boolean}
 */
function isExcluded(rel, root) {
  if (SELF_EXCLUDE.includes(rel)) return true;
  if (rel.split('/').some((seg) => seg === 'node_modules' || seg === '__pycache__')) return true;
  return root.exclude.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

/**
 * List the files under every scan root.
 * @param {string} [repoRoot=REPO_ROOT]
 * @param {typeof SCAN_ROOTS} [roots=SCAN_ROOTS]
 * @returns {string[]} sorted forward-slash repo-relative paths
 */
function listFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const out = [];
  const walk = (rel, root) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (isExcluded(child, root)) continue;
      if (e.isDirectory()) walk(child, root);
      else if (e.isFile() && root.exts.includes(path.extname(e.name))) out.push(child);
    }
  };
  for (const root of roots) {
    if (root.files) {
      for (const f of root.files) {
        if (fs.existsSync(path.join(repoRoot, f))) out.push(f);
      }
      continue;
    }
    walk(root.dir, root);
  }
  return out.sort();
}

/**
 * Run every applicable rule over one file's text.
 * @param {string} text
 * @param {string} ext '.cjs' or '.py'
 * @returns {Record<string, number[]>} rule id -> 0-based hit line indexes (rules with no hit omitted)
 */
function scanText(text, ext, rel = '') {
  const ctx = { lines: text.split(/\r?\n/), text, ext, rel };
  const found = {};
  for (const rule of RULES) {
    if (!rule.exts.includes(ext)) continue;
    // `scope` (plan 88-15): 'test' rules only see tests/, 'product' rules only
    // see the product roots minus the two shared modules, 'both' sees all.
    const scope = rule.scope || 'both';
    if (rel) {
      if (scope === 'test' && !isTestFile(rel)) continue;
      if (scope === 'product' && !isProductFile(rel)) continue;
      if (scope === 'both' && !isTestFile(rel) && !isProductFile(rel)) continue;
    }
    const hits = rule.detect(ctx);
    if (hits.length > 0) found[rule.id] = hits;
  }
  return found;
}

/**
 * Scan every file and return the current hit counts.
 * @param {string} [repoRoot=REPO_ROOT]
 * @param {typeof SCAN_ROOTS} [roots=SCAN_ROOTS]
 * @returns {Map<string, {rule: string, file: string, count: number, lines: number[]}>} keyed "rule|file"
 */
function scanAll(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const result = new Map();
  for (const rel of listFiles(repoRoot, roots)) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const found = scanText(text, path.extname(rel), rel);
    for (const [rule, lines] of Object.entries(found)) {
      result.set(`${rule}|${rel}`, { rule, file: rel, count: lines.length, lines: lines.map((l) => l + 1) });
    }
  }
  return result;
}

/**
 * Compare current hits with the exceptions baseline. The baseline is a SCHEDULE, not a
 * permission: it may shrink (an owner plan removes its entries), never grow.
 *
 * @param {Map<string, {rule: string, file: string, count: number, lines: number[]}>} current from scanAll
 * @param {{rule: string, file: string, count: number}[]} exceptions entries of the JSON file
 * @returns {{code: string, rule: string, file: string, message: string}[]} violations (empty when clean)
 */
function compare(current, exceptions) {
  const byKey = new Map(exceptions.map((e) => [`${e.rule}|${e.file}`, e]));
  const violations = [];
  for (const [key, hit] of current) {
    const entry = byKey.get(key);
    if (!entry) {
      violations.push({
        code: CODES.NEW,
        rule: hit.rule,
        file: hit.file,
        message: `${CODES.NEW}: ${hit.rule} in ${hit.file} (${hit.count} hit${hit.count === 1 ? '' : 's'}, line${hit.lines.length === 1 ? '' : 's'} ${hit.lines.join(', ')}) is not in tests/posix-literal-exceptions.json. Use: ${RULES.find((r) => r.id === hit.rule).use}`,
      });
    } else if (hit.count > entry.count) {
      violations.push({
        code: CODES.COUNT_ROSE,
        rule: hit.rule,
        file: hit.file,
        message: `${CODES.COUNT_ROSE}: ${hit.rule} in ${hit.file} rose from ${entry.count} to ${hit.count} (lines ${hit.lines.join(', ')}). The baseline may shrink, never grow. Use: ${RULES.find((r) => r.id === hit.rule).use}`,
      });
    }
  }
  for (const entry of exceptions) {
    const hit = current.get(`${entry.rule}|${entry.file}`);
    if (!hit) {
      violations.push({
        code: CODES.EXCEPTION_STALE,
        rule: entry.rule,
        file: entry.file,
        message: `${CODES.EXCEPTION_STALE}: ${entry.rule} in ${entry.file} no longer matches anything: delete the exceptions entry`,
      });
    } else if (hit.count < entry.count) {
      violations.push({
        code: CODES.EXCEPTION_STALE,
        rule: entry.rule,
        file: entry.file,
        message: `${CODES.EXCEPTION_STALE}: ${entry.rule} in ${entry.file} fell from ${entry.count} to ${hit.count}: lower the entry's count`,
      });
    }
  }
  return violations;
}

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const EXCEPTIONS_FILE = 'tests/posix-literal-exceptions.json';

/**
 * Load the exceptions file.
 * @returns {{rule: string, file: string, count: number, reason: string, owner_plan: string}[]}
 */
function loadExceptions() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, EXCEPTIONS_FILE), 'utf8'));
}

const CURRENT = scanAll();
const EXCEPTIONS = loadExceptions();
const VIOLATIONS = compare(CURRENT, EXCEPTIONS);

/**
 * Assert that a rule has no violation of any of the three kinds.
 * @param {string} ruleId
 * @returns {void}
 */
function assertRuleClean(ruleId) {
  const mine = VIOLATIONS.filter((v) => v.rule === ruleId);
  assert.deepEqual(mine.map((v) => v.message), [], `${ruleId} violations:\n${mine.map((v) => v.message).join('\n')}`);
}

describe('88-14 no POSIX literals under tests/', () => {
  test('the scan really covers tests/ (a lint that scans nothing passes vacuously)', () => {
    const files = listFiles();
    assert.ok(files.length > 150, `expected a few hundred files under tests/, saw ${files.length}`);
    assert.ok(files.some((f) => f.endsWith('.cjs')) && files.some((f) => f.endsWith('.py')));
    assert.ok(!files.some((f) => f.startsWith('tests/fixtures/')), 'tests/fixtures is excluded on purpose');
    assert.ok(!files.some((f) => SELF_EXCLUDE.includes(f)), 'the lint does not scan itself');
  });

  test('POSIX_TMP: no literal /tmp (use fs.mkdtempSync(path.join(os.tmpdir(), ...)) or pytest tmp_path)', () => {
    assertRuleClean('POSIX_TMP');
  });

  test('POSIX_HOME_ONLY: HOME is never set without USERPROFILE (use tests/support/home-env.cjs)', () => {
    assertRuleClean('POSIX_HOME_ONLY');
  });

  test('POSIX_PATH_COLON: PATH is never joined with a literal ":" (use path.delimiter / prependPath)', () => {
    assertRuleClean('POSIX_PATH_COLON');
  });

  test('POSIX_PS: no execFileSync(\'ps\' / lsof (use the live-store-canary helpers)', () => {
    assertRuleClean('POSIX_PS');
  });

  test('POSIX_WHICH: no `which` spawn (use the platform helper)', () => {
    assertRuleClean('POSIX_WHICH');
  });

  test('POSIX_PY3_LITERAL: no spawn of a literal python3 (use pythonBin() / GSD_PYTHON)', () => {
    assertRuleClean('POSIX_PY3_LITERAL');
  });

  test('POSIX_SHEBANG_FAKE: no hand-rolled #! fake with a chmod (use tests/support/fake-exe.cjs)', () => {
    assertRuleClean('POSIX_SHEBANG_FAKE');
  });

  test('POSIX_PY_INTERP: no path interpolated into Python source (use tests/support/py-embed.cjs)', () => {
    assertRuleClean('POSIX_PY_INTERP');
  });

  // -- Plan 88-15: the six PRODUCT rules, one subtest each --------------------

  test('POSIX_OS_KILL_PROBE: no os.kill in the product (use _platform.pid_alive / terminate)', () => {
    assertRuleClean('POSIX_OS_KILL_PROBE');
  });

  test('POSIX_SIGKILL: no signal.SIGKILL in the product (use _platform.terminate(force=True))', () => {
    assertRuleClean('POSIX_SIGKILL');
  });

  test('POSIX_FORK: no os.fork/os.setsid/start_new_session (use _platform.daemonize)', () => {
    assertRuleClean('POSIX_FORK');
  });

  test('POSIX_FCNTL: no direct fcntl in the product (use _platform.file_lock)', () => {
    assertRuleClean('POSIX_FCNTL');
  });

  test('POSIX_ENV_HOME: no process.env.HOME / environ HOME (use homeDir() / home_dir())', () => {
    assertRuleClean('POSIX_ENV_HOME');
  });

  test('POSIX_DEVNULL: no 2>/dev/null in a spawn string (use the stdio option)', () => {
    assertRuleClean('POSIX_DEVNULL');
  });

  test('every rule in the table has its own subtest above', () => {
    assert.deepEqual(RULES.map((r) => r.id).sort(), [
      'POSIX_DEVNULL', 'POSIX_ENV_HOME', 'POSIX_FCNTL', 'POSIX_FORK',
      'POSIX_HOME_ONLY', 'POSIX_OS_KILL_PROBE', 'POSIX_PATH_COLON', 'POSIX_PS',
      'POSIX_PY3_LITERAL', 'POSIX_PY_INTERP', 'POSIX_SHEBANG_FAKE',
      'POSIX_SIGKILL', 'POSIX_TMP', 'POSIX_WHICH',
    ]);
  });

  test('the scan really covers the PRODUCT roots too (plan 88-15)', () => {
    const files = listFiles();
    for (const root of ['get-shit-done/bin/', 'bin/', 'scripts/', 'hooks/', 'services/']) {
      assert.ok(files.some((f) => f.startsWith(root)), `${root} is not scanned`);
    }
    assert.ok(files.includes('amauta.py'), 'amauta.py is not scanned');
    // The two shared modules ARE scanned but are outside every product rule.
    for (const shared of SHARED_PLATFORM_MODULES) {
      assert.equal(isProductFile(shared), false, `${shared} must be exempt by RULE, not by entry`);
    }
  });
});

describe('88-14 posix-literal-exceptions.json is a counted baseline (a schedule, not a permission)', () => {
  test('every entry has rule, file, count, reason and owner_plan; there is no cap', () => {
    assert.ok(Array.isArray(EXCEPTIONS) && EXCEPTIONS.length > 0);
    const seen = new Set();
    for (const e of EXCEPTIONS) {
      assert.ok(RULES.some((r) => r.id === e.rule), `unknown rule ${e.rule}`);
      assert.equal(typeof e.file, 'string');
      assert.ok(fs.existsSync(path.join(REPO_ROOT, e.file)), `${e.file} does not exist: delete the entry`);
      assert.ok(Number.isInteger(e.count) && e.count > 0, `${e.rule} ${e.file}: count must be a positive integer`);
      assert.ok(typeof e.reason === 'string' && e.reason.length > 10, `${e.rule} ${e.file}: reason`);
      assert.ok(OWNER_PLANS.includes(e.owner_plan), `${e.rule} ${e.file}: owner_plan ${e.owner_plan}`);
      const key = `${e.rule}|${e.file}`;
      assert.ok(!seen.has(key), `duplicate entry ${key}`);
      seen.add(key);
    }
  });

  test('an entry owned by "none" says why it is permanent', () => {
    for (const e of EXCEPTIONS.filter((x) => x.owner_plan === 'none')) {
      assert.ok(e.reason.length > 30, `${e.rule} ${e.file}: a permanent exception needs a reason of substance`);
    }
  });

  test('entries are sorted by rule then file, so a diff shows exactly what changed', () => {
    const keys = EXCEPTIONS.map((e) => `${e.rule}|${e.file}`);
    assert.deepEqual(keys, [...keys].sort());
  });
});

describe('88-14 the three failure modes can fire (synthetic, no scratch files)', () => {
  const hit = (rule, file, count) => [`${rule}|${file}`, { rule, file, count, lines: Array.from({ length: count }, (_, i) => i + 1) }];
  const entry = (rule, file, count) => ({ rule, file, count, reason: 'x', owner_plan: 'none' });

  test('POSIX_LITERAL_NEW: a hit with no entry', () => {
    const v = compare(new Map([hit('POSIX_TMP', 'tests/a.cjs', 1)]), []);
    assert.deepEqual(v.map((x) => x.code), [CODES.NEW]);
  });

  test('POSIX_LITERAL_COUNT_ROSE: one more hit than the entry allows', () => {
    const v = compare(new Map([hit('POSIX_TMP', 'tests/a.cjs', 3)]), [entry('POSIX_TMP', 'tests/a.cjs', 2)]);
    assert.deepEqual(v.map((x) => x.code), [CODES.COUNT_ROSE]);
  });

  test('POSIX_LITERAL_EXCEPTION_STALE: an entry nothing matches, and an entry whose count fell', () => {
    const none = compare(new Map(), [entry('POSIX_TMP', 'tests/a.cjs', 2)]);
    assert.deepEqual(none.map((x) => x.code), [CODES.EXCEPTION_STALE]);
    const fell = compare(new Map([hit('POSIX_TMP', 'tests/a.cjs', 1)]), [entry('POSIX_TMP', 'tests/a.cjs', 2)]);
    assert.deepEqual(fell.map((x) => x.code), [CODES.EXCEPTION_STALE]);
  });

  test('an exact match is clean', () => {
    assert.deepEqual(compare(new Map([hit('POSIX_TMP', 'tests/a.cjs', 2)]), [entry('POSIX_TMP', 'tests/a.cjs', 2)]), []);
  });
});

describe('88-14 every rule fires on a violation and stays quiet on the portable form (synthetic)', () => {
  /** @returns {string[]} rule ids that fire on `text` */
  const fires = (text, ext = '.cjs') => Object.keys(scanText(text, ext));

  const VIOLATIONS_BY_RULE = {
    POSIX_TMP: ["const f = `/tmp/x-${Date.now()}.py`;", "tmp = '/tmp/out.txt'"],
    POSIX_HOME_ONLY: ["const env = { ...process.env, HOME: dir };", "process.env.HOME = dir;"],
    POSIX_PATH_COLON: ["const env = { PATH: `${bin}:${process.env.PATH}` };", "const env = { PATH: bin + ':' + process.env.PATH };"],
    POSIX_PS: ["execFileSync('ps', ['-o', 'command=', '-p', '1']);", "execSync('lsof -i :80');", "const a = 'lsof';"],
    POSIX_WHICH: ["spawnSync('which', ['git']);", "execSync('which git');"],
    POSIX_PY3_LITERAL: ["execFileSync('python3', ['-c', code]);", "spawnSync('python3', args);"],
    POSIX_SHEBANG_FAKE: ["fs.writeFileSync(p, '#!/bin/sh\\nexit 0\\n');\nfs.chmodSync(p, 0o755);"],
    POSIX_PY_INTERP: [
      "const ROOT = path.resolve(__dirname, '..');\nrun(`\nimport sys\nsys.path.insert(0, '${ROOT}')\nprint(1)\n`);",
      "run(`import os; os.path.join('${path.join(a, b)}', 'x')`);",
    ],
    // Plan 88-15, the product rules. Each one is PROVEN ABLE TO FAIL here, in
    // the suite itself, rather than only by a one-off scratch-file mutation.
    POSIX_OS_KILL_PROBE: ["os.kill(pid, 0)", "os.kill(pid, signal.SIGTERM)"],
    POSIX_SIGKILL: ["os.kill(pid, signal.SIGKILL)", "    sig = signal.SIGKILL"],
    POSIX_FORK: ["if os.fork() == 0:", "    os.setsid()", "    start_new_session=True,"],
    POSIX_FCNTL: ["import fcntl", "fcntl.flock(fd, fcntl.LOCK_EX)"],
    POSIX_ENV_HOME: ["const h = process.env.HOME || '';", "path.join(process.env.HOME, '.claude')"],
    POSIX_DEVNULL: ["execSync(`ruff check \"${f}\" 2>/dev/null`);", "spawnSync('sh', ['-c', 'x 2>/dev/null'])"],
  };

  /** The language each rule's samples are written in (default: JavaScript). */
  const SAMPLE_EXT = {
    POSIX_OS_KILL_PROBE: '.py',
    POSIX_SIGKILL: '.py',
    POSIX_FORK: '.py',
    POSIX_FCNTL: '.py',
  };

  for (const rule of RULES) {
    test(`${rule.id} fires on its violations`, () => {
      const ext = SAMPLE_EXT[rule.id] || '.cjs';
      for (const sample of VIOLATIONS_BY_RULE[rule.id]) {
        assert.ok(fires(sample, ext).includes(rule.id), `${rule.id} should fire on: ${sample}`);
      }
    });
  }

  test('the product rules are quiet on the portable form', () => {
    const quietPy = [
      "if _platform.pid_alive(pid, strict=True):",
      "_platform.terminate(pid, force=True)",
      "role = _platform.daemonize()",
      "**_platform.detached_popen_kwargs(),",
      "with _platform.file_lock(path):",
      'home = home_dir()',
    ];
    for (const sample of quietPy) assert.deepEqual(fires(sample, '.py'), [], sample);
    const quietJs = [
      "const h = platform.homeDir();",
      "execSync(`ruff check \"${f}\"`, { stdio: ['ignore', 'pipe', 'ignore'] });",
    ];
    for (const sample of quietJs) assert.deepEqual(fires(sample), [], sample);
  });

  test('a user-facing message naming a POSIX tool is NOT a violation', () => {
    // The three measured exclusions, asserted as behaviour.
    assert.deepEqual(fires('print(f"PID {pid} did not exit on SIGTERM - sending SIGKILL")', '.py'), []);
    assert.deepEqual(fires("console.log('Start daemon: python3 services/amauta-daemon.py start');"), []);
    assert.deepEqual(fires('subprocess.run(["docker", "ps", "-a"], capture_output=True)', '.py'), []);
  });

  test('the portable forms are quiet', () => {
    const quiet = [
      "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));",
      "const env = { ...process.env, ...homeEnv(dir) };",
      "const env = { PATH: prependPath([bin]) };",
      "const env = { PATH: bin + path.delimiter + process.env.PATH };",
      "const home = { HOME: dir, USERPROFILE: dir };",
      "const HOME = path.join(os.tmpdir(), 'h');",
      "writeFakeExe(dir, 'python3', { node: 'process.exit(0)' });",
      "// a comment about /tmp/x and ps and lsof and HOME: dir",
      "run(`import sys\nsys.path.insert(0, ${pyLiteral(ROOT)})`);",
      "const ROOT = path.resolve(__dirname);\nrun(pyArgs('import sys; print(sys.argv[1])', [ROOT]));",
      "run(`import sys\nprint(${code})`);",
    ];
    for (const sample of quiet) {
      assert.deepEqual(fires(sample), [], `should be quiet on: ${sample}`);
    }
  });

  test('Python files: /tmp, HOME without USERPROFILE and a #! fake are found', () => {
    assert.ok(fires("p = '/tmp/x'\n", '.py').includes('POSIX_TMP'));
    assert.ok(fires("monkeypatch.setenv('HOME', str(tmp_path))\n", '.py').includes('POSIX_HOME_ONLY'));
    assert.ok(fires("p.write_text('#!/bin/sh\\nexit 0')\np.chmod(0o755)\n", '.py').includes('POSIX_SHEBANG_FAKE'));
    assert.deepEqual(fires("# p = '/tmp/x'\n", '.py'), []);
  });
});
