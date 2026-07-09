'use strict';

// ============================================================================
// Phase 79 — Remediation Router behavioral test (plan 79-01, task 79-01-05).
//
// Covers the 4 ROADMAP success criteria across ROUT-01..ROUT-05:
//   ROUT-01  findings-to-plan synthesizes a PLAN.md that passes the FIDEL
//            gates (_validatePlanShape: concrete files_expected, no glob) and
//            is designed for plan-to-tasks — never raw `amauta add task`.
//   ROUT-02  config-driven routeFindings table (fix-task | phase | milestone),
//            thresholds read from .planning/config.json audit.routing.
//   ROUT-03  GUARDRAIL: phase/milestone routes emit auto_executed:false
//            proposals and NOTHING is auto-created — the router contains ZERO
//            phase/milestone spawn (behavioral + source-analysis).
//   ROUT-04  route-time dedup — a finding already carried by an open task's
//            finding:<dedup_key> tag is skipped.
//   ROUT-05  close-loop — cleared path clears; still-present reopens + emits a
//            validator/finding divergence.
//
// Two layers:
//   ALWAYS-RUN — require the exported pure functions + spawn the CLI against
//                temp --findings-file/--tasks-file/--reaudit-file fixtures. The
//                spawned CLI is pointed at a CLOSED port (AMAUTA_PORT/GSD_RLM_PORT
//                = 1) so it is hermetic: it never reaches — nor mutates — the
//                real daemon/store/index regardless of what is running locally.
//   LIVE-DAEMON — skipped when GET /health on 127.0.0.1:${AMAUTA_PORT||18799}
//                is unreachable; exercises the daemon operator-gate + the
//                PATCH /api/findings/<id> status route.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');

const toolsPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-tools.cjs');
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, '.planning', 'config.json');
const daemonPath = path.join(repoRoot, 'services', 'amauta-daemon.py');

const {
  routeFindings,
  synthesizeFixPlan,
  _validatePlanShape,
  readAuditRouting,
} = require(toolsPath);

// ── fixture scratch dir (temp — never the real store) ──────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rout79-'));
function writeFixture(name, obj) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
  return p;
}

// Spawn the gsd-tools CLI HERMETICALLY: closed ports so no live daemon/index is
// touched. Best-effort daemon POSTs inside the verbs resolve on ECONNREFUSED.
function runTool(argv) {
  return spawnSync(process.execPath, [toolsPath, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, AMAUTA_PORT: '1', GSD_RLM_PORT: '1' },
  });
}

// Parse the JSON objects a verb prints (one per line); tolerate the PLAN.md XML
// that fix-task routes also emit on stdout.
function jsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

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
      { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 2000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
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

// Threshold snapshot the router reads (config-driven — asserted in ROUT-02).
const ROUTING = readAuditRouting(repoRoot);

// ===========================================================================
// ROUT-02 — config-driven routing table (always-run, pure)
// ===========================================================================

test('ROUT-02: thresholds are READ from .planning/config.json audit.routing (not hardcoded)', () => {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.ok(cfg.audit && cfg.audit.routing, 'audit.routing block present in config');
  assert.equal(cfg.audit.routing.phase_count, 8);
  assert.equal(cfg.audit.routing.phase_blockers, 3);
  assert.equal(cfg.audit.routing.milestone_domains, 3);
  assert.equal(cfg.audit.routing.milestone_critical_arch, true);
  // readAuditRouting surfaces the same values the router uses.
  assert.equal(ROUTING.phase_count, 8);
  assert.equal(ROUTING.milestone_domains, 3);
});

test('ROUT-02: a single critical + architectural finding routes to milestone', () => {
  const r = routeFindings(
    [{ severity: 'critical', domain: 'arch', finding_type: 'audit', file_path: 'a.py', dedup_key: 'R:1', id: '1' }],
    ROUTING
  );
  assert.equal(r.milestoneProposals.length, 1);
  assert.equal(r.phaseProposals.length, 0);
  assert.equal(r.fixTasks.length, 0);
  assert.ok(r.milestoneProposals[0].finding_ids.includes('1'));
});

test('ROUT-02: findings spanning >=3 domains each over threshold route to milestone', () => {
  // 3 non-arch domains, 3 critical (=blocker) findings each → each domain over
  // phase_blockers(3) → 3 domains over → milestone_domains(3) satisfied.
  const findings = [];
  for (const d of ['backend', 'frontend', 'infra']) {
    for (let i = 0; i < 3; i++) {
      findings.push({ severity: 'critical', domain: d, finding_type: 'audit', file_path: `${d}${i}.py`, dedup_key: `R:${d}:${i}`, id: `${d}${i}` });
    }
  }
  const r = routeFindings(findings, ROUTING);
  assert.equal(r.milestoneProposals.length, 1, 'one milestone proposal spanning the domains');
  assert.equal(r.phaseProposals.length, 0, 'domains consumed by the milestone, not re-proposed as phases');
});

test('ROUT-02: phase_count boundary — 7 in-domain → fix-task, 8 in-domain → phase', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ severity: 'warning', domain: 'backend', finding_type: 'audit', file_path: `b${i}.py`, dedup_key: `R:${i}`, id: `${i}` }));
  const seven = routeFindings(mk(7), ROUTING);
  assert.equal(seven.phaseProposals.length, 0, '7 below phase_count → no phase');
  assert.equal(seven.fixTasks.length, 7, '7 warnings fall through to fix-task');
  const eight = routeFindings(mk(8), ROUTING);
  assert.equal(eight.phaseProposals.length, 1, '8 at phase_count → phase');
  assert.equal(eight.fixTasks.length, 0, 'phase consumes the domain');
});

