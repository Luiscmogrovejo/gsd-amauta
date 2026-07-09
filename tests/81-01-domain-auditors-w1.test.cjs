'use strict';

// ============================================================================
// Phase 81 — Domain Auditors Wave 1 behavioral test (plan 81-01, task 81-01-05).
//
// Proves the 4 ROADMAP success criteria across DOM1-01..04 for the four
// concrete read-only domain auditors instantiated from the Phase-80 reference
// format:
//
//   DOM1-01 / SC1  gsd-auditor-harness-self — HARN-02 (validator==claimer) and
//                  HARN-03 (manifest_violation without a divergence_report) fire
//                  on a seeded task ledger and do NOT fire on a clean control.
//   DOM1-02 / SC2  gsd-auditor-backend — BACK-05 (a migration UP missing a
//                  non-empty DOWN sibling) and BACK-06 (a DB call lexically
//                  inside a loop) fire on seeded fixtures; a clean UP/DOWN pair
//                  and a loop-free source do NOT fire.
//   DOM1-03 / SC3  gsd-auditor-infra — INFRA-01 (:latest / bare-tag image) fires
//                  on a seeded compose AND on the REAL docker/docker-compose.yml
//                  paradedb/paradedb:latest-pg16, and NOT on a digest-pinned
//                  image; INFRA-03 (a compose service with no healthcheck) fires
//                  on a seeded healthcheck-less service.
//   DOM1-04 / SC4  gsd-auditor-models — MODL-01/MODL-06 (an inline
//                  claude-<tier>-<date> literal outside the config module) fire
//                  on the REAL services/memory_classifier.py and
//                  get-shit-done/bin/gsd-memory.cjs, and NOT on
//                  .planning/config.json model_routing (tier names, not literals).
//
// Plus the cross-cutting framework invariants for all 4 auditors:
//   - each validates + compiles via the agent-compiler, byte-identical to the
//     committed .md (per-agent byte-lock), with the full fleet in sync at 30;
//   - each is read-only (tools Read/Bash/Grep/Glob, NO Write/Edit) and its .md
//     carries the "scan and report — never fix" boundary;
//   - each locked-rules table has an Owns/Overlap column cross-linking all four
//     of gsd-security/gsd-reviewer/gsd-qa/gsd-architect, and its deferred
//     security-scanner tokens co-occur with gsd-security on the same rule row
//     (a cross-link, not a re-implementation — anti-dup).
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

