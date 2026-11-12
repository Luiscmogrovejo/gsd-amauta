/**
 * Planning drift — report every disagreement between STATE.md, ROADMAP.md,
 * REQUIREMENTS.md, PROJECT.md and the phase folders (plan 88-09, FND-06/FND-07).
 *
 * `planningDrift(rootDir)` is a pure function over a directory: it takes no
 * global state and never reads process.cwd(), so a committed fixture tree is as
 * testable as the operator's real `.planning/`. It only reads; it never writes.
 *
 * Finding ids (stable, the test file carries a mutation row for each):
 *   DRIFT_PHASE_NOT_IN_ROADMAP        a phase directory no roadmap lists
 *   DRIFT_ROADMAP_PHASE_MISSING_DIR   a started roadmap phase with no directory
 *   DRIFT_STATE_PROGRESS              STATE.md progress frontmatter vs ROADMAP.md
 *   DRIFT_STATE_PHASE_MAP             STATE.md Phase Map vs the ROADMAP phase list
 *   DRIFT_REQUIREMENT_TOTAL           a stated requirement total vs the counted ids
 *   DRIFT_PLAN_WITHOUT_SUMMARY        a *PLAN.md with no matching *SUMMARY.md
 *   DRIFT_SUMMARY_WITHOUT_PLAN        a *SUMMARY.md with no matching *PLAN.md
 *   DRIFT_SUMMARY_WITHOUT_VERIFICATION  a fully executed phase with no VERIFICATION
 *   DRIFT_ROADMAP_HEADING_UNPARSEABLE a "Phase N" heading the roadmap parser skips
 *   DRIFT_ROADMAP_FIELD_UNREADABLE    a phase whose Goal / Depends on / Requirements
 *                                     the roadmap parser cannot read
 *   DRIFT_EXCEPTION_MALFORMED         an exceptions entry missing a field
 *   DRIFT_EXCEPTION_STALE             an exception whose finding no longer fires
 *   DRIFT_EXCEPTION_UNMATCHED         an exception naming nothing on disk
 *   DRIFT_SKIP_OWNER_PHASE_COMPLETE   a skip-exceptions entry owned by a phase the
 *                                     ROADMAP already marks complete
 *   DRIFT_SKIP_LEDGER_MISMATCH        tests/skip-exceptions.d/ and the ROADMAP's
 *                                     Carried Test Obligations ledger disagree
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhaseName } = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');

/** Phase number as the roadmap writes it: 88, 94.1, 12A, 3.2.1 */
const NUM = '\\d+[A-Z]?(?:\\.\\d+)*';

/**
 * The roadmap parser's heading regex, copied from roadmap.cjs (cmdRoadmapAnalyze).
 * roadmap.cjs exports no pure parser (its functions take a cwd and call
 * process.exit), so the shape is restated here and a parity test in
 * tests/88-09-planning-drift.test.cjs compares this check against
 * `gsd-tools roadmap analyze` so the two cannot drift apart silently.
 */
const STRICT_HEADING_LINE = new RegExp(`^#{2,4}\\s*Phase\\s+(${NUM})\\s*:\\s*([^\\n]+)`, 'i');

/** Statuses that mean "work on this phase has not begun" (88-CONTEXT.md round 1). */
const NOT_STARTED = new Set(['not started', 'tbd', 'planned']);
/** STATE.md Phase Map also uses "Pending" for a phase nobody has touched. */
const STATE_NOT_STARTED = new Set(['', '-', '—', 'pending', 'not started', 'tbd', 'planned']);

const EXCEPTION_FIELDS = ['target', 'phase', 'finding', 'reason', 'recorded_in', 'date'];

function readText(file) {
  try {
    // CRLF checkouts (Windows autocrlf) would leave a \r on every captured value and
    // break the frontmatter delimiter, so every parser below sees LF only.
    return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  } catch (_) {
    return null;
  }
}

function key(num) {
  return normalizePhaseName(String(num)).toUpperCase();
}

function splitCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function finding(id, severity, files, message, target) {
  return { id, severity, files, message, target: target || path.basename(files[0] || ''), excepted: false };
}

