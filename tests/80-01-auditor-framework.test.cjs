'use strict';

// ============================================================================
// Phase 80 — Auditor Framework behavioral test (plan 80-01, task 80-01-03).
//
// Proves the 3 ROADMAP success criteria across AUDT-01..03 for the reference
// auditor (get-shit-done/agents/gsd-auditor-reference/AGENT.yaml +
// compiled agents/gsd-auditor-reference.md):
//
//   AUDT-01 / SC1  the reference auditor compiles via the agent-compiler —
//                  validate() ok:true, compile('claude-code') emits exactly one
//                  .md that is byte-identical to the committed output, and it
//                  registers by source-dir discovery (listAgents) with NO
//                  scripts/agent-compiler.cjs change.
//   AUDT-02 / SC2  the auditor is read-only (tools Read/Bash/Grep/Glob, NO
//                  Write/Edit) and files findings not fixes — the emission
//                  recipe (finding_type='audit' + metadata) is present in-agent
//                  and the compiled .md carries the "scan and report — never
//                  fix" boundary; a live-substrate round-trip (POST → sweep →
//                  PATCH) proves a read-only agent CAN file a finding.
//   AUDT-03 / SC3  the locked-rules table cross-links (Owns/Overlap) all four
//                  of gsd-security/gsd-reviewer/gsd-qa/gsd-architect and does
//                  NOT duplicate their owned scans — deferred-domain tokens
//                  (Semgrep/Gitleaks/mutation/ratchet) co-occur only with their
//                  owning agent on the same rule row (a cross-link, not a
//                  re-implementation), and the one OWNED rule (REF-01) is a
//                  genuinely-unowned demonstrative check.
//
// Two layers:
//   ALWAYS-RUN — require {validate,compile,listAgents} from the compiler +
//                source-analyze the committed artifacts. No daemon/PG needed.
//   LIVE-DAEMON — skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799}
//                is unreachable; POSTs the auditor's exact finding shape, sweeps
//                for it (SUBS-04), then PATCHes it cleared (leaves the substrate
//                clean). The hyphenated daemon starts servers at import, so it
//                is hit over HTTP / source-analyzed as text, never required.
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
const AGENT_NAME = 'gsd-auditor-reference';
const AGENT_DIR = path.join(SOURCE_DIR, AGENT_NAME);
const AGENT_YAML = path.join(AGENT_DIR, 'AGENT.yaml');
const COMPILED_MD = path.join(ROOT, 'agents', `${AGENT_NAME}.md`);

const { validate, compile, listAgents } = require(COMPILER);

// Source of the artifacts under test — read once, source-analyzed below.
const YAML_SRC = fs.readFileSync(AGENT_YAML, 'utf8');
const MD_SRC = fs.readFileSync(COMPILED_MD, 'utf8');

// The AGENT.yaml frontmatter is everything before the `sections:` block — the
// tools list lives here, distinct from any `Write`/`Edit` prose in a section.
const FRONTMATTER = YAML_SRC.slice(0, YAML_SRC.indexOf('sections:'));

// ===========================================================================
// AUDT-01 / SC1 — compiles + registers via the agent-compiler (always-run)
// ===========================================================================

test('AUDT-01: validate(gsd-auditor-reference) → ok:true with zero errors', () => {
  const r = validate(AGENT_DIR);
  assert.equal(r.ok, true, `validate must pass; errors: ${JSON.stringify(r.errors)}`);
  assert.equal(r.errors.length, 0, 'zero validation errors');
});

test('AUDT-01: compile(claude-code) emits exactly one .md, byte-identical to the committed agents/gsd-auditor-reference.md', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit80-'));
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

  const r = compile('claude-code', { source: SOURCE_DIR, agent: AGENT_NAME, outDir: tmpDir });
  assert.equal(r.errors.length, 0, `compile must produce 0 errors. Got: ${JSON.stringify(r.errors)}`);
  assert.equal(r.compiled.length, 1, `compile must emit exactly 1 agent. Got: ${r.compiled.length}`);

  const fresh = fs.readFileSync(path.join(tmpDir, `${AGENT_NAME}.md`), 'utf8');
  assert.equal(
    fresh, MD_SRC,
    'the freshly-compiled .md must be byte-identical to the committed agents/gsd-auditor-reference.md (byte-lock)'
  );
});

test('AUDT-01: the auditor registers via source-dir discovery — listAgents() includes it, with NO agent-compiler.cjs edit', () => {
  const names = listAgents(SOURCE_DIR).map((a) => a.name);
  assert.ok(names.includes(AGENT_NAME), 'gsd-auditor-reference is auto-discovered by listAgents()');
  // Registration is additive: scripts/agent-compiler.cjs is NOT in this plan's
  // files_modified. Assert the compiler carries no hardcoded reference to the
  // auditor name — it discovers it purely by scanning the source dir.
  const compilerSrc = fs.readFileSync(COMPILER, 'utf8');
  assert.equal(
    compilerSrc.includes(AGENT_NAME), false,
    'the compiler must NOT hardcode the auditor — registration is discovery-only (no compiler edit)'
  );
});

// ===========================================================================
// AUDT-02 / SC2 — read-only, files findings not fixes (source-analysis)
// ===========================================================================

