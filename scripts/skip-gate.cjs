#!/usr/bin/env node
/**
 * The skip gate (plan 88-19, FND-04): a test that skips without an entry in
 * `tests/skip-exceptions.d/` fails the run, and an entry that excuses nothing
 * fails the run too, so the ledger cannot rot.
 *
 * ── WHERE THE ENTRIES LIVE (plan 89-09 task 02) ─────────────────────────────────
 * The ledger was ONE flat array in `tests/skip-exceptions.json`. A JSON array is
 * textually merge-hostile: a bad merge silently loses an entry and the gate then
 * reports a *skip*, not a *loss*. Phase 89 had eight plans that each needed to add
 * or remove entries, so the ledger is now SHARDED — one file per owning plan under
 * `tests/skip-exceptions.d/`, and every reader loads the UNION of
 * `tests/skip-exceptions.d/<*>.json` plus `tests/skip-exceptions.json` when that
 * legacy file still exists.
 *
 * The legacy single file is kept as an accepted input for exactly one reason:
 * `tests/fixtures/planning-drift/skip-ledger-{agrees,disagrees}/tests/skip-exceptions.json`
 * carry one, and rewriting those fixture trees would mix a fixture change into a
 * loader change. An ABSENT directory and an ABSENT file together still produce no
 * finding here (`loadUnion` returns no entries and no problems), because
 * `get-shit-done/bin/lib/planning-drift.cjs` runs over repository-shaped fixture
 * trees that have neither and its "absent: no finding, by design" rule must survive
 * verbatim. The RUNNER's fail-closed behaviour is unchanged: `runNodeGate` turns an
 * empty union into `SKIP_EXCEPTIONS_UNREADABLE` (see `loadUnionForGate`).
 *
 * ── THE RULES, WRITTEN ONCE ─────────────────────────────────────────────────────
 * `tests/support/skip_gate.py` is the Python half of this gate. The two MUST agree,
 * and `tests/88-19-skip-gate.test.cjs` proves it rather than asserting it: it feeds
 * the SAME fixture exceptions file and the SAME synthetic observation list to both
 * through their `--evaluate` interfaces and compares the verdicts. Any change to a
 * rule below must be made in both files; the parity test is what fails otherwise.
 *
 * 1. THE MATCH KEY IS `(file, name, platform)` AND NOTHING ELSE.
 *    The exceptions file is FLAT: one entry per test per platform, all keys unique.
 *    `reason_class` is a grouping LABEL used in reports and in the ROADMAP ledger
 *    join; the gate never matches, counts or deduplicates on it.
 *
 * 2. AN ENTRY IS APPLICABLE when all three hold:
 *      runner   — the Node gate owns `*.cjs` entries; the Python gate owns `*.py`
 *                 entries and the `(collection)` pseudo-file (a pytest module-level
 *                 collection skip has no file path). Neither runner can see the
 *                 other's tests, so neither may judge the other's entries.
 *      platform — `entry.platform` is `all` or the current `process.platform`.
 *      context  — `entry.context` is `any`; or it is `local` AND `CI` is unset.
 *
 * 3. `context: "local"` IS REFUSED UNDER CI, with its own code and message. This is
 *    the one rule that, if wrong, re-opens the hole the whole no-skips effort closed:
 *    a local-only excuse must never quieten a CI cell.
 *
 * 4. STALENESS IS A FULL-RUN PROPERTY, scoped three ways:
 *      a. full runs only — `scripts/run-tests.cjs` computes an `explicit` flag when
 *         file arguments were given; pytest's equivalent is "no file, node-id, `-k`
 *         or `-m` selection". A partial run checks SKIP_UNLISTED but NOT staleness,
 *         because a run of one file leaves 466 entries unmatched by construction and
 *         would exit 6 on every single-file acceptance command in this phase.
 *      b. applicable entries only — rule 2, so neither gate reports the other's.
 *      c. the key of rule 1.
 *      d. `context: "any"` entries only. A `local` entry exists because a tool is
 *         absent from a developer machine and present in CI; it matching nothing
 *         means this machine HAS the tool — good news, not rot. See the comment at
 *         the stale loop.
 *    Removing an entry whose test now runs is therefore the NORMAL, GREEN path: the
 *    test stops skipping, the entry stops matching, the stale check names it, you
 *    delete it, the run is green. That is how plan 88-17 proves it closed ORC-05.
 *
 * 5. FAIL CLOSED. An unreadable, non-array, duplicate-keyed or schema-violating
 *    exceptions file is a RED run with a message naming the defect — never a pass.
 *    A missing reporter output file is red too: no evidence is not "no skips".
 *
 * 6. A SKIPPED SUITE CANNOT BE EXCUSED. Measured in 88-19-01: when a `describe` is
 *    skipped, Node emits one event for the suite and NONE for its children, and its
 *    own counter does not count it as a skip. An entry for it would hide every test
 *    inside it from the gate and would not match any count, so a skipped suite is
 *    always a finding: skip the individual tests instead, each with its own entry.
 *
 * 7. A TODO IS NOT A SKIP AND HAS NO ENTRY. `{todo: …}` is a test that does not run
 *    and that the skip counter never sees, so it is a bypass of this gate by
 *    construction. There are none in the suite (measured, 88-19-02); one added later
 *    is a finding with its own code.
 *
 * Exit status 6. 4 belongs to the live-store canary and 5 to the stray-process check
 * in `scripts/run-tests.cjs`; both keep their meaning.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** The runner's exit status when the gate finds anything. 4 and 5 are taken. */