/** Phase directories under <root>/phases that carry a leading phase number. */
function listPhaseDirs(root) {
  const dir = path.join(root, 'phases');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const m = e.name.match(new RegExp(`^(${NUM})-`, 'i'));
      return { name: e.name, num: m ? m[1] : null, files: safeList(path.join(dir, e.name)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (_) {
    return [];
  }
}

/** The "Earlier Work" block: from its ## heading to the next ## heading. */
function earlierWorkBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s.*Earlier Work/i.test(l));
  if (start === -1) return { block: '', startLine: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return { block: lines.slice(start, end).join('\n'), startLine: start };
}

/** Every phase number a block of roadmap text mentions as a phase entry. */
function phaseMentions(text) {
  const out = new Set();
  const re = new RegExp(`\\bPhase\\s+(${NUM})\\b`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) out.add(key(m[1]));
  // "Phases 41-47" style ranges, integer endpoints only
  const range = /\bPhases\s+(\d+)\s*[-–]\s*(\d+)\b/gi;
  while ((m = range.exec(text)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (b >= a && b - a < 200) for (let n = a; n <= b; n++) out.add(key(String(n)));
  }
  return out;
}

/** Phase numbers an archived milestone roadmap lists (headings, bullets, tables). */
function archivedPhases(root) {
  const out = new Set();
  const dir = path.join(root, 'milestones');
  for (const f of safeList(dir)) {
    if (!/-ROADMAP\.md$/i.test(f)) continue;
    const text = readText(path.join(dir, f)) || '';
    const entry = new RegExp(`^\\s*(?:#{2,4}\\s*|[-*]\\s*(?:\\[[ xX]\\]\\s*)?|\\|\\s*)\\**Phase\\s+(${NUM})\\b`, 'gim');
    let m;
    while ((m = entry.exec(text)) !== null) out.add(key(m[1]));
    for (const n of phaseMentions(text.split('\n').filter((l) => /^\s*[-*]?\s*\**Phases\s+\d/i.test(l)).join('\n'))) out.add(n);
  }
  return out;
}

/** ROADMAP.md progress table rows: number, status (and the statuses that count as done). */
function parseProgressTable(text) {
  const rows = [];
  const lines = text.split('\n');
  const earlier = lines.findIndex((l) => /^##\s.*Earlier Work/i.test(l));
  const limit = earlier === -1 ? lines.length : earlier;
  let statusCol = 2;
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitCells(line);
    const hdr = cells.findIndex((c) => /^status$/i.test(c));
    if (hdr !== -1) { statusCol = hdr; continue; }
    const m = (cells[0] || '').match(new RegExp(`^(${NUM})\\.?(?:\\s|$)`, 'i'));
    if (!m) continue;
    rows.push({ num: m[1], status: (cells[statusCol] || '').trim(), line: i + 1 });
  }
  return rows;
}

function isComplete(status) {
  return /^(complete|completed|done|shipped)\b/i.test(status) || /✅/.test(status);
}

/** `- [x] **Phase N: …` checkboxes of the current milestone list (not the Earlier Work block). */
function parseCheckboxes(text) {
  const out = new Map();
  const lines = text.split('\n');
  const earlier = lines.findIndex((l) => /^##\s.*Earlier Work/i.test(l));
  const limit = earlier === -1 ? lines.length : earlier;
  const re = new RegExp(`^\\s*-\\s*\\[([ xX])\\]\\s*\\**Phase\\s+(${NUM})\\s*[:*]`, 'i');
  for (let i = 0; i < limit; i++) {
    const m = lines[i].match(re);
    if (m) out.set(key(m[2]), m[1].toLowerCase() === 'x');
  }
  return out;
}

/** STATE.md "Phase Map" table rows: { num, name, status }. */
function parsePhaseMap(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s.*Phase Map/i.test(l));
  if (start === -1) return null;
  const rows = [];
  let seen = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      seen = true;
      const cells = splitCells(line);
      const m = (cells[0] || '').match(new RegExp(`^(${NUM})$`, 'i'));
      if (!m) continue;
      rows.push({ num: m[1], name: cells[1] || '', status: cells[cells.length - 1] || '' });
    } else if (seen && line.trim() !== '') {
      break;
    } else if (!seen && /^#{1,6}\s/.test(line)) {
      break;
    }
  }
  return rows;
}