test('ROUT-02: phase_blockers boundary — 2 blockers → fix-task, 3 blockers → phase', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ severity: 'critical', domain: 'backend', finding_type: 'audit', file_path: `c${i}.py`, dedup_key: `R:${i}`, id: `${i}` }));
  const two = routeFindings(mk(2), ROUTING);
  assert.equal(two.phaseProposals.length, 0, '2 blockers below phase_blockers → no phase');
  assert.equal(two.milestoneProposals.length, 0, 'single domain → no milestone');
  assert.equal(two.fixTasks.length, 2, 'critical falls through to fix-task');
  const three = routeFindings(mk(3), ROUTING);
  assert.equal(three.phaseProposals.length, 1, '3 blockers at phase_blockers → phase');
});

test('ROUT-02: lone error → fix-task; info → backlog (no ticket)', () => {
  const r = routeFindings(
    [
      { severity: 'error', domain: 'backend', finding_type: 'audit', file_path: 'e.py', dedup_key: 'R:e', id: 'e' },
      { severity: 'info', domain: 'backend', finding_type: 'audit', file_path: 'i.py', dedup_key: 'R:i', id: 'i' },
    ],
    ROUTING
  );
  assert.equal(r.fixTasks.length, 1);
  assert.equal(r.fixTasks[0].id, 'e');
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backlog[0].id, 'i');
  assert.equal(r.phaseProposals.length, 0);
  assert.equal(r.milestoneProposals.length, 0);
});

// ===========================================================================
// ROUT-01 — findings→plan feeds the FIDEL-gated plan-to-tasks path (always-run)
// ===========================================================================

test('ROUT-01: synthesizeFixPlan emits a PLAN.md that passes _validatePlanShape (concrete files_expected, no glob)', () => {
  const plan = synthesizeFixPlan(
    [{ severity: 'error', domain: 'backend', file_path: 'services/x.py', suggested_fix: 'fix it', dedup_key: 'N+1:abc', id: 'u1' }],
    {}
  );
  assert.ok(plan.includes('<story>'), 'has a <story> block');
  assert.ok(plan.includes('<task'), 'has a <task> block');
  assert.ok(plan.includes('services/x.py'), 'files_expected carries the concrete finding path');
  assert.ok(plan.includes('finding:N+1:abc'), 'stamps the finding:<dedup_key> tag for ROUT-04 dedup');

  const v = _validatePlanShape(plan);
  assert.equal(v.valid, true, 'plan-to-tasks would accept it — FIDEL shape gates green');
  const feErrors = (v.errors || []).filter((e) => e && e.code && String(e.code).includes('files_expected'));
  assert.equal(feErrors.length, 0, 'no over_broad_files_expected / missing_files_expected');
});

// ===========================================================================
// ROUT-03 — operator-gating GUARDRAIL (behavioral + source-analysis)
// ===========================================================================

test('ROUT-03: findings-to-plan surfaces a milestone route as auto_executed:false + finding ids/severities', () => {
  const findingsFile = writeFixture('ms-findings.json', [
    { severity: 'critical', domain: 'arch', finding_type: 'audit', file_path: 'core/x.py', dedup_key: 'ARCH:1', id: 'm1' },
  ]);
  const tasksFile = writeFixture('empty-tasks.json', { items: [] });
  const res = runTool(['findings-to-plan', '--findings-file', findingsFile, '--tasks-file', tasksFile]);
  assert.equal(res.status, 0, `findings-to-plan exits 0 (stderr: ${res.stderr})`);
  const objs = jsonLines(res.stdout);
  const proposal = objs.find((o) => o.route === 'milestone');
  assert.ok(proposal, 'a milestone proposal is printed');
  assert.equal(proposal.auto_executed, false, 'GUARDRAIL: proposal is NOT auto-executed');
  assert.ok(proposal.finding_ids.includes('m1'), 'proposal carries the finding ids');
  assert.ok(proposal.severities.includes('critical'), 'proposal carries the severities');
  // And NOTHING was auto-created: the summary reports zero fix-tasks for the milestone set.
  const summary = objs.find((o) => 'milestone_proposals' in o);
  assert.ok(summary, 'a routing summary is printed');
  assert.equal(summary.milestone_proposals, 1);
  assert.equal(summary.fix_tasks, 0);
});

