'use strict';

// ============================================================================
// Phase 82 — Domain Auditors Wave 2 behavioral test (plan 82-01, task 82-01-06).
//
// Proves the 3 ROADMAP success criteria across DOM2-01..05 for the five
// concrete read-only domain auditors instantiated from the Phase-80/81
// reference format:
//
//   DOM2-01 / SC1  gsd-auditor-frontend        — FRONT-01 (onClick on a bare
//                  <div>/<span> lacking role) and FRONT-05 (a non-public /
//                  *_SECRET env ref in client src) fire on a seeded JSX fixture
//                  and do NOT fire on a clean control (<button onClick>,
//                  NEXT_PUBLIC_ env).
//   DOM2-02 / SC1  gsd-auditor-api-connections  — APIC-01 (an outbound call with
//                  no timeout) and APIC-04 (a mutating POST with no idempotency
//                  key) fire on a seeded source fixture; a timeout'd fetch and an
//                  Idempotency-Key POST do NOT fire.
//   DOM2-03 / SC1+SC2 gsd-auditor-agentic-flow  — AGEN-04 fires on the REAL
//                  ceiling-absence (a grep across services/ + get-shit-done/bin/
//                  for a token/cost ceiling returns empty AND telemetry
//                  EVENT_TYPES carries no cost/token event) and AGEN-06 fires on
//                  the REAL eval-coverage gap (tests/evals/*.json sans
//                  grader-schemas.json == 3 vs the ~35-agent roster). SC2: the
//                  finding keys on the ceiling ABSENCE + the coverage ratio,
//                  never on a false "telemetry measures cost" premise.
//   DOM2-04 / SC1  gsd-auditor-mobile           — MOBL-A1 (a dangling manifest
//                  <uses-permission> with no code usage) and MOBL-A4 (an inline
//                  API key in strings.xml) fire on seeded manifest/resources
//                  fixtures; a used permission and an app_name string do NOT fire.
//   DOM2-05 / SC1  gsd-auditor-general          — GEN-06 (a doc referencing a
//                  path that does not resolve) and GEN-04 (a module unreferenced
//                  by any import) fire on seeded fixtures; a doc referencing a
//                  path that DOES resolve and a required module do NOT fire.
//
// Plus the cross-cutting framework invariants for all 5 auditors (SC3):
//   - each validates + compiles via the agent-compiler, byte-identical to the
//     committed .md (per-agent byte-lock), with the full fleet in sync at 35;
//   - each is read-only (tools Read/Bash/Grep/Glob, NO Write/Edit) and its .md
//     carries the "scan and report — never fix" boundary;
//   - each locked-rules table has an Owns/Overlap column cross-linking all four
//     of gsd-security/gsd-reviewer/gsd-qa/gsd-architect, and its deferred
//     security-scanner tokens co-occur with the owning agent on the same rule
//     row (a cross-link, not a re-implementation — anti-dup).
//
// Two layers:
//   ALWAYS-RUN  — require {validate,compile} from the compiler + source-analyze
//                 the committed artifacts + prove each documented Detect is sound
//                 on a genuine seeded/real violation. No daemon/PG needed.
//   LIVE-DAEMON — skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799} is
//                 unreachable; POSTs each auditor's exact finding shape, sweeps
//                 for it (SUBS-04), then PATCHes it cleared (leaves the substrate
//                 clean). The hyphenated daemon starts servers at import, so it
//                 is hit over HTTP, never required.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const COMPILER = path.join(ROOT, 'scripts', 'agent-compiler.cjs');
const SOURCE_DIR = path.join(ROOT, 'get-shit-done', 'agents');
const AGENTS_OUT = path.join(ROOT, 'agents');

const { validate, compile } = require(COMPILER);