const EXIT_SKIP_GATE = 6;

/** Finding codes. Each is a distinct failure mode with its own message. */
const CODES = {
  /** a skip with no applicable entry */
  UNLISTED: 'SKIP_UNLISTED',
  /** a skip whose only entry is `context: "local"` while `CI` is set */
  LOCAL_UNDER_CI: 'SKIP_LOCAL_ENTRY_UNDER_CI',
  /** a skipped `describe`: it hides its children from the gate (rule 6) */
  SUITE: 'SKIP_SUITE_HIDES_TESTS',
  /** a `{todo: …}` test: a non-running test the skip counter never sees (rule 7) */
  TODO: 'SKIP_TODO_NOT_ALLOWED',
  /** an applicable entry that matched no skip on a full run */
  STALE: 'SKIP_EXCEPTION_STALE',
  /** the exceptions file could not be read or parsed (rule 5) */
  UNREADABLE: 'SKIP_EXCEPTIONS_UNREADABLE',
  /** the exceptions file parsed but violates the schema (rule 5) */
  MALFORMED: 'SKIP_EXCEPTIONS_MALFORMED',
  /**
   * the same `(file, name, platform)` key appears in TWO shards (plan 89-09).
   * Its own code because it is the silent-loss failure sharding exists to
   * prevent: two owners editing the same entry in two files, where a flat array
   * would have forced a textual conflict. A duplicate INSIDE one file keeps
   * reporting as MALFORMED, unchanged.
   */
  DUPLICATE_ACROSS_SHARDS: 'SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS',
  /** the reporter wrote no observation file: no evidence is not "no skips" (rule 5) */
  NO_EVIDENCE: 'SKIP_GATE_NO_EVIDENCE',
};

/** Every field an entry must carry, with the check its value must pass. */
const SCHEMA = {
  name: (v) => typeof v === 'string' && v.length > 0,
  file: (v) => typeof v === 'string' && v.length > 0,
  platform: (v) => ['all', 'darwin', 'linux', 'win32'].includes(v),
  context: (v) => ['any', 'local'].includes(v),
  reason: (v) => typeof v === 'string' && v.trim().length > 0,
  reason_class: (v) => typeof v === 'string' && v.trim().length > 0,
  owner: (v) => typeof v === 'string' && v.trim().length > 0,
  owner_phase: (v) => Number.isInteger(v),
  exit_criterion: (v) => typeof v === 'string' && v.trim().length > 0,
};

/**
 * Repo-relative name of the ledger, as it is named in every message. It is the
 * DIRECTORY since plan 89-09; `EXCEPTIONS_LEGACY_REL` is still an accepted input.
 */
const EXCEPTIONS_REL = 'tests/skip-exceptions.d/';

/** Repo-relative path of the shard directory. */
const EXCEPTIONS_DIR_REL = 'tests/skip-exceptions.d';

/** The pre-89-09 single file. Still read when present (see the header). */
const EXCEPTIONS_LEGACY_REL = 'tests/skip-exceptions.json';

/**
 * Which runner owns an entry, from its `file` field (rule 2).
 *
 * @param {string} file the entry's `file` value
 * @returns {'node'|'python'|'unowned'}
 * @example
 *   runnerOf('tests/a.test.cjs')  // 'node'
 *   runnerOf('(collection)')      // 'python'
 */