test('ROUT-03: source-analysis — the findings-to-plan→audit-close-loop segment contains ZERO phase/milestone spawn', () => {
  const src = fs.readFileSync(toolsPath, 'utf-8');
  const i = src.indexOf("case 'findings-to-plan'");
  const j = src.indexOf("case 'reindex'"); // the verb after audit-close-loop
  assert.ok(i > 0 && j > i, 'router segment is locatable');
  const seg = src.slice(i, j);
  assert.ok(seg.includes('auto_executed'), 'the segment marks proposals auto_executed');
  assert.equal(/cmdPhaseAdd|new-milestone|newMilestone|\bphase add\b/.test(seg), false,
    'the router NEVER spawns a phase or milestone — proposals are surfaced, never executed');
});

// ===========================================================================
// ROUT-04 — route-time dedup against an open task's finding:<key> tag
// ===========================================================================

test('ROUT-04: a finding already carried by an open task finding:<dedup_key> tag is skipped', () => {
  const findingsFile = writeFixture('dedup-findings.json', [
    { severity: 'error', domain: 'backend', finding_type: 'audit', file_path: 'services/y.py', dedup_key: 'N+1:abc', id: 'd1' },
  ]);
  const tasksFile = writeFixture('open-tagged-tasks.json', {
    items: [{ id: 'TK-1', status: 'in_progress', tags: ['finding:N+1:abc'] }],
  });
  const res = runTool(['findings-to-plan', '--findings-file', findingsFile, '--tasks-file', tasksFile]);
  assert.equal(res.status, 0, `exits 0 (stderr: ${res.stderr})`);
  const objs = jsonLines(res.stdout);
  const summary = objs.find((o) => 'deduped' in o);
  assert.ok(summary, 'a routing summary is printed');
  assert.ok(summary.deduped >= 1, 'the tagged finding is counted as deduped');
  assert.equal(summary.fix_tasks, 0, 'no fix-task synthesized for the already-ticketed finding');
  // The synthesized PLAN.md (if any) must NOT reference the deduped path.
  assert.equal(res.stdout.includes('services/y.py'), false, 'deduped finding is absent from the plan');
});

test('ROUT-04: the SAME finding with NO open task tag IS synthesized (dedup is tag-precise, not blanket)', () => {
  const findingsFile = writeFixture('nodedup-findings.json', [
    { severity: 'error', domain: 'backend', finding_type: 'audit', file_path: 'services/z.py', dedup_key: 'N+1:zzz', id: 'z1' },
  ]);
  const tasksFile = writeFixture('empty-tasks2.json', { items: [] });
  const res = runTool(['findings-to-plan', '--findings-file', findingsFile, '--tasks-file', tasksFile]);
  assert.equal(res.status, 0);
  const summary = jsonLines(res.stdout).find((o) => 'deduped' in o);
  assert.equal(summary.deduped, 0, 'nothing deduped when no matching tag');
  assert.equal(summary.fix_tasks, 1, 'the finding is synthesized into a fix-task');
  assert.ok(res.stdout.includes('services/z.py'), 'plan references the finding path');
});

// ===========================================================================
// ROUT-05 — close-loop: cleared vs reopen+divergence vs no-op (always-run)
// ===========================================================================

test('ROUT-05: audit-close-loop on an untagged task is a no-op (skipped / no_finding_tag)', () => {
  const tasksFile = writeFixture('untagged-tasks.json', {
    items: [{ id: 'TK-NOFIND', status: 'in_progress', tags: ['plan:x', 'task:TK-NOFIND'] }],
  });
  const reauditFile = writeFixture('reaudit-empty.json', { findings: [] });
  const res = runTool(['audit-close-loop', 'TK-NOFIND', '--tasks-file', tasksFile, '--reaudit-file', reauditFile]);
  assert.equal(res.status, 0, 'no-op exits 0');
  const out = jsonLines(res.stdout).find((o) => o.skipped || o.reason);
  assert.ok(out, 'prints a skip object');
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'no_finding_tag');
});