// The 5 Wave-2 auditors under test — DOM2 requirement, name, source dir,
// compiled .md, headline rule ids, and audit domain string. The `antiDup`
// field pins the DEFER cross-link this auditor must carry (a rule row whose
// deferred check co-occurs with its owning agent — the anti-dup semantic).
const AUDITORS = [
  {
    req: 'DOM2-01',
    name: 'gsd-auditor-frontend',
    domain: 'frontend',
    rules: ['FRONT-01', 'FRONT-05'],
    antiDup: [{ rule: 'FRONT-05', owner: 'gsd-security' }],
  },
  {
    req: 'DOM2-02',
    name: 'gsd-auditor-api-connections',
    domain: 'api-connections',
    rules: ['APIC-01', 'APIC-04'],
    antiDup: [
      { rule: 'APIC-05', owner: 'gsd-security' },
      { rule: 'APIC-DEFER-ARCH', owner: 'gsd-architect' },
    ],
  },
  {
    req: 'DOM2-03',
    name: 'gsd-auditor-agentic-flow',
    domain: 'agentic-flow',
    rules: ['AGEN-04', 'AGEN-06'],
    antiDup: [{ rule: 'AGEN-09', owner: 'gsd-security' }],
  },
  {
    req: 'DOM2-04',
    name: 'gsd-auditor-mobile',
    domain: 'mobile',
    rules: ['MOBL-A1', 'MOBL-A4'],
    antiDup: [{ rule: 'MOBL-A4', owner: 'gsd-security' }],
  },
  {
    req: 'DOM2-05',
    name: 'gsd-auditor-general',
    domain: 'general',
    rules: ['GEN-04', 'GEN-06'],
    antiDup: [
      { rule: 'GEN-01', owner: 'gsd-security' },
      { rule: 'GEN-05', owner: 'gsd-qa' },
    ],
  },
].map((a) => ({
  ...a,
  dir: path.join(SOURCE_DIR, a.name),
  yaml: path.join(SOURCE_DIR, a.name, 'AGENT.yaml'),
  md: path.join(AGENTS_OUT, `${a.name}.md`),
}));

// Read each artifact once. `frontmatter` is everything before the `sections:`
// block — the tools list lives there, distinct from any Write/Edit prose lower.
for (const a of AUDITORS) {
  a.yamlSrc = fs.readFileSync(a.yaml, 'utf8');
  a.mdSrc = fs.readFileSync(a.md, 'utf8');
  a.frontmatter = a.yamlSrc.slice(0, a.yamlSrc.indexOf('sections:'));
  // Locked-rules table rows only (trimmed lines starting with '|') — the
  // Owns/Overlap anti-dup semantic is "same rule row", not example prose.
  a.tableRows = a.yamlSrc.split('\n').filter((l) => /^\s*\|/.test(l));
}

// ===========================================================================
// Framework invariants — compiles, read-only, cross-links (all 5, always-run)
// ===========================================================================