function runnerOf(file) {
  const f = String(file || '');
  if (/\.(?:cjs|mjs|js)$/.test(f)) return 'node';
  if (/\.py$/.test(f) || f === '(collection)') return 'python';
  return 'unowned';
}

/**
 * Normalise an absolute test file path to the repo-relative, forward-slash form the
 * exceptions file uses.
 *
 * @param {string} file absolute or relative path as the reporter saw it
 * @param {string} repoRoot the repository root
 * @returns {string} e.g. `tests/88-19-skip-gate.test.cjs`
 */
function relativeTestFile(file, repoRoot) {
  const raw = String(file || '');
  if (!raw) return '';
  const abs = path.resolve(repoRoot, raw);
  const rel = path.relative(repoRoot, abs);
  if (rel && !rel.startsWith('..')) return rel.split(path.sep).join('/');
  return raw.split(path.sep).join('/');
}

/**
 * Read ONE JSON array of entries off disk, without validating the entries.
 *
 * @param {string} file absolute path
 * @param {string} label how the file is named in a message
 * @returns {{doc: object[]|null, problems: {code: string, detail: string}[]}}
 */
function readEntryFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return {
      doc: null,
      problems: [{
        code: CODES.UNREADABLE,
        detail: `${label} could not be read (${err.message}). The gate fails closed: a run without the exceptions file is red, never green.`,
      }],
    };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { doc: null, problems: [{ code: CODES.UNREADABLE, detail: `${label} is not valid JSON: ${err.message}` }] };
  }
  if (!Array.isArray(doc)) {
    return {
      doc: null,
      problems: [{ code: CODES.MALFORMED, detail: `${label} must be a FLAT JSON array of entries, one per test per platform; got ${typeof doc}` }],
    };
  }
  return { doc, problems: [] };
}

/**
 * Validate entries read from one or more sources, as ONE flat ledger.
 *
 * @param {{label: string, doc: object[]}[]} sources in load order
 * @returns {{entries: object[], problems: {code: string, detail: string}[]}}
 *   `problems` is non-empty when the ledger is unusable; `entries` is then empty.
 * @example
 *   validateEntries([{label: 'tests/skip-exceptions.d/89-01.json', doc: [...]}])
 */
function validateEntries(sources) {
  const problems = [];
  const seen = new Map();
  const all = [];
  const multi = sources.length > 1;
  for (const source of sources) {
    source.doc.forEach((entry, i) => {
    const where = `entry #${i + 1}${multi ? ` of ${source.label}` : ''} (${entry && entry.file ? entry.file : 'no file'} :: ${entry && entry.name ? entry.name : 'no name'})`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push({ code: CODES.MALFORMED, detail: `${where} is not an object` });
      return;
    }
    const bad = Object.keys(SCHEMA).filter((k) => !SCHEMA[k](entry[k]));
    if (bad.length) {
      problems.push({ code: CODES.MALFORMED, detail: `${where} has invalid or missing field(s): ${bad.join(', ')}` });
      return;
    }
    if (runnerOf(entry.file) === 'unowned') {
      problems.push({
        code: CODES.MALFORMED,
        detail: `${where} names a file no runner owns; the Node gate owns *.cjs and the Python gate owns *.py and "(collection)"`,
      });
      return;
    }
    const k = `${entry.file}|${entry.name}|${entry.platform}`;
    const prior = seen.get(k);
    if (prior && prior.label !== source.label) {
      problems.push({
        code: CODES.DUPLICATE_ACROSS_SHARDS,
        detail: `${where} duplicates the key (file, name, platform) of entry #${prior.index + 1} of ${prior.label}. One shard per owner: the same key in two shards means two plans own one entry, and the one that deletes it leaves the skip still excused by the other — the silent loss sharding exists to prevent.`,
      });
      return;
    }
    if (prior) {
      problems.push({ code: CODES.MALFORMED, detail: `${where} duplicates the key (file, name, platform) of entry #${prior.index + 1}; the file is flat and every key is unique` });
      return;
    }
    seen.set(k, { index: i, label: source.label });
    all.push(entry);
    });
  }
  return { entries: problems.length ? [] : all, problems };
}