test('AUDT-02: frontmatter tools = Read/Bash/Grep/Glob and contains NO Write or Edit (read-only, cannot patch)', () => {
  for (const tool of ['Read', 'Bash', 'Grep', 'Glob']) {
    assert.match(FRONTMATTER, new RegExp(`^\\s+- ${tool}\\s*$`, 'm'), `tools list includes ${tool}`);
  }
  assert.equal(/^\s+- Write\s*$/m.test(FRONTMATTER), false, 'read-only violation: Write tool present in frontmatter');
  assert.equal(/^\s+- Edit\s*$/m.test(FRONTMATTER), false, 'read-only violation: Edit tool present in frontmatter');
  // Compiled .md frontmatter (inline list form) must also exclude Write/Edit.
  const mdFm = MD_SRC.slice(0, MD_SRC.indexOf('# Agent:'));
  assert.match(mdFm, /tools:\s*Read,\s*Bash,\s*Grep,\s*Glob/, 'compiled frontmatter tools = Read, Bash, Grep, Glob');
  assert.equal(/tools:.*\b(Write|Edit)\b/.test(mdFm), false, 'compiled frontmatter must not list Write/Edit');
});

test('AUDT-02: the auditor carries the POST /api/findings emission recipe (finding_type=audit + metadata fields)', () => {
  assert.ok(YAML_SRC.includes('/api/findings'), 'emission endpoint present');
  assert.match(YAML_SRC, /finding_type.{0,4}audit/, "finding_type='audit' present");
  for (const field of ['rule_id', 'file_path', 'evidence', 'suggested_fix', 'severity']) {
    assert.ok(YAML_SRC.includes(field), `emission metadata field '${field}' present`);
  }
});

test('AUDT-02: the compiled .md carries the "scan and report — never fix" read-only boundary', () => {
  assert.match(MD_SRC, /scan and report/i, 'the scan/report boundary is stated');
  assert.match(MD_SRC, /never fix|do not fix/i, 'the never-fix boundary is stated');
});

// ===========================================================================
// AUDT-03 / SC3 — cross-link, not duplicate (source-analysis)
// ===========================================================================

test('AUDT-03: the locked-rules table has an Owns/Overlap column cross-linking all four review agents', () => {
  assert.ok(YAML_SRC.includes('Owns/Overlap'), 'Owns/Overlap column header present');
  for (const agent of ['gsd-security', 'gsd-reviewer', 'gsd-qa', 'gsd-architect']) {
    assert.ok(YAML_SRC.includes(agent), `cross-links ${agent}`);
  }
});

test('AUDT-03: deferred-domain scans co-occur with their OWNING agent on the same rule row — cross-link, not re-implementation', () => {
  // Each owned-scan token must appear ONLY on a table row that also names its
  // owning agent (a DEFER cross-link). If the token appeared without the owner
  // on its line, the auditor would be re-running an owned scan (duplication).
  const OWNED_TOKENS = [
    { token: 'Semgrep', owner: 'gsd-security' },
    { token: 'Gitleaks', owner: 'gsd-security' },
    { token: 'mutation', owner: 'gsd-qa' },
    { token: 'ratchet', owner: 'gsd-qa' },
  ];
  const lines = YAML_SRC.split('\n');
  for (const { token, owner } of OWNED_TOKENS) {
    const hits = lines.filter((l) => l.includes(token));
    assert.ok(hits.length >= 1, `deferred token '${token}' is present`);
    for (const line of hits) {
      assert.ok(
        line.includes(owner),
        `'${token}' must co-occur with its owner '${owner}' on the same rule row (cross-link, not a re-scan): ${line.trim()}`
      );
    }
  }
});

test('AUDT-03: the one OWNED rule (REF-01) is genuinely unowned — marked "New", no existing agent covers it', () => {
  const ref01 = YAML_SRC.split('\n').find((l) => l.trim().startsWith('| REF-01'));
  assert.ok(ref01, 'REF-01 owned rule row is present');
  assert.match(ref01, /New/, 'REF-01 is marked as a New (unowned) check');
  // The owned rule must NOT defer to an existing agent (it is the one this
  // auditor genuinely owns).
  assert.equal(
    /gsd-(security|reviewer|qa|architect)/.test(ref01), false,
    'the owned REF-01 rule cross-links no existing agent — it is genuinely unowned'
  );
});

// ===========================================================================
// LIVE-DAEMON — POST → sweep → PATCH round-trip (skip when daemon unreachable)
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

test('LIVE AUDT-02: the auditor\'s exact finding shape POSTs to /api/findings, lands in the SUBS-04 sweep, then PATCHes cleared', async (t) => {
  if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }

  // A unique file_path keeps the server dedup_key (rule_id:sha1(file_path))
  // distinct so the POST creates rather than dedups.
  const filePath = `tests/.fixtures/80-01-seed-${Date.now()}.txt`;
  const finding = {
    agent_name: AGENT_NAME,
    finding_type: 'audit',
    severity: 'warning',
    rule_id: 'REF-01',
    domain: 'harness-self',
    file_path: filePath,
    evidence: 'tools: Read, Write  # claims read-only but lists Write',
    suggested_fix: 'Remove Write/Edit from a read-only reporter tools list',
    content: 'reference auditor emission smoke (80-01-03)',
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
  const mine = sweep.json.findings.find((f) => f.file_path === filePath && f.rule_id === 'REF-01');
  assert.ok(mine, 'the posted audit finding is present in the open-audit sweep');
  assert.equal(mine.finding_type, 'audit', 'the swept finding is an audit finding');

  // PATCH — close-loop cleanup; leaves the substrate clean.
  const cleared = await httpJson('PATCH', `/api/findings/${id}`, { status: 'cleared' });
  assert.equal(cleared.status, 200, 'PATCH succeeds');
  assert.equal(cleared.json.status, 'cleared', 'finding transitioned to cleared (substrate left clean)');
});