for (const a of AUDITORS) {
  test(`${a.req}: validate(${a.name}) → ok:true with zero errors`, () => {
    const r = validate(a.dir);
    assert.equal(r.ok, true, `validate must pass; errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.errors.length, 0, 'zero validation errors');
  });

  test(`${a.req}: compile(claude-code) emits exactly one .md, byte-identical to committed ${a.name}.md`, (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit82-'));
    t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

    const r = compile('claude-code', { source: SOURCE_DIR, agent: a.name, outDir: tmpDir });
    assert.equal(r.errors.length, 0, `compile must produce 0 errors. Got: ${JSON.stringify(r.errors)}`);
    assert.equal(r.compiled.length, 1, `compile must emit exactly 1 agent. Got: ${r.compiled.length}`);

    const fresh = fs.readFileSync(path.join(tmpDir, `${a.name}.md`), 'utf8');
    assert.equal(fresh, a.mdSrc, `freshly-compiled .md must be byte-identical to committed agents/${a.name}.md (byte-lock)`);
  });

  test(`${a.req}: ${a.name} is read-only — tools Read/Bash/Grep/Glob, NO Write/Edit (cannot patch)`, () => {
    for (const tool of ['Read', 'Bash', 'Grep', 'Glob']) {
      assert.match(a.frontmatter, new RegExp(`^\\s+- ${tool}\\s*$`, 'm'), `${a.name} tools list includes ${tool}`);
    }
    assert.equal(/^\s+- Write\s*$/m.test(a.frontmatter), false, `${a.name} read-only violation: Write tool present`);
    assert.equal(/^\s+- Edit\s*$/m.test(a.frontmatter), false, `${a.name} read-only violation: Edit tool present`);
    // Compiled .md frontmatter (inline list form) must also exclude Write/Edit.
    const mdFm = a.mdSrc.slice(0, a.mdSrc.indexOf('# Agent:'));
    assert.match(mdFm, /tools:\s*Read,\s*Bash,\s*Grep,\s*Glob/, `${a.name} compiled frontmatter tools = Read, Bash, Grep, Glob`);
    assert.equal(/tools:.*\b(Write|Edit)\b/.test(mdFm), false, `${a.name} compiled frontmatter must not list Write/Edit`);
  });

  test(`${a.req}: ${a.name} carries the POST /api/findings audit emission recipe + "scan and report — never fix" boundary`, () => {
    assert.ok(a.yamlSrc.includes('/api/findings'), `${a.name} emission endpoint present`);
    assert.match(a.yamlSrc, /finding_type.{0,4}audit/, `${a.name} finding_type='audit' present`);
    for (const field of ['rule_id', 'file_path', 'evidence', 'suggested_fix', 'severity']) {
      assert.ok(a.yamlSrc.includes(field), `${a.name} emission metadata field '${field}' present`);
    }
    assert.match(a.mdSrc, /scan and report/i, `${a.name} .md states the scan/report boundary`);
    assert.match(a.mdSrc, /never fix|do not fix/i, `${a.name} .md states the never-fix boundary`);
  });

  test(`${a.req}: ${a.name} locked-rules table names its headline rules, has Owns/Overlap, cross-links all 4 review agents`, () => {
    for (const rule of a.rules) {
      assert.ok(a.yamlSrc.includes(rule), `${a.name} documents headline rule ${rule}`);
    }
    assert.ok(a.yamlSrc.includes('Owns/Overlap'), `${a.name} has an Owns/Overlap column`);
    for (const agent of ['gsd-security', 'gsd-reviewer', 'gsd-qa', 'gsd-architect']) {
      assert.ok(a.yamlSrc.includes(agent), `${a.name} cross-links ${agent}`);
    }
  });

  test(`${a.req}: ${a.name} anti-dup — deferred security-scanner tokens co-occur with gsd-security on the same rule row (cross-link, not re-scan)`, () => {
    const SCANNERS = ['Gitleaks', 'Trivy', 'Semgrep'];
    let present = 0;
    for (const token of SCANNERS) {
      const hits = a.tableRows.filter((l) => l.includes(token));
      present += hits.length;
      for (const line of hits) {
        assert.ok(
          line.includes('gsd-security'),
          `${a.name}: '${token}' must co-occur with gsd-security on the same rule row (cross-link, not re-implementation): ${line.trim()}`
        );
      }
    }
    // At least one deferred security scan is cross-linked (the DEFER-to-security row exists).
    assert.ok(present >= 1, `${a.name} cross-links at least one deferred gsd-security scanner (DEFER row present)`);
  });

  test(`${a.req}: ${a.name} anti-dup — its DEFER rows name the OWNING agent on the same row (SC3 deferred-token co-occurrence)`, () => {
    for (const { rule, owner } of a.antiDup) {
      const row = a.tableRows.find((l) => l.includes(rule));
      assert.ok(row, `${a.name} has a locked-rules row for ${rule}`);
      assert.ok(
        row.includes(owner),
        `${a.name}: the ${rule} row must DEFER to ${owner} on the same row (cross-link, not a duplicate owned check): ${row.trim()}`
      );
    }
  });
}

// Full-fleet byte-match: the compiled fleet count equals the number of
// committed gsd-*.md files (35 after all five Wave-2 auditors land). This is
// the shared byte-match invariant, asserted ONCE here in the final wave, and
// dynamically enumerated (no hardcoded count that would drift).
test('REGRESSION: full-fleet compile count matches committed agents/gsd-*.md (35 after Wave-2 lands)', () => {
  const r = compile('claude-code', { source: SOURCE_DIR });
  assert.equal(r.errors.length, 0, `full-fleet compile must produce 0 errors. Got: ${JSON.stringify(r.errors)}`);
  const committed = fs.readdirSync(AGENTS_OUT).filter((f) => /^gsd-.*\.md$/.test(f)).length;
  assert.equal(r.compiled.length, committed, `compiled fleet (${r.compiled.length}) must equal committed gsd-*.md count (${committed})`);
  assert.equal(committed, 35, 'the fleet is at 35 agents after Wave-2 (5 new domain auditors landed)');
});

// ===========================================================================
// DETECT-FIRES — each documented Detect is sound on a genuine violation.
// Pure detector functions (deterministic-before-behavioral) proven on seeded
// fixtures + the real in-repo seeds; clean controls prove no false positives.
// ===========================================================================

// ---- Detector implementations (mirror each rule's documented Detect) -------

// FRONT-01: onClick on a bare <div>/<span> with no `role` attribute.
function detectOnClickBareDiv(jsxSrc) {
  const hits = [];
  const lines = jsxSrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A <div ...> or <span ...> opening tag that carries onClick but no role=.
    const m = line.match(/<(div|span)\b([^>]*)/);
    if (!m) continue;
    const attrs = m[2];
    if (/\bonClick\b/.test(attrs) && !/\brole\s*=/.test(attrs)) hits.push(i + 1);
  }
  return hits;
}

// FRONT-05: a client-src env reference that is neither NEXT_PUBLIC_ / VITE_
// prefixed nor otherwise public — a *_SECRET / private key leaked into the bundle.
function detectClientSecretEnv(src) {
  const hits = [];
  const re = /process\.env\.([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (name.startsWith('NEXT_PUBLIC_') || name.startsWith('VITE_')) continue; // public → OK
    if (/SECRET|PRIVATE|_KEY|TOKEN|PASSWORD/.test(name)) hits.push(name);
  }
  return hits;
}

// APIC-01: an outbound fetch() call with no timeout / AbortSignal option.
function detectFetchWithoutTimeout(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bfetch\s*\(/.test(line)) continue;
    if (/AbortSignal|timeout|signal\s*:/.test(line)) continue; // bounded → OK
    hits.push(i + 1);
  }
  return hits;
}

// APIC-04: a mutating POST/PUT request-config block with no idempotency key.
function detectPostWithoutIdempotencyKey(configSrc) {
  const isMutating = /method\s*:\s*['"](POST|PUT)['"]/i.test(configSrc)
    || /\.(post|put)\s*\(/.test(configSrc)
    || /-X\s*(POST|PUT)/i.test(configSrc);
  if (!isMutating) return false;
  const hasKey = /idempotency[-_]?key/i.test(configSrc);
  return !hasKey; // mutating without an idempotency key → finding
}

// AGEN-04: a token/cost budget-ceiling ENFORCEMENT anywhere in the given dirs.
// The finding is the ABSENCE — an empty result set means no hard ceiling exists.
const CEILING_RE = /budget_ceiling|token_ceiling|cost_ceiling|max_tokens_budget/;
function detectCeilingEnforcement(dirs) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(py|cjs|js|mjs|ts)$/.test(e.name)) continue;
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (CEILING_RE.test(txt)) hits.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

// AGEN-04 (second half): the telemetry EVENT_TYPES tuple carries no cost/token event.
function eventTypesHasCostEvent(telemetrySrc) {
  const m = telemetrySrc.match(/EVENT_TYPES\s*=\s*\(([\s\S]*?)\)/);
  if (!m) return false;
  return /cost|token/i.test(m[1]);
}

// AGEN-06: agent eval-set count (tests/evals/*.json sans grader-schemas.json).
function countAgentEvalSets(evalsDir) {
  return fs.readdirSync(evalsDir)
    .filter((f) => f.endsWith('.json') && f !== 'grader-schemas.json')
    .length;
}

// AGEN-06 (denominator): the gsd-* source-agent roster.
function countAgentRoster(sourceDir) {
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gsd-/.test(e.name))
    .length;
}

// MOBL-A1: a manifest <uses-permission> with no matching code usage (dangling).
function detectDanglingPermissions(manifestSrc, usedPermissions) {
  const used = new Set(usedPermissions);
  const hits = [];
  const re = /<uses-permission\s+android:name="([^"]+)"/g;
  let m;
  while ((m = re.exec(manifestSrc)) !== null) {
    if (!used.has(m[1])) hits.push(m[1]);
  }
  return hits;
}

// MOBL-A4: an inline high-entropy API key in a strings.xml <string> resource.
const BUNDLE_KEY_RE = /\b(AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|sk-[0-9A-Za-z]{20,})\b/;
function detectStringsXmlSecret(stringsXmlSrc) {
  const hits = [];
  const re = /<string\s+name="([^"]+)"\s*>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(stringsXmlSrc)) !== null) {
    if (BUNDLE_KEY_RE.test(m[2])) hits.push(m[1]);
  }
  return hits;
}

// GEN-06: a doc-referenced path that does not resolve on disk (doc drift).
function detectDocDrift(docSrc, baseDir) {
  const hits = [];
  const re = /`([\w./-]+\.(?:md|cjs|js|py|json|ts))`/g;
  let m;
  while ((m = re.exec(docSrc)) !== null) {
    const ref = m[1];
    if (!fs.existsSync(path.resolve(baseDir, ref))) hits.push(ref);
  }
  return hits;
}

// GEN-04: a module unreferenced by any import/require across the source set.
function detectUnreferencedModule(dir, moduleBaseName) {
  const stem = moduleBaseName.replace(/\.[^.]+$/, '');
  const entries = fs.readdirSync(dir).filter((f) => f !== moduleBaseName);
  for (const f of entries) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    const txt = fs.readFileSync(p, 'utf8');
    if (new RegExp(`(require|import)[^\\n]*['"\`][^'"\`]*${stem}`).test(txt)) return false; // referenced
  }
  return true; // unreferenced → dead file
}

// ---- SC1 — DOM2-01 FRONTEND (seeded, labelled) ----------------------------

test('DOM2-01 / SC1: FRONT-01 detect fires on a seeded onClick-on-bare-<div> and NOT on a <button> control', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe82-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const jsx = [
    'export function Card({ onOpen }) {',
    '  return (',
    '    <div onClick={onOpen}>Open</div>',          // (a) violation — bare div, no role
    '  );',
    '}',
    'export function OkButton({ onOpen }) {',
    '  return <button onClick={onOpen}>Open</button>;', // clean control — semantic button
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Card.jsx'), jsx);
  const src = fs.readFileSync(path.join(dir, 'Card.jsx'), 'utf8');

  const hits = detectOnClickBareDiv(src);
  assert.deepEqual(hits, [3], 'FRONT-01 flags the onClick-on-bare-<div> line only');
  assert.equal(hits.includes(7), false, 'FRONT-01 does NOT flag the <button onClick> control');

  const fe = AUDITORS.find((x) => x.name === 'gsd-auditor-frontend');
  assert.ok(fe.mdSrc.includes('FRONT-01'), 'frontend .md documents FRONT-01');
  assert.match(fe.mdSrc, /onClick[\s\S]{0,60}role/i, 'FRONT-01 detect names onClick on a bare div/span lacking role');
});

test('DOM2-01 / SC1: FRONT-05 detect fires on a seeded *_SECRET client env ref and NOT on a NEXT_PUBLIC_ control', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe82b-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const src = [
    'const apiUrl = process.env.NEXT_PUBLIC_API_URL;',   // clean control — public prefix
    'const secret = process.env.PRIVATE_SECRET;',        // (b) violation — secret into bundle
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.js'), src);
  const read = fs.readFileSync(path.join(dir, 'config.js'), 'utf8');

  const hits = detectClientSecretEnv(read);
  assert.deepEqual(hits, ['PRIVATE_SECRET'], 'FRONT-05 flags the non-public *_SECRET env ref only');
  assert.equal(hits.includes('NEXT_PUBLIC_API_URL'), false, 'FRONT-05 does NOT flag the NEXT_PUBLIC_ control');

  const fe = AUDITORS.find((x) => x.name === 'gsd-auditor-frontend');
  assert.ok(fe.mdSrc.includes('FRONT-05'), 'frontend .md documents FRONT-05');
  assert.match(fe.mdSrc, /NEXT_PUBLIC|_SECRET|secret/i, 'FRONT-05 detect names the public-prefix / secret rule');
});

// ---- SC1 — DOM2-02 API-CONNECTIONS (seeded, labelled) ---------------------

test('DOM2-02 / SC1: APIC-01 detect fires on a seeded fetch() with no timeout and NOT on an AbortSignal-bounded control', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac82-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const src = [
    'async function bad() {',
    "  return fetch('https://api.example.com/x');",                        // (a) violation — no timeout
    '}',
    'async function good() {',
    "  return fetch('https://api.example.com/x', { signal: AbortSignal.timeout(5000) });", // control — bounded
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'client.js'), src);
  const read = fs.readFileSync(path.join(dir, 'client.js'), 'utf8');

  const hits = detectFetchWithoutTimeout(read);
  assert.deepEqual(hits, [2], 'APIC-01 flags the unbounded fetch line only');
  assert.equal(hits.includes(5), false, 'APIC-01 does NOT flag the AbortSignal.timeout-bounded control');

  const ac = AUDITORS.find((x) => x.name === 'gsd-auditor-api-connections');
  assert.ok(ac.mdSrc.includes('APIC-01'), 'api-connections .md documents APIC-01');
  assert.match(ac.mdSrc, /timeout/i, 'APIC-01 detect names the explicit-timeout rule');
});

test('DOM2-02 / SC1: APIC-04 detect fires on a seeded mutating POST with no idempotency key and NOT on a keyed control', () => {
  const violation = [
    "await fetch('https://api.example.com/orders', {",
    "  method: 'POST',",
    "  body: JSON.stringify({ item: 1 }),",   // no Idempotency-Key
    '});',
  ].join('\n');
  const control = [
    "await fetch('https://api.example.com/orders', {",
    "  method: 'POST',",
    "  headers: { 'Idempotency-Key': crypto.randomUUID() },",
    "  body: JSON.stringify({ item: 1 }),",
    '});',
  ].join('\n');
  assert.equal(detectPostWithoutIdempotencyKey(violation), true, 'APIC-04 fires on the keyless mutating POST');
  assert.equal(detectPostWithoutIdempotencyKey(control), false, 'APIC-04 does NOT fire on the Idempotency-Key POST control');

  const ac = AUDITORS.find((x) => x.name === 'gsd-auditor-api-connections');
  assert.ok(ac.mdSrc.includes('APIC-04'), 'api-connections .md documents APIC-04');
  assert.match(ac.mdSrc, /idempoten/i, 'APIC-04 detect names the idempotency-key / dedup rule');
});

// ---- SC1 + SC2 — DOM2-03 AGENTIC-FLOW (REAL seeds) ------------------------

test('DOM2-03 / SC1+SC2: AGEN-04 detect fires on the REAL ceiling-absence (empty ceiling grep + no cost event in telemetry EVENT_TYPES)', () => {
  // (1) No token/cost budget-ceiling enforcement anywhere in services/ or bin/.
  const ceilingHits = detectCeilingEnforcement([
    path.join(ROOT, 'services'),
    path.join(ROOT, 'get-shit-done', 'bin'),
  ]);
  assert.deepEqual(ceilingHits, [], 'AGEN-04: a budget-ceiling enforcement grep across services/ + get-shit-done/bin/ returns EMPTY (the ceiling is absent — the finding)');

  // (2) telemetry EVENT_TYPES carries no cost/token event (do NOT assert it measures cost).
  const telemetrySrc = fs.readFileSync(path.join(ROOT, 'services', 'telemetry.py'), 'utf8');
  assert.equal(eventTypesHasCostEvent(telemetrySrc), false, 'AGEN-04: telemetry EVENT_TYPES has NO cost/token event (measurement-without-a-ceiling, not a false measures-cost premise)');

  const af = AUDITORS.find((x) => x.name === 'gsd-auditor-agentic-flow');
  assert.ok(af.mdSrc.includes('AGEN-04'), 'agentic-flow .md documents AGEN-04');
  assert.match(af.mdSrc, /ceiling/i, 'AGEN-04 evidence names the budget-ceiling absence');
  assert.match(af.mdSrc, /EVENT_TYPES|no cost|no token/i, 'AGEN-04 evidence names the telemetry no-cost-event half');
});

test('DOM2-03 / SC1+SC2: AGEN-06 detect fires on the REAL eval-coverage gap (3 agent eval sets vs the ~35-agent roster)', () => {
  const evalSets = countAgentEvalSets(path.join(ROOT, 'tests', 'evals'));
  const roster = countAgentRoster(SOURCE_DIR);
  assert.equal(evalSets, 3, 'AGEN-06: exactly 3 agent eval sets in tests/evals (sans grader-schemas.json)');
  assert.ok(roster >= 30, `AGEN-06: the gsd-* agent roster is large (${roster})`);
  assert.ok(evalSets < roster, `AGEN-06: eval coverage (${evalSets}) is a small fraction of the roster (${roster}) — the coverage gap fires`);

  const af = AUDITORS.find((x) => x.name === 'gsd-auditor-agentic-flow');
  assert.ok(af.mdSrc.includes('AGEN-06'), 'agentic-flow .md documents AGEN-06');
  assert.match(af.mdSrc, /eval[\s-]?coverage|eval scenario|eval set/i, 'AGEN-06 detect names eval-coverage breadth');
  assert.match(af.mdSrc, /3 of|3 agent|roster/i, 'AGEN-06 evidence names the 3-of-roster coverage ratio');
});

// ---- SC1 — DOM2-04 MOBILE (seeded, labelled) ------------------------------

test('DOM2-04 / SC1: MOBL-A1 detect fires on a seeded dangling <uses-permission> and NOT on a used one', () => {
  const manifest = [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '  <uses-permission android:name="android.permission.CAMERA" />',    // dangling — no code usage
    '  <uses-permission android:name="android.permission.INTERNET" />',  // used (control)
    '</manifest>',
  ].join('\n');
  // Only INTERNET is cross-referenced to a code usage; CAMERA dangles.
  const dangling = detectDanglingPermissions(manifest, ['android.permission.INTERNET']);
  assert.deepEqual(dangling, ['android.permission.CAMERA'], 'MOBL-A1 flags the dangling CAMERA permission only');
  assert.equal(dangling.includes('android.permission.INTERNET'), false, 'MOBL-A1 does NOT flag the code-referenced INTERNET permission');

  const mo = AUDITORS.find((x) => x.name === 'gsd-auditor-mobile');
  assert.ok(mo.mdSrc.includes('MOBL-A1'), 'mobile .md documents MOBL-A1');
  assert.match(mo.mdSrc, /uses-permission|dangling|permission/i, 'MOBL-A1 detect names the manifest-permission cross-ref');
  assert.match(mo.mdSrc, /ASTG|tree-sitter|Kotlin|Swift/i, 'mobile .md references the v3.4 Phase-69 ASTG (Kotlin/Swift) gate');
});

test('DOM2-04 / SC1: MOBL-A4 detect fires on a seeded inline strings.xml API key and NOT on a plain app_name string', () => {
  const stringsXml = [
    '<resources>',
    '  <string name="app_name">MyApp</string>',                              // clean control
    '  <string name="api_key">AKIAIOSFODNN7EXAMPLE1</string>',               // violation — bundle secret
    '</resources>',
  ].join('\n');
  const secrets = detectStringsXmlSecret(stringsXml);
  assert.deepEqual(secrets, ['api_key'], 'MOBL-A4 flags the inline API-key string resource only');
  assert.equal(secrets.includes('app_name'), false, 'MOBL-A4 does NOT flag the plain app_name string');

  const mo = AUDITORS.find((x) => x.name === 'gsd-auditor-mobile');
  assert.ok(mo.mdSrc.includes('MOBL-A4'), 'mobile .md documents MOBL-A4');
  assert.match(mo.mdSrc, /strings\.xml|bundle|app bundle/i, 'MOBL-A4 detect names the bundle-secret / strings.xml surface');
});

// ---- SC1 — DOM2-05 GENERAL (seeded, labelled) -----------------------------

test('DOM2-05 / SC1: GEN-06 detect fires on a seeded doc referencing an unresolved path and NOT on a resolvable one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen82-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  // A real file the control doc can resolve to.
  fs.writeFileSync(path.join(dir, 'runner.cjs'), '// real\n');
  const doc = [
    '# Usage',
    'Run `runner.cjs` to start.',                    // resolves (control)
    'See `docs/nonexistent-guide.md` for details.',  // does NOT resolve (violation)
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'USAGE.md'), doc);
  const read = fs.readFileSync(path.join(dir, 'USAGE.md'), 'utf8');

  const drift = detectDocDrift(read, dir);
  assert.deepEqual(drift, ['docs/nonexistent-guide.md'], 'GEN-06 flags the unresolved documented path only');
  assert.equal(drift.includes('runner.cjs'), false, 'GEN-06 does NOT flag the path that resolves on disk');

  const ge = AUDITORS.find((x) => x.name === 'gsd-auditor-general');
  assert.ok(ge.mdSrc.includes('GEN-06'), 'general .md documents GEN-06');
  assert.match(ge.mdSrc, /doc drift|resolve|version string/i, 'GEN-06 detect names doc drift (paths resolve / version match)');
});