/**
 * Read and validate ONE exceptions file. Fails closed (rule 5).
 *
 * The signature is unchanged by plan 89-09 on purpose: `--evaluate`'s
 * `exceptionsFile` input names a single file, and the two `planning-drift`
 * fixture trees carry a single file each.
 *
 * @param {string} file absolute path of the exceptions file
 * @returns {{entries: object[], problems: {code: string, detail: string}[]}}
 * @example
 *   const { entries, problems } = loadExceptions('/repo/tests/skip-exceptions.json');
 */
function loadExceptions(file) {
  const read = readEntryFile(file, EXCEPTIONS_REL);
  if (read.doc === null) return { entries: [], problems: read.problems };
  return validateEntries([{ label: EXCEPTIONS_REL, doc: read.doc }]);
}

/**
 * Every file the ledger is read from, in load order: the `*.json` shards of
 * `tests/skip-exceptions.d/` sorted by name, then the legacy single file when it
 * still exists.
 *
 * @param {string} repoRoot repository root, or a repository-shaped fixture tree
 * @returns {{label: string, path: string}[]} possibly empty
 * @example
 *   exceptionSources('/repo')[0].label  // 'tests/skip-exceptions.d/89-01.json'
 */
function exceptionSources(repoRoot) {
  const sources = [];
  const dir = path.join(repoRoot, 'tests', 'skip-exceptions.d');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    names = []; // an absent directory is not a finding here; see the header
  }
  for (const name of names) {
    sources.push({ label: `${EXCEPTIONS_DIR_REL}/${name}`, path: path.join(dir, name) });
  }
  const legacy = path.join(repoRoot, 'tests', 'skip-exceptions.json');
  if (fs.existsSync(legacy)) sources.push({ label: EXCEPTIONS_LEGACY_REL, path: legacy });
  return sources;
}

/**
 * Read and validate the UNION of every ledger source under `repoRoot`.
 *
 * An absent directory AND an absent legacy file produce no entries and NO
 * problem: `get-shit-done/bin/lib/planning-drift.cjs` runs this over fixture
 * trees that have neither, and its "absent: no finding, by design" rule must
 * survive verbatim. The RUNNER's fail-closed path is `loadUnionForGate`.
 *
 * @param {string} repoRoot repository root
 * @returns {{entries: object[], problems: object[], sources: string[]}}
 * @example
 *   const { entries, sources } = loadUnion('/repo');  // 467 entries, 4 sources
 */
function loadUnion(repoRoot) {
  const sources = exceptionSources(repoRoot);
  const problems = [];
  const docs = [];
  for (const source of sources) {
    const read = readEntryFile(source.path, source.label);
    if (read.doc === null) { problems.push(...read.problems); continue; }
    docs.push({ label: source.label, doc: read.doc });
  }
  const labels = sources.map((s) => s.label);
  if (problems.length) return { entries: [], problems, sources: labels };
  return { ...validateEntries(docs), sources: labels };
}

/**
 * `loadUnion` for the RUNNER: no source at all is a FINDING here, because a
 * checkout with no ledger must never read as "no skips" (rule 5).
 *
 * @param {string} repoRoot repository root
 * @returns {{entries: object[], problems: object[], sources: string[]}}
 */
function loadUnionForGate(repoRoot) {
  const result = loadUnion(repoRoot);
  if (!result.sources.length) {
    return {
      entries: [],
      sources: [],
      problems: [{
        code: CODES.UNREADABLE,
        detail: `${EXCEPTIONS_REL} holds no shard and ${EXCEPTIONS_LEGACY_REL} does not exist, so nothing could excuse a skip. The gate fails closed: a run without the ledger is red, never green.`,
      }],
    };
  }
  return result;
}

/**
 * Whether an entry applies to this runner, platform and context (rule 2).
 *
 * @param {object} entry one exceptions entry
 * @param {{runner: string, platform: string, ci: boolean}} ctx the run's identity
 * @returns {boolean}
 */
function isApplicable(entry, ctx) {
  if (runnerOf(entry.file) !== ctx.runner) return false;
  if (entry.platform !== 'all' && entry.platform !== ctx.platform) return false;
  if (entry.context === 'local' && ctx.ci) return false;
  return true;
}