test('ROUT-05: audit-close-loop with an EMPTY re-audit clears the finding', () => {
  const tasksFile = writeFixture('tagged-tasks.json', {
    items: [{ id: 'TK-CLR', status: 'in_progress', tags: ['finding:RULE-A:deadbeef01'] }],
  });
  const reauditFile = writeFixture('reaudit-clear.json', { findings: [] });
  // No --finding-id → the cleared path attempts no live PATCH → hermetic + exit 0.
  const res = runTool(['audit-close-loop', 'TK-CLR', '--tasks-file', tasksFile, '--reaudit-file', reauditFile]);
  const out = jsonLines(res.stdout).find((o) => 'cleared' in o);
  assert.ok(out, 'prints a cleared object');
  assert.equal(out.cleared, true, 'defect gone → finding cleared');
  assert.equal(out.rule_id, 'RULE-A', 'rule_id derived from the finding tag');
});

test('ROUT-05: audit-close-loop with a STILL-PRESENT re-audit reopens + emits a validator/finding divergence', () => {
  const tasksFile = writeFixture('tagged-tasks2.json', {
    items: [{ id: 'TK-REOPEN', status: 'in_progress', tags: ['finding:RULE-B:cafebabe02'] }],
  });
  // Re-audit row carries NO id → no live PATCH attempted → hermetic; still reopens.
  const reauditFile = writeFixture('reaudit-present.json', {
    findings: [{ rule_id: 'RULE-B', file_path: 'services/still.py' }],
  });
  const res = runTool(['audit-close-loop', 'TK-REOPEN', '--tasks-file', tasksFile, '--reaudit-file', reauditFile]);
  assert.equal(res.status, 1, 'green-validator + persistent-defect is a NON-ZERO condition — surface, never absorb');
  const out = jsonLines(res.stdout).find((o) => o.reopened);
  assert.ok(out, 'prints a reopened object');
  assert.equal(out.reopened, true);
  assert.equal(out.divergence, true);
  assert.ok(/validator\/finding divergence/.test(out.content), 'carries the divergence message text');
  assert.ok(/validator\/finding divergence/.test(res.stderr), 'divergence surfaced on stderr too');
});

// ===========================================================================
// DAEMON source-analysis (always-run, as TEXT — the hyphenated daemon starts
// servers at import, so it is analyzed as a string, never required)
// ===========================================================================

test('ROUT-05 (store half): daemon PATCH /api/findings/<id> route exists with a parameterized status UPDATE', () => {
  const src = fs.readFileSync(daemonPath, 'utf-8');
  assert.ok(src.includes('if path.startswith("/api/findings/"):'), 'PATCH branch on /api/findings/<id>');
  assert.ok(src.includes('_VALID_FINDING_STATUSES = {"open", "ticketed", "fixed", "cleared", "wontfix"}'),
    'status vocabulary includes cleared');
  assert.ok(src.includes('UPDATE agent_findings SET'), 'parameterized UPDATE against agent_findings');
  assert.ok(src.includes('WHERE id = %s RETURNING id, status, ticket_id'), 'binds id as a %s param');
  assert.ok(src.includes('"error": "finding not found"'), '404 on an absent finding id');
});

// ===========================================================================
// LIVE-DAEMON — skipped when the daemon/PG is unreachable
// ===========================================================================

test('LIVE ROUT-03: POST /api/messages ASK_QUESTION is operator-gated (pending, not auto-approved)', async (t) => {
  if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }
  const res = await httpJson('POST', '/api/messages', {
    from_agent: 'remediation-router',
    to_agent: 'operator',
    task_id: 'test-79-01-05',
    message_type: 'ASK_QUESTION',
    content: 'test: audit routing proposes a milestone (operator approval required)',
  });
  assert.equal(res.status, 201, 'message created');
  assert.equal(res.json.status, 'pending', 'ASK_QUESTION is NOT auto-approved — it waits for the operator');
  assert.equal(res.json.operator_approved, false, 'operator gate is closed until approval');
});

test('LIVE ROUT-05: POST /api/findings then PATCH /api/findings/<id> {status:cleared} transitions; bogus id → 404', async (t) => {
  if (!(await daemonReachable())) { t.skip('daemon unreachable on 127.0.0.1:' + PORT); return; }
  const created = await httpJson('POST', '/api/findings', {
    agent_name: 'test-79-01-05',
    finding_type: 'audit',
    content: 'test finding for close-loop PATCH',
    severity: 'warning',
    rule_id: 'TEST-ROUT05',
    domain: 'backend',
    file_path: `tests/_rout05_${Date.now()}.py`,
  });
  assert.equal(created.status, 201, 'finding created');
  const id = created.json.id;
  assert.ok(id, 'a finding id was returned');

  const patched = await httpJson('PATCH', `/api/findings/${id}`, { status: 'cleared' });
  assert.equal(patched.status, 200, 'PATCH succeeds');
  assert.equal(patched.json.status, 'cleared', 'status transitioned to cleared');

  const bogus = await httpJson('PATCH', '/api/findings/00000000-0000-0000-0000-000000000000', { status: 'cleared' });
  assert.equal(bogus.status, 404, 'a non-existent finding id returns 404');
});