function normName(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Run every check over a `.planning`-shaped directory.
 *
 * Args:
 *   rootDir: directory holding ROADMAP.md, STATE.md, REQUIREMENTS.md, PROJECT.md,
 *            phases/, optional milestones/ and drift-exceptions.json.
 *   opts: reserved; opts.exceptionsFile overrides the exceptions list location.
 *
 * Returns:
 *   { root, findings, excepted, exit_code } where each finding is
 *   { id, severity, files, message, target, excepted }. `findings` holds
 *   everything (excepted ones flagged), `excepted` the tolerated subset, and
 *   exit_code is 1 when any finding is not excepted.
 *
 * Example:
 *   const { planningDrift } = require('./planning-drift.cjs');
 *   const r = planningDrift('/repo/.planning');
 *   process.exitCode = r.exit_code;
 */
function planningDrift(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const rel = (...p) => p.join('/');
  const roadmapText = readText(path.join(root, 'ROADMAP.md')) || '';
  const stateText = readText(path.join(root, 'STATE.md')) || '';
  const raw = [];

  // ── Roadmap parse: loose heading scan, strict parse ───────────────────────
  // loose heading scan: any heading line "Phase N" with NO colon requirement.
  // A phase whose heading the strict parser skips is still *present* in the
  // roadmap, so it is accounted for in both directions below; one unparseable
  // heading then yields exactly one finding (naming the fix) instead of
  // cascading into DRIFT_PHASE_NOT_IN_ROADMAP / DRIFT_ROADMAP_PHASE_MISSING_DIR.
  const roadmapLines = roadmapText.split('\n');
  const loose = [];
  const looseRe = new RegExp(`^#{2,4}\\s*Phase\\s+(${NUM})\\b`, 'i');
  roadmapLines.forEach((line, i) => {
    const m = line.match(looseRe);
    if (!m) return;
    const strict = line.match(STRICT_HEADING_LINE);
    loose.push({ num: m[1], line, lineNo: i, strict: Boolean(strict), name: strict ? strict[2].replace(/\(INSERTED\)/i, '').trim() : null });
  });
  const looseKeys = new Set(loose.map((h) => key(h.num)));

  for (const h of loose) {
    if (!h.strict) {
      raw.push(finding('DRIFT_ROADMAP_HEADING_UNPARSEABLE', 'error', ['ROADMAP.md'],
        `heading "${h.line.trim()}" is skipped by the roadmap parser (it needs "## Phase ${h.num}: Name" with a colon); the phase is invisible to roadmap analyze`,
        `Phase ${h.num}`));
    }
  }

  // ── Check 6: field readability (shapes taken from roadmap.cjs analyze) ────
  for (const h of loose.filter((x) => x.strict)) {
    const rest = roadmapLines.slice(h.lineNo);
    let endIdx = rest.length;
    for (let i = 1; i < rest.length; i++) {
      if (/^#{2,4}\s+Phase\s+\d/i.test(rest[i])) { endIdx = i; break; }
    }
    const section = rest.slice(0, endIdx).join('\n');
    const bad = [];
    if (!/\*\*Goal:\*\*\s*([^\n]+)/i.test(section)) bad.push('**Goal:** (colon inside the bold)');
    if (!/\*\*Depends on:\*\*\s*([^\n]+)/i.test(section)) bad.push('**Depends on:** (colon inside the bold)');
    if (!/\*\*Requirements\*\*:\s*\S/i.test(section)) bad.push('**Requirements**: (colon outside the bold)');
    if (bad.length) {
      raw.push(finding('DRIFT_ROADMAP_FIELD_UNREADABLE', 'error', ['ROADMAP.md'],
        `Phase ${h.num}: roadmap parser cannot read ${bad.join(', ')}`, `Phase ${h.num}`));
    }
  }

  // ── Check 1: directories vs roadmap ───────────────────────────────────────
  const dirs = listPhaseDirs(root);
  const progressRows = parseProgressTable(roadmapText);
  const checkboxes = parseCheckboxes(roadmapText);
  const phaseMap = parsePhaseMap(stateText);
  const stateFm = extractFrontmatter(stateText);
  const { block: earlier } = earlierWorkBlock(roadmapText);
  const accounted = new Set([...looseKeys, ...phaseMentions(earlier), ...archivedPhases(root)]);

  // Direction A: a directory with no roadmap entry. Directories without a
  // leading phase number (audit-2026-07-10) are not phase directories.
  for (const d of dirs) {
    if (d.num === null) continue;
    if (!accounted.has(key(d.num))) {
      raw.push(finding('DRIFT_PHASE_NOT_IN_ROADMAP', 'error', [rel('phases', d.name)],
        `phases/${d.name} has no heading in ROADMAP.md, no entry in the Earlier Work block and no entry in milestones/*-ROADMAP.md`, d.name));
    }
  }

  // Direction B: a roadmap entry with no directory. A phase that has not been
  // started is not drift (88-CONTEXT.md, decisions after plan check round 1):
  // fire only when the records say work on it began. Order: progress table
  // row, else roadmap checkbox, else STATE.md. Phases not started are silent.
  const dirKeys = new Set(dirs.filter((d) => d.num !== null).map((d) => key(d.num)));
  const rowOf = (k) => progressRows.find((r) => key(r.num) === k);
  const currentFromState = (() => {
    if (stateFm.current_phase) return key(String(stateFm.current_phase).match(new RegExp(NUM, 'i'))?.[0] || '');
    const m = stateText.match(new RegExp(`^Phase:\\s*(${NUM})\\b`, 'im'));
    return m ? key(m[1]) : null;
  })();
  const completedFromState = new Set(Array.isArray(stateFm.completed_phases) ? stateFm.completed_phases.map((p) => key(p)) : []);

  function startedState(num) {
    const k = key(num);
    const row = rowOf(k);
    if (row) {
      const st = row.status.trim();
      return NOT_STARTED.has(st.toLowerCase()) ? null : `marked ${st} in the ROADMAP progress table`;
    }
    if (checkboxes.has(k)) return checkboxes.get(k) ? 'ticked in the ROADMAP phase list' : null;
    if (currentFromState === k) return 'the current phase in STATE.md';
    if (completedFromState.has(k)) return 'in the completed phases of STATE.md';
    const mapRow = (phaseMap || []).find((r) => key(r.num) === k);
    if (mapRow && !STATE_NOT_STARTED.has(mapRow.status.trim().toLowerCase())) return `marked ${mapRow.status.trim()} in the STATE.md Phase Map`;
    return null;
  }

  for (const h of loose.filter((x) => x.strict)) {
    if (dirKeys.has(key(h.num))) continue;
    const why = startedState(h.num);
    if (why) {
      raw.push(finding('DRIFT_ROADMAP_PHASE_MISSING_DIR', 'error', ['ROADMAP.md', 'phases'],
        `phase ${h.num} is ${why} but phases/${normalizePhaseName(h.num)}-* does not exist`, `Phase ${h.num}`));
    }
  }

  // ── Check 2: STATE progress frontmatter vs ROADMAP ────────────────────────
  const progressFm = stateFm.progress && typeof stateFm.progress === 'object' ? stateFm.progress : {};
  const totalCounted = progressRows.length || loose.length;
  const doneByTable = progressRows.filter((r) => isComplete(r.status)).length;
  const doneByBoxes = [...checkboxes.values()].filter(Boolean).length;
  const checkNum = (field, stated, counted, source) => {
    const s = stated === undefined ? 'missing' : String(stated);
    if (s !== String(counted)) {
      raw.push(finding('DRIFT_STATE_PROGRESS', 'error', ['STATE.md', 'ROADMAP.md'],
        `STATE.md progress.${field} is ${s} but ${source} gives ${counted}`, `progress.${field}`));
    }
  };
  checkNum('total_phases', progressFm.total_phases, totalCounted, 'the ROADMAP progress table');
  checkNum('completed_phases', progressFm.completed_phases, doneByTable, 'the ROADMAP progress table');
  if (checkboxes.size && doneByBoxes !== doneByTable) {
    checkNum('completed_phases', progressFm.completed_phases, doneByBoxes, 'the ROADMAP phase checkboxes');
  }
  const pct = totalCounted ? Math.round((100 * doneByTable) / totalCounted) : 0;
  checkNum('percent', progressFm.percent, pct, `${doneByTable}/${totalCounted} phases complete`);
  if (stateFm.status !== undefined && totalCounted) {
    const stateSaysDone = /^(complete|completed|shipped|done)$/i.test(String(stateFm.status).trim());
    const allDone = doneByTable === totalCounted;
    if (stateSaysDone !== allDone) {
      raw.push(finding('DRIFT_STATE_PROGRESS', 'error', ['STATE.md', 'ROADMAP.md'],
        `STATE.md status is "${stateFm.status}" but ROADMAP.md has ${doneByTable} of ${totalCounted} phases complete`, 'status'));
    }
  }

  // ── Check 3: STATE Phase Map vs ROADMAP phase list ────────────────────────
  if (phaseMap) {
    const roadmapByKey = new Map(loose.map((h) => [key(h.num), h]));
    const mapKeys = new Set(phaseMap.map((r) => key(r.num)));
    for (const r of phaseMap) {
      const h = roadmapByKey.get(key(r.num));
      if (!h) {
        raw.push(finding('DRIFT_STATE_PHASE_MAP', 'error', ['STATE.md', 'ROADMAP.md'],
          `STATE.md Phase Map lists phase ${r.num} (${r.name}) but ROADMAP.md has no such phase`, `Phase ${r.num}`));
      } else if (h.name !== null && normName(h.name) !== normName(r.name)) {
        raw.push(finding('DRIFT_STATE_PHASE_MAP', 'error', ['STATE.md', 'ROADMAP.md'],
          `phase ${r.num} is "${r.name}" in the STATE.md Phase Map but "${h.name}" in ROADMAP.md`, `Phase ${r.num}`));
      }
    }
    for (const h of loose) {
      if (!mapKeys.has(key(h.num))) {
        raw.push(finding('DRIFT_STATE_PHASE_MAP', 'error', ['STATE.md', 'ROADMAP.md'],
          `ROADMAP.md lists phase ${h.num} but the STATE.md Phase Map has no row for it (map has ${phaseMap.length} rows, roadmap ${loose.length})`, `Phase ${h.num}`));
      }
    }
  }

  // ── Check 4: requirement totals ───────────────────────────────────────────
  checkRequirementTotals(root, raw);

  // ── Check 7 (plan 88-19): the skip ledger ─────────────────────────────────
  checkSkipLedger(root, raw, roadmapText, progressRows, checkboxes);

  // ── Check 5: plan / summary / verification coverage ───────────────────────
  // The `wave` frontmatter check from `validate consistency` is deliberately
  // omitted: 14 existing plans lack it and 88-RESEARCH.md section 3.4 marks it
  // optional. It is not forgotten.
  // The phase STATE.md names as current is in flight: its plans without a
  // summary are pending work, not drift, and it is not yet due a VERIFICATION.
  // The moment STATE.md moves on, any leftover plan in it is reported.
  for (const d of dirs) {
    const plans = d.files.filter((f) => /PLAN\.md$/.test(f));
    const summaries = d.files.filter((f) => /SUMMARY\.md$/.test(f));
    const inFlight = d.num !== null && currentFromState !== null && key(d.num) === currentFromState;
    for (const p of plans) {
      const partner = p.replace(/PLAN\.md$/, 'SUMMARY.md');
      if (!inFlight && !d.files.includes(partner)) {
        raw.push(finding('DRIFT_PLAN_WITHOUT_SUMMARY', 'warning', [rel('phases', d.name, p)],
          `phases/${d.name}/${p} has no ${partner}`, p));
      }
    }
    for (const s of summaries) {
      const partner = s.replace(/SUMMARY\.md$/, 'PLAN.md');
      if (!d.files.includes(partner)) {
        raw.push(finding('DRIFT_SUMMARY_WITHOUT_PLAN', 'warning', [rel('phases', d.name, s)],
          `phases/${d.name}/${s} has no ${partner}`, s));
      }
    }
    // A VERIFICATION follows execution: require it once every plan of the phase
    // has its summary; a phase with a plan still unsummarised is not yet due one.
    const allSummarised = plans.length > 0 && plans.every((p) => d.files.includes(p.replace(/PLAN\.md$/, 'SUMMARY.md')));
    const hasVerification = d.files.some((f) => /VERIFICATION\.md$/.test(f));
    if (!inFlight && summaries.length > 0 && allSummarised && !hasVerification) {
      raw.push(finding('DRIFT_SUMMARY_WITHOUT_VERIFICATION', 'warning', [rel('phases', d.name)],
        `phases/${d.name} has ${summaries.length} SUMMARY file(s) and every plan is summarised but no VERIFICATION.md`, d.name));
    }
  }

  return applyExceptions(root, raw, opts);
}

// ─── The skip ledger (plan 88-19) ────────────────────────────────────────────
//
// The operator's standing decision is that NOTHING DEFERRED GETS LOST. A skip with
// an owner is a deferral; without a link to the records it is a deferral nobody will
// revisit. Two findings close that:
//
//   DRIFT_SKIP_OWNER_PHASE_COMPLETE  an entry whose owner_phase the ROADMAP marks
//                                    complete — a test deferred to a phase that then
//                                    finished without closing it.
//   DRIFT_SKIP_LEDGER_MISMATCH       the skip ledger and the ROADMAP's "Carried
//                                    Test Obligations" ledger disagree, in one of
//                                    three directions, each reported distinctly.
//
// Plan 89-09 sharded the ledger: the entries are the UNION of
// tests/skip-exceptions.d/*.json plus tests/skip-exceptions.json when that legacy
// file still exists. Both are accepted inputs, and an absent directory together
// with an absent file is still silent — see skipExceptionsSources.

/** Fields of a skip-exceptions entry this verb needs. The GATE owns the full schema. */
const SKIP_ENTRY_FIELDS = ['reason_class', 'owner_phase'];

/**
 * The REPOSITORY the skip ledger belongs to, relative to a planning root. ONE
 * rule, one expression: the directory that CONTAINS the planning records — the
 * parent of a root named `.planning` (the operator's real repository) and the root
 * itself for a fixture tree, which is a self-contained, repository-shaped
 * directory carrying its own `tests/`.
 *
 * @param {string} root absolute planning root
 * @returns {string} absolute path of the repository root
 */
function skipLedgerRoot(root) {
  return path.basename(root) === '.planning' ? path.dirname(root) : root;
}

/**
 * Where the legacy single skip-exceptions file lives. Still read when present:
 * `tests/fixtures/planning-drift/skip-ledger-{agrees,disagrees}/` carry one, and
 * rewriting those fixture trees would mix a fixture change into a loader change.
 *
 * @param {string} root absolute planning root
 * @returns {string} absolute path of the legacy exceptions file
 */
function skipExceptionsPath(root) {
  return path.join(skipLedgerRoot(root), 'tests', 'skip-exceptions.json');
}

/**
 * Every file the skip ledger is read from, in load order: the `*.json` shards of
 * `tests/skip-exceptions.d/` sorted by name (plan 89-09), then the legacy single
 * file when it exists.
 *
 * An ABSENT directory and an ABSENT file together produce no finding at all. That
 * is not leniency: the five pre-existing fixture trees and any other repository
 * that runs this verb have neither, and a "missing ledger" finding would turn all
 * thirteen existing findings into noise everywhere.
 *
 * @param {string} root absolute planning root
 * @returns {{label: string, path: string}[]} possibly empty
 */
function skipExceptionsSources(root) {
  const repo = skipLedgerRoot(root);
  const dir = path.join(repo, 'tests', 'skip-exceptions.d');
  const sources = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    sources.push({ label: `tests/skip-exceptions.d/${name}`, path: path.join(dir, name) });
  }
  const legacy = skipExceptionsPath(root);
  if (readText(legacy) !== null) sources.push({ label: 'tests/skip-exceptions.json', path: legacy });
  return sources;
}

/**
 * Parse the ROADMAP's "Carried Test Obligations" ledger.
 *
 * The table was free text with three columns and nothing tying a row to an entry;
 * plan 88-19 adds a fourth, machine-readable column, `Class id`, holding the
 * `reason_class` LABEL the entries of a row share, with `—` for a row that
 * deliberately has no entries (the Voyage row is exactly that case). A table with no
 * `Class id` header is read as having no keyed rows, so the only findings it can
 * produce are "this class has no ledger row" — which is the honest report for a
 * ledger that has not been updated yet.
 *
 * @param {string} text the ROADMAP.md source
 * @returns {{present: boolean, keyed: boolean, rows: {classId: string, phase: number|null, phaseText: string}[]}}
 */
function parseSkipLedger(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Carried Test Obligations/i.test(l));
  if (start === -1) return { present: false, keyed: false, rows: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const rows = [];
  let keyed = false;
  let classCol = -1;
  let phaseCol = -1;
  for (let i = start + 1; i < end; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = splitCells(lines[i]);
    const ci = cells.findIndex((c) => /^class id$/i.test(c));
    if (ci !== -1) {
      keyed = true;
      classCol = ci;
      phaseCol = cells.findIndex((c) => /^owning phase$/i.test(c));
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!keyed) continue;
    const classId = (cells[classCol] || '').replace(/`/g, '').trim();
    if (!classId || classId === '—' || classId === '-') continue;
    const phaseText = (phaseCol >= 0 ? cells[phaseCol] : cells[cells.length - 1]) || '';
    const m = phaseText.match(/Phase\s+(\d+)/i);
    rows.push({ classId, phase: m ? parseInt(m[1], 10) : null, phaseText: phaseText.trim() });
  }
  return { present: true, keyed, rows };
}

/**
 * Phases the ROADMAP marks complete: progress-table status first, ticked checkbox second.
 *
 * @param {{num: string, status: string}[]} progressRows
 * @param {Map<string, boolean>} checkboxes
 * @returns {Map<string, string>} phase key -> the words that say it is complete
 */
function completePhases(progressRows, checkboxes) {
  const done = new Map();
  for (const r of progressRows) {
    if (isComplete(r.status)) done.set(key(r.num), `"${r.status.trim()}" in the ROADMAP progress table`);
  }
  for (const [k, ticked] of checkboxes) {
    if (ticked && !done.has(k)) done.set(k, 'ticked in the ROADMAP phase list');
  }
  return done;
}

/**
 * Compare the skip ledger — the union of `tests/skip-exceptions.d/*.json` plus the
 * legacy `tests/skip-exceptions.json` — with the ROADMAP ledger (plan 88-19,
 * sharded by plan 89-09).
 *
 * @param {string} root planning root
 * @param {object[]} raw the findings array to append to
 * @param {string} roadmapText ROADMAP.md source
 * @param {{num: string, status: string}[]} progressRows
 * @param {Map<string, boolean>} checkboxes
 * @returns {void}
 */
function checkSkipLedger(root, raw, roadmapText, progressRows, checkboxes) {
  const rel = 'tests/skip-exceptions.d/';
  const sources = skipExceptionsSources(root);
  if (!sources.length) return; // absent directory AND absent file: no finding, by design

  const entries = [];
  for (const source of sources) {
    const text = readText(source.path);
    if (text === null) {
      raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [source.label],
        `${source.label} could not be read, so the ledger cannot be compared with it`, source.label));
      return;
    }
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [source.label],
        `${source.label} is not valid JSON (${e.message}), so the ledger cannot be compared with it`, source.label));
      return;
    }
    if (!Array.isArray(doc)) {
      raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [source.label],
        `${source.label} must be a flat array of entries; the ledger cannot be compared with a ${typeof doc}`, source.label));
      return;
    }
    entries.push(...doc);
  }
  const malformed = entries.filter((e) => !e || typeof e !== 'object'
    || typeof e.reason_class !== 'string' || !Number.isInteger(e.owner_phase));
  if (malformed.length) {
    raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [rel],
      `${malformed.length} of ${entries.length} entries in ${rel} lack a string reason_class or an integer owner_phase, so the ledger cannot be compared with them`, rel));
    return;
  }

  // ── Finding 1: an entry owned by a phase that is already complete ───────────
  // Grouped by (owner_phase, reason_class), which is the actionable unit: a class is
  // what a ledger row covers. One finding per group, naming the entries it holds, so
  // a phase with 400 open entries yields a readable report instead of 400 lines.
  const done = completePhases(progressRows, checkboxes);
  const groups = new Map();
  for (const e of entries) {
    const k = `${e.owner_phase}|${e.reason_class}`;
    if (!groups.has(k)) groups.set(k, { phase: e.owner_phase, classId: e.reason_class, names: [] });
    groups.get(k).names.push(`${e.file} :: ${e.name}`);
  }
  for (const g of [...groups.values()].sort((a, b) => (a.phase - b.phase) || a.classId.localeCompare(b.classId))) {
    const status = done.get(key(String(g.phase)));
    if (!status) continue;
    const shown = g.names.slice(0, 5).join('; ');
    const more = g.names.length > 5 ? ` and ${g.names.length - 5} more` : '';
    raw.push(finding('DRIFT_SKIP_OWNER_PHASE_COMPLETE', 'error', [rel, 'ROADMAP.md'],
      `${g.names.length} entr${g.names.length === 1 ? 'y' : 'ies'} in ${rel} with reason_class "${g.classId}" name owner_phase ${g.phase}, but ROADMAP.md marks phase ${g.phase} ${status}: ${shown}${more}`,
      `${g.classId}@phase${g.phase}`));
  }

  // ── Finding 2: the file and the ledger disagree, in three named directions ──
  const ledger = parseSkipLedger(roadmapText);
  const byClass = new Map();
  for (const e of entries) {
    if (!byClass.has(e.reason_class)) byClass.set(e.reason_class, { count: 0, phases: new Set() });
    const c = byClass.get(e.reason_class);
    c.count += 1;
    c.phases.add(e.owner_phase);
  }
  const rowOfClass = new Map(ledger.rows.map((r) => [r.classId, r]));

  for (const classId of [...byClass.keys()].sort()) {
    const info = byClass.get(classId);
    const row = rowOfClass.get(classId);
    if (!row) {
      raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [rel, 'ROADMAP.md'],
        `direction: ENTRY WITH NO LEDGER ROW — ${rel} has ${info.count} entr${info.count === 1 ? 'y' : 'ies'} with reason_class "${classId}" (owner_phase ${[...info.phases].sort((a, b) => a - b).join(', ')}) but the ROADMAP's Carried Test Obligations ledger has no row with that Class id`,
        classId));
      continue;
    }
    for (const phase of [...info.phases].sort((a, b) => a - b)) {
      if (row.phase === phase) continue;
      raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [rel, 'ROADMAP.md'],
        `direction: DIFFERING PHASE — entries with reason_class "${classId}" in ${rel} name owner_phase ${phase}, but the ledger row for that Class id names "${row.phaseText}"`,
        classId));
    }
  }
  for (const row of ledger.rows) {
    if (byClass.has(row.classId)) continue;
    raw.push(finding('DRIFT_SKIP_LEDGER_MISMATCH', 'error', [rel, 'ROADMAP.md'],
      `direction: LEDGER ROW WITH NO ENTRY — the Carried Test Obligations row with Class id "${row.classId}" (${row.phaseText}) matches no entry in ${rel}; delete the row, or give the entries it describes that reason_class`,
      row.classId));
  }
}