/**
 * Apply the gate to one run.
 *
 * @param {object} input
 * @param {object[]} input.entries validated exceptions entries
 * @param {{kind: string, file: string, name: string, reason: string}[]} input.observed
 *   what the runner saw: `kind` is `skip`, `suite-skip`, `todo`, `suite-todo` or
 *   `xfail` (pytest), `file` repo-relative with forward slashes.
 * @param {'node'|'python'} input.runner which half of the gate this is
 * @param {string} input.platform `process.platform` / `sys.platform` mapped to it
 * @param {boolean} input.ci whether `CI` is set and non-empty
 * @param {boolean} input.explicit whether this was a PARTIAL run (file selection given)
 * @returns {{exit_code: number, findings: {code: string, file: string, name: string, platform: string, detail: string}[], counts: object}}
 * @example
 *   evaluate({entries, observed, runner: 'node', platform: 'darwin', ci: false, explicit: false})
 */
function evaluate(input) {
  const entries = input.entries || [];
  const observed = input.observed || [];
  const ctx = { runner: input.runner, platform: input.platform, ci: Boolean(input.ci) };
  const explicit = Boolean(input.explicit);
  const findings = [];

  const applicable = entries.filter((e) => isApplicable(e, ctx));
  const byKey = new Map(applicable.map((e) => [`${e.file}|${e.name}`, e]));
  const matched = new Set();

  for (const ob of observed) {
    const file = String(ob.file || '');
    const name = String(ob.name || '');
    const kind = String(ob.kind || 'skip');
    const reason = String(ob.reason || '');

    if (kind === 'suite-skip' || kind === 'suite-todo') {
      findings.push({
        code: CODES.SUITE,
        file,
        name,
        platform: ctx.platform,
        detail: `a skipped suite hides every test inside it from this gate and is not counted as a skip by the runner, so it cannot be excused by an entry. Skip the individual tests instead, each with its own entry in ${EXCEPTIONS_REL}. (reason: ${reason || 'none given'})`,
      });
      continue;
    }
    if (kind === 'todo') {
      findings.push({
        code: CODES.TODO,
        file,
        name,
        platform: ctx.platform,
        detail: `a {todo} test does not run and the skip counter never sees it, so it bypasses this gate. Make it run, or skip it with an entry in ${EXCEPTIONS_REL}. (note: ${reason || 'none given'})`,
      });
      continue;
    }

    const key = `${file}|${name}`;
    if (byKey.has(key)) {
      matched.add(key);
      continue;
    }

    // No applicable entry. Say WHY precisely: a local entry under CI is its own
    // failure, and an entry for another platform is a different mistake again.
    const sameTest = entries.filter((e) => e.file === file && e.name === name);
    const localBlocked = sameTest.filter((e) => e.context === 'local' && ctx.ci
      && (e.platform === 'all' || e.platform === ctx.platform)
      && runnerOf(e.file) === ctx.runner);
    if (localBlocked.length) {
      findings.push({
        code: CODES.LOCAL_UNDER_CI,
        file,
        name,
        platform: ctx.platform,
        detail: `the only entry for this test is context: "local", and CI is set. A local-only entry excuses a skip ONLY when CI is unset; a CI cell may never be quietened by one. Make the test run on CI, or give it a context: "any" entry with its own reason. (reason: ${reason || 'none given'})`,
      });
      continue;
    }
    const otherPlatforms = [...new Set(sameTest.map((e) => e.platform))].sort();
    findings.push({
      code: CODES.UNLISTED,
      file,
      name,
      platform: ctx.platform,
      detail: otherPlatforms.length
        ? `no entry in ${EXCEPTIONS_REL} for platform ${ctx.platform}; this test has entries for ${otherPlatforms.join(', ')} only. (reason: ${reason || 'none given'})`
        : `no entry in ${EXCEPTIONS_REL} for (file, name, platform=${ctx.platform}). A skip needs a true reason, an owner_phase and an exit_criterion. (reason: ${reason || 'none given'})`,
    });
  }

  // Rule 4: staleness is a FULL-RUN property, over APPLICABLE entries only — and
  // rule 4d: NOT over `context: "local"` entries. A local entry exists because a tool
  // is absent from a developer machine and present in CI; it matching nothing means
  // THIS machine has the tool, which is good news, not rot, and a gate that turns red
  // on the better-equipped machine teaches the wrong lesson. Staleness is the
  // discipline for `context: "any"` entries — the ones every CI cell shares, and the
  // ones a later plan (88-17) deletes to prove it closed its obligation. A `local`
  // entry that really has rotted is caught by planning-drift's
  // DRIFT_SKIP_OWNER_PHASE_COMPLETE when its owning phase closes.
  if (!explicit) {
    for (const e of applicable.filter((x) => x.context !== 'local')) {
      const key = `${e.file}|${e.name}`;
      if (matched.has(key)) continue;
      findings.push({
        code: CODES.STALE,
        file: e.file,
        name: e.name,
        platform: e.platform,
        detail: `this entry excused nothing on a full ${ctx.runner} run on ${ctx.platform}: the test no longer skips. Delete the entry — that is the normal, green path when the work its exit_criterion names is done. (owner_phase ${e.owner_phase}, reason_class ${e.reason_class})`,
      });
    }
  }

  // Code-point order, NOT localeCompare: the Python half sorts the same tuples with
  // Python's own string comparison, and the parity test compares the two lists
  // position by position. A locale-aware collation would make them disagree on
  // punctuation (`[`, `-`, `_`) for no benefit.
  const sortKey = (f) => [f.code, f.file, f.name, f.platform];
  findings.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return {
    exit_code: findings.length ? EXIT_SKIP_GATE : 0,
    findings,
    counts: {
      observed_skips: observed.filter((o) => o.kind === 'skip' || o.kind === 'xfail').length,
      applicable_entries: applicable.length,
      matched_entries: matched.size,
      stale_checked: !explicit,
    },
  };
}