// The 4 Wave-1 auditors under test — name, source dir, compiled .md, headline
// rule ids (DOM1 requirement), and audit domain string.
const AUDITORS = [
  {
    req: 'DOM1-01',
    name: 'gsd-auditor-harness-self',
    domain: 'harness-self',
    rules: ['HARN-02', 'HARN-03'],
  },
  {
    req: 'DOM1-02',
    name: 'gsd-auditor-backend',
    domain: 'backend',
    rules: ['BACK-05', 'BACK-06'],
  },
  {
    req: 'DOM1-03',
    name: 'gsd-auditor-infra',
    domain: 'infra',
    rules: ['INFRA-01', 'INFRA-03'],
  },
  {
    req: 'DOM1-04',
    name: 'gsd-auditor-models',
    domain: 'models',
    rules: ['MODL-01', 'MODL-06'],
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
// Framework invariants — compiles, read-only, cross-links (all 4, always-run)
// ===========================================================================

for (const a of AUDITORS) {
  test(`${a.req}: validate(${a.name}) → ok:true with zero errors`, () => {
    const r = validate(a.dir);
    assert.equal(r.ok, true, `validate must pass; errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.errors.length, 0, 'zero validation errors');
  });

  test(`${a.req}: compile(claude-code) emits exactly one .md, byte-identical to committed ${a.name}.md`, (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit81-'));
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
    const SCANNERS = ['Semgrep', 'Gitleaks', 'Trivy'];
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
}

// Full-fleet byte-match: the compiled fleet count equals the number of
// committed gsd-*.md files (30 after all four Wave-1 auditors land). This is
// the shared byte-match invariant, asserted ONCE here in the final wave.
test('REGRESSION: full-fleet compile count matches committed agents/gsd-*.md (30 after Wave-1 lands)', () => {
  const r = compile('claude-code', { source: SOURCE_DIR });
  assert.equal(r.errors.length, 0, `full-fleet compile must produce 0 errors. Got: ${JSON.stringify(r.errors)}`);
  const committed = fs.readdirSync(AGENTS_OUT).filter((f) => /^gsd-.*\.md$/.test(f)).length;
  assert.equal(r.compiled.length, committed, `compiled fleet (${r.compiled.length}) must equal committed gsd-*.md count (${committed})`);
  assert.equal(committed, 30, 'the fleet is at 30 agents after Wave-1 (4 new domain auditors landed)');
});

// ===========================================================================
// DETECT-FIRES — each documented Detect is sound on a genuine violation.
// Pure detector functions (deterministic-before-behavioral) proven on seeded
// fixtures + the real in-repo seeds; clean controls prove no false positives.
// ===========================================================================

// ---- Detector implementations (mirror each rule's documented Detect) -------

// HARN-02: validator == claimer per task.
function detectValidatorEqualsClaimer(ledger) {
  return (ledger.tasks || [])
    .filter((t) => t.claim && t.validation && t.claim.agent && t.claim.agent === t.validation.agent)
    .map((t) => t.id);
}

// HARN-03: a manifest_violation flag with no matching divergence_report record.
function detectSilentManifestAbsorption(ledger, divergenceReportTaskIds) {
  const reported = new Set(divergenceReportTaskIds);
  return (ledger.tasks || [])
    .filter((t) => t.manifest_violation === true && !reported.has(t.id))
    .map((t) => t.id);
}

// BACK-05: each migrations/NNN-*.sql UP must have a non-empty NNN-*-DOWN.sql sibling.
function detectMigrationsMissingDown(dir) {
  const ups = fs.readdirSync(dir).filter((f) => /^\d.*\.sql$/.test(f) && !/-DOWN\.sql$/.test(f));
  const missing = [];
  for (const up of ups) {
    const down = up.replace(/\.sql$/, '-DOWN.sql');
    const p = path.join(dir, down);
    const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim().length > 0;
    if (!ok) missing.push(up);
  }
  return missing;
}

// BACK-06: a DB call (.query(/.execute() lexically inside a for/forEach/map loop body.
function detectDbCallInLoop(src) {
  const lines = src.split('\n');
  let depth = 0;             // current brace depth
  const loopDepths = [];     // brace depths at which a loop body is open
  let loopPending = false;   // saw a loop header, awaiting its '{'
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bfor\s*\(|\.forEach\s*\(|\.map\s*\(/.test(line)) loopPending = true;
    if (loopDepths.length > 0 && /\.(query|execute)\s*\(/.test(line)) hits.push(i + 1);
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (loopPending) { loopDepths.push(depth); loopPending = false; }
      } else if (ch === '}') {
        if (loopDepths.length && loopDepths[loopDepths.length - 1] === depth) loopDepths.pop();
        depth--;
      }
    }
  }
  return hits;
}

// INFRA-01: a compose `image:` value that is :latest, a bare tag, or a
// latest-* tag — NOT pinned by an exact version or @sha256 digest.
function detectUnpinnedImages(composeSrc) {
  const hits = [];
  for (const line of composeSrc.split('\n')) {
    const m = line.match(/^\s*image:\s*(\S+)/);
    if (!m) continue;
    const ref = m[1].replace(/['"]/g, '');
    if (ref.includes('@sha256:')) continue;           // digest-pinned → OK
    const afterSlash = ref.substring(ref.lastIndexOf('/') + 1);
    const tag = afterSlash.includes(':') ? afterSlash.split(':')[1] : null;
    if (!tag) { hits.push(ref); continue; }            // bare tag → unpinned
    if (/latest/.test(tag)) hits.push(ref);            // :latest / latest-* → unpinned
  }
  return hits;
}

// INFRA-03: a compose service with no `healthcheck:` key.
function detectServicesWithoutHealthcheck(composeSrc) {
  const lines = composeSrc.split('\n');
  let inServices = false;
  let current = null;
  const services = {};
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim()) { inServices = false; current = null; continue; } // top-level dedent
    const svc = line.match(/^ {2}([\w-]+):\s*$/);
    if (svc) { current = svc[1]; services[current] = []; continue; }
    if (current) services[current].push(line);
  }
  return Object.keys(services).filter((s) => !services[s].some((l) => /healthcheck:/.test(l)));
}

// MODL-01/06: an inline claude-<tier>-<date> literal (a pinned model id).
const MODEL_ID_RE = /claude-[a-z]+-[0-9]/;
function detectInlineModelId(src) {
  return MODEL_ID_RE.test(src);
}

// ---- SC1 — DOM1-01 HARNESS-SELF -------------------------------------------

test('DOM1-01 / SC1: HARN-02 detect fires on a seeded validator==claimer task and NOT on a clean control', () => {
  const ledger = {
    tasks: [
      { id: 'TK-DIRTY', claim: { agent: 'gsd-executor-backend' }, validation: { agent: 'gsd-executor-backend' } },
      { id: 'TK-CLEAN', claim: { agent: 'gsd-executor-backend' }, validation: { agent: 'gsd-validator' } },
    ],
  };
  const fired = detectValidatorEqualsClaimer(ledger);
  assert.deepEqual(fired, ['TK-DIRTY'], 'HARN-02 flags the validator==claimer task only');
  assert.equal(fired.includes('TK-CLEAN'), false, 'HARN-02 does NOT flag the externally-validated control');
  // The auditor documents HARN-02 with the claim.agent vs validation.agent detect.
  const hs = AUDITORS.find((a) => a.name === 'gsd-auditor-harness-self');
  assert.ok(hs.mdSrc.includes('HARN-02'), 'harness-self .md documents HARN-02');
  assert.match(hs.mdSrc, /claim\.agent[\s\S]{0,40}validation\.agent/, 'HARN-02 detect names claim.agent vs validation.agent');
});

test('DOM1-01 / SC1: HARN-03 detect fires on a seeded manifest_violation with no divergence_report and NOT on a reported one', () => {
  const ledger = {
    tasks: [
      { id: 'TK-SILENT', manifest_violation: true },
      { id: 'TK-REPORTED', manifest_violation: true },
      { id: 'TK-OK', manifest_violation: false },
    ],
  };
  // Only TK-REPORTED produced a divergence_report on disk.
  const fired = detectSilentManifestAbsorption(ledger, ['TK-REPORTED']);
  assert.deepEqual(fired, ['TK-SILENT'], 'HARN-03 flags the silently-absorbed manifest_violation only');
  const hs = AUDITORS.find((a) => a.name === 'gsd-auditor-harness-self');
  assert.ok(hs.mdSrc.includes('HARN-03'), 'harness-self .md documents HARN-03');
  assert.match(hs.mdSrc, /manifest_violation/, 'HARN-03 detect names manifest_violation');
  assert.match(hs.mdSrc, /divergence/i, 'HARN-03 detect names the divergence_report cross-ref');
});

// ---- SC2 — DOM1-02 BACKEND -------------------------------------------------

test('DOM1-02 / SC2: BACK-05 detect fires on a migration UP missing a non-empty DOWN and NOT on a clean pair', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig81-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  // Clean pair: 001 has a non-empty DOWN. Orphan: 002 has no DOWN sibling.
  fs.writeFileSync(path.join(dir, '001-users.sql'), 'CREATE TABLE users (id int);\n');
  fs.writeFileSync(path.join(dir, '001-users-DOWN.sql'), 'DROP TABLE users;\n');
  fs.writeFileSync(path.join(dir, '002-orders.sql'), 'CREATE TABLE orders (id int);\n');

  const missing = detectMigrationsMissingDown(dir);
  assert.deepEqual(missing, ['002-orders.sql'], 'BACK-05 flags the orphan UP with no DOWN sibling');
  assert.equal(missing.includes('001-users.sql'), false, 'BACK-05 does NOT flag the clean UP/DOWN pair');
  const be = AUDITORS.find((a) => a.name === 'gsd-auditor-backend');
  assert.ok(be.mdSrc.includes('BACK-05'), 'backend .md documents BACK-05');
  assert.match(be.mdSrc, /DOWN/, 'BACK-05 detect names the non-empty DOWN sibling');
});

test('DOM1-02 / SC2: BACK-06 detect fires on a DB call inside a loop and NOT on a loop-free query', () => {
  const n1Src = [
    'async function loadAll(ids) {',
    '  const out = [];',
    '  for (const id of ids) {',
    '    const row = await db.query("SELECT * FROM t WHERE id=$1", [id]);',
    '    out.push(row);',
    '  }',
    '  return out;',
    '}',
  ].join('\n');
  const cleanSrc = [
    'async function loadOne(id) {',
    '  const row = await db.query("SELECT * FROM t WHERE id=$1", [id]);',
    '  return row;',
    '}',
  ].join('\n');
  assert.deepEqual(detectDbCallInLoop(n1Src), [4], 'BACK-06 flags the query on line 4 inside the for loop');
  assert.deepEqual(detectDbCallInLoop(cleanSrc), [], 'BACK-06 does NOT flag a loop-free query (no N+1)');
  const be = AUDITORS.find((a) => a.name === 'gsd-auditor-backend');
  assert.ok(be.mdSrc.includes('BACK-06'), 'backend .md documents BACK-06');
  assert.match(be.mdSrc, /N\+1|loop/i, 'BACK-06 detect names the code-level N+1 / loop');
  // Anti-dup: BACK-08 parameterized-SQL is DEFERRED to gsd-security (cross-link).
  assert.ok(be.yamlSrc.includes('BACK-08'), 'backend documents BACK-08');
  const back08Row = be.tableRows.find((l) => l.includes('BACK-08') && !l.includes('BACK-DEFER'));
  assert.ok(back08Row && back08Row.includes('gsd-security'), 'BACK-08 parameterized-SQL row DEFERS to gsd-security');
});

// ---- SC3 — DOM1-03 INFRA ---------------------------------------------------

test('DOM1-03 / SC3: INFRA-01 detect fires on a seeded :latest image AND the REAL docker-compose paradedb:latest-pg16, NOT on a digest-pinned image', () => {
  const seeded = [
    'services:',
    '  web:',
    '    image: myorg/web:latest',
    '  db:',
    '    image: postgres:16.2@sha256:abc123',
  ].join('\n');
  const seededHits = detectUnpinnedImages(seeded);
  assert.ok(seededHits.includes('myorg/web:latest'), 'INFRA-01 flags the seeded :latest image');
  assert.equal(seededHits.some((h) => h.includes('@sha256:')), false, 'INFRA-01 does NOT flag the digest-pinned image');

  // Real in-repo seed — read-only.
  const realCompose = fs.readFileSync(path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf8');
  const realHits = detectUnpinnedImages(realCompose);
  assert.ok(
    realHits.some((h) => /paradedb\/paradedb:latest-pg16/.test(h)),
    'INFRA-01 fires on the REAL docker-compose paradedb/paradedb:latest-pg16 unpinned image'
  );
  const inf = AUDITORS.find((a) => a.name === 'gsd-auditor-infra');
  assert.ok(inf.mdSrc.includes('INFRA-01'), 'infra .md documents INFRA-01');
  assert.match(inf.mdSrc, /:latest|pinned/i, 'INFRA-01 detect names the :latest / pin discipline');
});

test('DOM1-03 / SC3: INFRA-03 detect fires on a compose service with no healthcheck and NOT on one with a healthcheck', () => {
  const seeded = [
    'services:',
    '  web:',
    '    image: myorg/web:1.0.0',
    '    ports:',
    '      - "8080:8080"',
    '  db:',
    '    image: postgres:16.2',
    '    healthcheck:',
    '      test: ["CMD", "pg_isready"]',
  ].join('\n');
  const missing = detectServicesWithoutHealthcheck(seeded);
  assert.deepEqual(missing, ['web'], 'INFRA-03 flags the healthcheck-less service only');
  assert.equal(missing.includes('db'), false, 'INFRA-03 does NOT flag the service that defines a healthcheck');
  const inf = AUDITORS.find((a) => a.name === 'gsd-auditor-infra');
  assert.ok(inf.mdSrc.includes('INFRA-03'), 'infra .md documents INFRA-03');
  assert.match(inf.mdSrc, /healthcheck/i, 'INFRA-03 detect names the healthcheck key');
  // Anti-dup: container-image CVEs (Trivy) DEFER to gsd-security on the same row.
  const cveRow = inf.tableRows.find((l) => l.includes('Trivy') && /CVE/i.test(l));
  assert.ok(cveRow && cveRow.includes('gsd-security'), 'INFRA container-CVE (Trivy) row DEFERS to gsd-security');
});

// ---- SC4 — DOM1-04 MODELS --------------------------------------------------

test('DOM1-04 / SC4: MODL-01/MODL-06 detect fires on the REAL memory_classifier.py + gsd-memory.cjs stale ids, NOT on config.json model_routing', () => {
  const classifierSrc = fs.readFileSync(path.join(ROOT, 'services', 'memory_classifier.py'), 'utf8');
  const memoryCjsSrc = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-memory.cjs'), 'utf8');
  const configSrc = fs.readFileSync(path.join(ROOT, '.planning', 'config.json'), 'utf8');

  assert.equal(detectInlineModelId(classifierSrc), true, 'MODL-01/06 fires on the REAL inline claude-* id in services/memory_classifier.py');
  assert.equal(detectInlineModelId(memoryCjsSrc), true, 'MODL-01/06 fires on the REAL inline claude-* id in get-shit-done/bin/gsd-memory.cjs');
  // Negative control: config.json model_routing uses tier names (sonnet/haiku),
  // NOT pinned claude-<tier>-<date> literals — the centralization target, not a violation.
  assert.equal(detectInlineModelId(configSrc), false, 'MODL-06 does NOT fire on .planning/config.json (centralized tier names, not inline ids)');

  const md = AUDITORS.find((a) => a.name === 'gsd-auditor-models');
  assert.ok(md.mdSrc.includes('MODL-01') && md.mdSrc.includes('MODL-06'), 'models .md documents MODL-01 + MODL-06');
  assert.match(md.mdSrc, /model_routing/, 'MODL-06 suggested_fix names config.json model_routing centralization');
  assert.match(md.mdSrc, /centraliz/i, 'MODL-06 prose names centralization');
  assert.ok(
    md.mdSrc.includes('memory_classifier.py') || md.mdSrc.includes('gsd-memory.cjs'),
    'models .md cites the concrete stale-id seed file(s)'
  );
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
    const filePath = `tests/.fixtures/81-01-${a.domain}-${Date.now()}.txt`;
    const finding = {
      agent_name: a.name,
      finding_type: 'audit',
      severity: 'warning',
      rule_id: ruleId,
      domain: a.domain,
      file_path: filePath,
      evidence: `${ruleId} seeded/real violation detected by ${a.name}`,
      suggested_fix: `Remediate per ${ruleId}; gated through the Phase-79 router`,
      content: 'w1 auditor emission smoke (81-01-05)',
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