test('DOM2-05 / SC1: GEN-04 detect fires on a seeded unreferenced module and NOT on a required one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen82b-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  // entry.js references live.js but nothing references orphan.js → orphan is dead.
  fs.writeFileSync(path.join(dir, 'entry.js'), "const live = require('./live');\nmodule.exports = live;\n");
  fs.writeFileSync(path.join(dir, 'live.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'orphan.js'), 'module.exports = 2;\n');

  assert.equal(detectUnreferencedModule(dir, 'orphan.js'), true, 'GEN-04 flags orphan.js — imported by nothing (dead file)');
  assert.equal(detectUnreferencedModule(dir, 'live.js'), false, 'GEN-04 does NOT flag live.js — required by entry.js');

  const ge = AUDITORS.find((x) => x.name === 'gsd-auditor-general');
  assert.ok(ge.mdSrc.includes('GEN-04'), 'general .md documents GEN-04');
  assert.match(ge.mdSrc, /dead|unreferenced/i, 'GEN-04 detect names repo-wide dead / unreferenced files');
  // Anti-dup: GEN-01 secrets DEFERS to gsd-security, GEN-05 coverage DEFERS to gsd-qa (cross-link).
  const gen01Row = ge.tableRows.find((l) => l.includes('GEN-01'));
  const gen05Row = ge.tableRows.find((l) => l.includes('GEN-05'));
  assert.ok(gen01Row && gen01Row.includes('gsd-security'), 'GEN-01 secrets row DEFERS to gsd-security (cross-link)');
  assert.ok(gen05Row && gen05Row.includes('gsd-qa'), 'GEN-05 coverage row DEFERS to gsd-qa (cross-link)');
});

// ===========================================================================
// LIVE-DAEMON — each auditor's finding shape round-trips POST → sweep → PATCH.
// Skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799} is unreachable.
// ===========================================================================

const PORT = parseInt(process.env.AMAUTA_PORT || '18799', 10);

function httpJson(method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function daemonReachable() {
  const r = await httpJson('GET', '/health');
  return r.status === 200 && r.json && r.json.status === 'ok';
}

for (const a of AUDITORS) {
  test(`LIVE ${a.req}: ${a.name} audit finding POSTs to /api/findings, lands in the SUBS-04 sweep, then PATCHes cleared`, async (t) => {
    if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }

    // A unique file_path keeps the server dedup_key (rule_id:sha1(file_path))
    // distinct so the POST creates rather than dedups.
    const ruleId = a.rules[0];
    const filePath = `tests/.fixtures/82-01-${a.domain}-${Date.now()}.txt`;
    const finding = {
      agent_name: a.name,
      finding_type: 'audit',
      severity: 'warning',
      rule_id: ruleId,
      domain: a.domain,
      file_path: filePath,
      evidence: `${ruleId} seeded/real violation detected by ${a.name}`,
      suggested_fix: `Remediate per ${ruleId}; gated through the Phase-79 router`,
      content: 'w2 auditor emission smoke (82-01-06)',
    };

    // POST — a read-only agent (no Write tool) files a finding, never a patch.
    const created = await httpJson('POST', '/api/findings', finding);
    assert.ok(created.status === 201 || created.status === 200, `POST returns 2xx (got ${created.status})`);
    const createdOk = (created.json && created.json.created === true) || (created.json && created.json.deduped === true);
    assert.ok(createdOk, `POST reports created or deduped: ${JSON.stringify(created.json)}`);
    const id = created.json.id || created.json.existing_id;
    assert.ok(id, 'a finding id (created or existing) is returned');

    // SWEEP — SUBS-04 cross-task sweep surfaces the audit finding by rule_id/path.
    const sweep = await httpJson('GET', '/api/findings?status=open&type=audit');
    assert.equal(sweep.status, 200, 'sweep returns 200');
    assert.ok(Array.isArray(sweep.json && sweep.json.findings), 'sweep returns a findings array');
    const mine = sweep.json.findings.find((f) => f.file_path === filePath && f.rule_id === ruleId);
    assert.ok(mine, `the posted ${a.name} audit finding is present in the open-audit sweep`);
    assert.equal(mine.finding_type, 'audit', 'the swept finding is an audit finding');

    // PATCH — close-loop cleanup; leaves the substrate clean.
    const cleared = await httpJson('PATCH', `/api/findings/${id}`, { status: 'cleared' });
    assert.equal(cleared.status, 200, 'PATCH succeeds');
    assert.equal(cleared.json.status, 'cleared', 'finding transitioned to cleared (substrate left clean)');
  });
}