/**
 * Render a gate result for a terminal, in the style of the live-store canary.
 *
 * @param {ReturnType<typeof evaluate>} result
 * @param {{runner: string, platform: string, ci: boolean, explicit: boolean}} ctx
 * @returns {string}
 */
function format(result, ctx) {
  const head = `--- skip gate (${ctx.runner}, ${ctx.platform}, CI=${ctx.ci ? 'set' : 'unset'}, ${ctx.explicit ? 'PARTIAL run: staleness not checked' : 'full run'}) ---`;
  if (!result.findings.length) {
    return `${head}\nskip gate: ${result.counts.observed_skips} skip(s), all listed; ${result.counts.matched_entries}/${result.counts.applicable_entries} applicable entries matched`;
  }
  const lines = result.findings.map((f) => `${f.code} ${f.file} :: ${f.name}\n    ${f.detail}`);
  return [
    head,
    ...lines,
    `--- skip gate: ${result.findings.length} finding(s); exit ${EXIT_SKIP_GATE} ---`,
  ].join('\n');
}

/**
 * Read the reporter's JSONL output into the `observed` shape (rule 5: a missing file
 * is a finding, not a pass).
 *
 * @param {string} file the reporter's destination path
 * @param {string} repoRoot the repository root, for relativising paths
 * @returns {{observed: object[], problems: {code: string, detail: string}[]}}
 */
function readObservations(file, repoRoot) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return {
      observed: [],
      problems: [{
        code: CODES.NO_EVIDENCE,
        detail: `the skip reporter wrote no output (${err.message}). No evidence is not "no skips": the gate fails closed.`,
      }],
    };
  }
  const observed = [];
  const problems = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      observed.push({
        kind: row.kind,
        file: relativeTestFile(row.file, repoRoot),
        name: row.name,
        reason: row.reason,
      });
    } catch (err) {
      problems.push({ code: CODES.NO_EVIDENCE, detail: `the skip reporter wrote a line the gate cannot parse: ${t.slice(0, 120)} (${err.message})` });
    }
  }
  return { observed, problems };
}

/**
 * The whole Node-side gate: read the reporter output, read the exceptions file,
 * evaluate, print. Called from `scripts/run-tests.cjs`'s `finally` block.
 *
 * @param {object} opts
 * @param {string} opts.reportFile the reporter's JSONL destination
 * @param {string} opts.repoRoot repository root
 * @param {boolean} opts.explicit whether this was a partial run
 * @param {NodeJS.ProcessEnv} [opts.env=process.env] environment to read `CI` from
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.exceptionsFile] override naming ONE file, for tests
 * @returns {{exit_code: number, findings: object[], counts: object, text: string}}
 */