function checkRequirementTotals(root, raw) {
  const reqText = readText(path.join(root, 'REQUIREMENTS.md'));
  if (reqText === null) return;
  const ids = new Set();
  const rows = new Set();
  for (const line of reqText.split('\n')) {
    let m = line.match(/^\s*-\s*\[[ xX]\]\s*\*\*([A-Z]+-\d+)\*\*/);
    if (m) ids.add(m[1]);
    m = line.match(/^\|\s*([A-Z]+-\d+)\s*\|/);
    if (m) rows.add(m[1]);
  }
  const counted = ids.size;
  if (rows.size && rows.size !== counted) {
    raw.push(finding('DRIFT_REQUIREMENT_TOTAL', 'error', ['REQUIREMENTS.md'],
      `REQUIREMENTS.md traceability table has ${rows.size} rows but ${counted} requirement ids are listed`, 'traceability'));
  }
  const mappedExpected = rows.size || counted;
  const patterns = [
    { re: /v1 requirements:\s*(\d+)/gi, expect: () => counted },
    { re: /Mapped to phases:\s*(\d+)/gi, expect: () => mappedExpected },
    { re: /\b(\d+)(?:\s*\/\s*(\d+))?\s+(?:v1\s+)?requirements\b(?!\s+(?:added|moved))/gi, expect: () => counted, scoped: true },
    { re: /\b(\d+)\s+v1\b(?!\s+requirements)/gi, expect: () => counted, scoped: true },
  ];
  for (const file of ['REQUIREMENTS.md', 'ROADMAP.md', 'STATE.md', 'PROJECT.md']) {
    const text = readText(path.join(root, file));
    if (text === null) continue;
    const seen = new Set();
    text.split('\n').forEach((line, i) => {
      for (const { re, expect, scoped } of patterns) {
        // Loose "N requirements" mentions are only totals of the current set when
        // the line names it; PROJECT.md is full of "55 requirements" about old milestones.
        if (scoped && !/REQUIREMENTS\.md|\bmapped\b|\bv1\b/i.test(line)) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          for (const g of [m[1], m[2]]) {
            if (g === undefined) continue;
            const stated = parseInt(g, 10);
            const want = expect();
            const k = `${i}:${m.index}:${g}`;
            if (stated !== want && !seen.has(k)) {
              seen.add(k);
              raw.push(finding('DRIFT_REQUIREMENT_TOTAL', 'error', [file],
                `${file}:${i + 1} states ${stated} requirements but ${want} are counted`, `${file}:${i + 1}`));
            }
          }
        }
      }
    });
  }
}