function runNodeGate(opts) {
  const env = opts.env || process.env;
  const ctx = {
    runner: 'node',
    platform: opts.platform || process.platform,
    ci: Boolean(env.CI && String(env.CI).trim() !== '' && String(env.CI).toLowerCase() !== 'false'),
    explicit: Boolean(opts.explicit),
  };
  // Plan 89-09: the UNION of tests/skip-exceptions.d/*.json plus the legacy
  // single file when it exists. `exceptionsFile` still names ONE file, because
  // the gate's own tests drive it that way.
  const { entries, problems: fileProblems } = opts.exceptionsFile
    ? loadExceptions(opts.exceptionsFile)
    : loadUnionForGate(opts.repoRoot);
  const { observed, problems: obsProblems } = readObservations(opts.reportFile, opts.repoRoot);
  const hard = [...fileProblems, ...obsProblems].map((p) => ({
    code: p.code, file: EXCEPTIONS_REL, name: '', platform: ctx.platform, detail: p.detail,
  }));
  if (hard.length) {
    const result = { exit_code: EXIT_SKIP_GATE, findings: hard, counts: { observed_skips: observed.length, applicable_entries: 0, matched_entries: 0, stale_checked: false } };
    return { ...result, text: format(result, ctx) };
  }
  const result = evaluate({ entries, observed, ...ctx });
  return { ...result, text: format(result, ctx) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
//
// `--evaluate <file.json>`  the PARITY interface: the same input the Python half
//                           takes, the same JSON verdict out. The cross-language
//                           test in tests/88-19-skip-gate.test.cjs drives both.
// `--self-test-local-entry` the `context: "local"` proof: one synthetic local entry
//                           and the matching skip. Exits 0 without `CI`, 6 with it.

/**
 * Entry point.
 * @param {string[]} argv arguments after the script name
 * @returns {number} the process exit status
 */
function main(argv) {
  const repoRoot = path.resolve(__dirname, '..');
  if (argv[0] === '--evaluate') {
    const input = JSON.parse(fs.readFileSync(argv[1], 'utf-8'));
    let entries = input.entries;
    if (!entries) {
      const loaded = loadExceptions(input.exceptionsFile);
      if (loaded.problems.length) {
        process.stdout.write(`${JSON.stringify({ exit_code: EXIT_SKIP_GATE, findings: loaded.problems.map((p) => ({ code: p.code, file: EXCEPTIONS_REL, name: '', platform: input.platform, detail: p.detail })) }, null, 2)}\n`);
        return EXIT_SKIP_GATE;
      }
      entries = loaded.entries;
    }
    const result = evaluate({
      entries,
      observed: input.observed || [],
      runner: input.runner,
      platform: input.platform,
      ci: Boolean(input.ci),
      explicit: Boolean(input.explicit),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.exit_code;
  }

  if (argv[0] === '--self-test-local-entry') {
    const ci = Boolean(process.env.CI && String(process.env.CI).trim() !== '');
    const entry = {
      name: 'self-test: a local-only skip',
      file: 'tests/self-test.test.cjs',
      platform: 'all',
      context: 'local',
      reason: 'self-test of the context rule; this entry exists only inside this command',
      reason_class: 'self-test',
      owner: 'plan 88-19 (the gate itself)',
      owner_phase: 88,
      exit_criterion: 'never: this entry is synthetic and is never written to the file',
    };
    const result = evaluate({
      entries: [entry],
      observed: [{ kind: 'skip', file: entry.file, name: entry.name, reason: 'self-test' }],
      runner: 'node',
      platform: process.platform,
      ci,
      explicit: true,
    });
    process.stdout.write(`${format(result, { runner: 'node', platform: process.platform, ci, explicit: true })}\n`);
    process.stdout.write(ci
      ? 'self-test: CI is set, so the context: "local" entry was REFUSED and the skip is unlisted. A local-only entry excuses a skip only when CI is unset.\n'
      : 'self-test: CI is unset, so the context: "local" entry was ACCEPTED and the skip is excused.\n');
    return result.exit_code;
  }

  process.stderr.write([
    'usage: node scripts/skip-gate.cjs --evaluate <input.json>',
    '       node scripts/skip-gate.cjs --self-test-local-entry',
    '',
    'The gate itself runs from scripts/run-tests.cjs; these two modes exist for the',
    'cross-language parity test and for the context-rule proof.',
    '',
  ].join('\n'));
  return 2;
}

module.exports = {
  CODES,
  EXIT_SKIP_GATE,
  EXCEPTIONS_REL,
  EXCEPTIONS_DIR_REL,
  EXCEPTIONS_LEGACY_REL,
  SCHEMA,
  runnerOf,
  relativeTestFile,
  readEntryFile,
  validateEntries,
  loadExceptions,
  exceptionSources,
  loadUnion,
  loadUnionForGate,
  isApplicable,
  evaluate,
  format,
  readObservations,
  runNodeGate,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