// ─── Recorded exceptions ─────────────────────────────────────────────────────

function targetExists(root, target) {
  const phases = path.join(root, 'phases');
  if (fs.existsSync(path.join(root, target))) return true;
  if (fs.existsSync(path.join(phases, target))) return true;
  return listPhaseDirsAll(phases).some((d) => fs.existsSync(path.join(phases, d, target)));
}

function listPhaseDirsAll(phases) {
  try {
    return fs.readdirSync(phases, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/** The phase directory a finding belongs to, for matching an exception's `phase`. */
function findingPhaseDir(f) {
  const m = (f.files[0] || '').match(/^phases\/([^/]+)/);
  return m ? m[1] : null;
}

function applyExceptions(root, raw, opts) {
  const file = opts.exceptionsFile || path.join(root, 'drift-exceptions.json');
  const out = [...raw];
  const text = readText(file);
  const valid = [];
  if (text !== null) {
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      out.push(finding('DRIFT_EXCEPTION_MALFORMED', 'error', ['drift-exceptions.json'], `drift-exceptions.json is not valid JSON: ${e.message}`, 'drift-exceptions.json'));
    }
    if (doc !== null) {
      const list = doc && Array.isArray(doc.exceptions) ? doc.exceptions : null;
      if (!list) {
        out.push(finding('DRIFT_EXCEPTION_MALFORMED', 'error', ['drift-exceptions.json'], 'drift-exceptions.json has no "exceptions" array', 'drift-exceptions.json'));
      } else {
        list.forEach((e, i) => {
          const missing = EXCEPTION_FIELDS.filter((k) => !e || typeof e[k] !== 'string' || e[k].trim() === '');
          if (missing.length) {
            out.push(finding('DRIFT_EXCEPTION_MALFORMED', 'error', ['drift-exceptions.json'],
              `exception #${i + 1} (${e && e.target ? e.target : 'no target'}) is missing: ${missing.join(', ')}`, `exception#${i + 1}`));
          } else {
            valid.push(e);
          }
        });
      }
    }
  }

  // An exception matches a finding on (target, finding id) and, when the finding
  // lives in a phase directory, that directory too. Matching is computed over
  // the findings *before* any exception, so a stale entry is detectable.
  const matched = new Set();
  const isExcepted = (f) => valid.some((e) => {
    if (e.finding !== f.id || e.target !== f.target) return false;
    const pd = findingPhaseDir(f);
    return pd === null || pd === e.phase;
  });
  for (const f of raw) {
    if (isExcepted(f)) {
      f.excepted = true;
      valid.forEach((e, idx) => {
        const pd = findingPhaseDir(f);
        if (e.finding === f.id && e.target === f.target && (pd === null || pd === e.phase)) matched.add(idx);
      });
    }
  }
  valid.forEach((e, idx) => {
    if (matched.has(idx)) return;
    if (targetExists(root, e.target)) {
      out.push(finding('DRIFT_EXCEPTION_STALE', 'error', ['drift-exceptions.json'],
        `exception for ${e.target} no longer applies: ${e.finding} did not fire; remove it from drift-exceptions.json`, e.target));
    } else {
      out.push(finding('DRIFT_EXCEPTION_UNMATCHED', 'error', ['drift-exceptions.json'],
        `exception for ${e.target} names nothing on disk (${e.finding}); correct or remove it in drift-exceptions.json`, e.target));
    }
  });

  return {
    root,
    findings: out,
    excepted: out.filter((f) => f.excepted),
    exit_code: out.some((f) => f.excepted === false) ? 1 : 0,
  };
}

module.exports = { planningDrift };
