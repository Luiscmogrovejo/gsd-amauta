#!/usr/bin/env node
/**
 * TK-2384 / ROUTE-CONTRACT — route-executor answers with evidence, and its table
 * does not drift from the agent definitions it encodes.
 *
 * The five probes are the changed files of five MERGED PRs whose tasks were
 * claimed by a named specialist. They are recorded here verbatim (measured
 * 2026-09-14 via `gh api repos/<repo>/pulls/<n>/files`), so the expectation is a
 * fact about work that shipped, not an opinion about routing:
 *
 *   TK-2374  BareRouter/backend-core#41  claimed by executor-backend
 *   TK-2375  BareRouter/website#53       claimed by executor-frontend
 *   TK-2376  BareRouter/backend-core#40  claimed by executor-infra   <- missed before this change
 *   TK-2382  BareRouter/website#56       claimed by executor-frontend
 *   TK-2390  BareRouter/agent-core#38    claimed by executor-infra
 *
 * Both directions are asserted, as the brief requires: the five probes reach the
 * specialist that claimed them AND a control set of generic artefacts still
 * reaches executor-general. A rule that routed everything to a specialist would
 * pass the first half and fail the second.
 *
 * ARMING: test 1 proves the harness can see a routing answer at all before any
 * verdict is believed. If gsd-tools cannot be executed, every other assertion in
 * this file would pass vacuously in a `grep FAILED` reading of the output.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CAPS_PATH = path.join(ROOT, 'get-shit-done', 'agent-capabilities.json');
const INFRA_AGENT_MD = path.join(ROOT, 'agents', 'gsd-executor-infra.md');

/** Run route-executor and return the parsed JSON object (stderr discarded). */
function routeFull(arg) {
  const out = execFileSync(process.execPath, [TOOLS, 'route-executor', arg], {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

/** Run route-executor and return only the executor string. */
const route = (arg) => routeFull(arg).executor;

const PROBES = [
  {
    task: 'TK-2374', pr: 'backend-core#41', expected: 'executor-backend',
    files: [
      'src/main/python/cloud_domain/__init__.py',
      'src/main/python/cloud_domain/aws.py',
      'src/main/python/cloud_domain/errors.py',
      'src/main/python/cloud_domain/floci.py',
      'src/main/python/cloud_domain/provider.py',
      'tests/test_cloud_provider_floci.py',
      'tests/test_cloud_provider_port.py',
    ],
  },
  {
    task: 'TK-2375', pr: 'website#53', expected: 'executor-frontend',
    files: [
      'src/components/console/controlPlaneFault.tsx',
      'src/content/studio.ts',
      'src/lib/controlPlane.ts',
      'src/lib/session.test.ts',
      'src/lib/session.ts',
      'src/routeTree.gen.ts',
      'src/routes/-guards.test.ts',
      'src/routes/_app/route.tsx',
      'src/routes/api/agents.$agentId.events.tsx',
      'src/routes/login.tsx',
      'src/server/agents.test.ts',
      'src/server/agents.ts',
      'src/server/session.server.ts',
      'src/server/session.ts',
    ],
  },
  {
    task: 'TK-2376', pr: 'backend-core#40', expected: 'executor-infra',
    files: [
      'docs/PROJECT-SETUP.md',
      'docs/PROVISIONING.md',
      'scripts/verify-provisioning.sh',
    ],
  },
  {
    task: 'TK-2382', pr: 'website#56', expected: 'executor-frontend',
    files: [
      'src/components/console/FirstRun.tsx',
      'src/components/console/Sidebar.tsx',
      'src/lib/controlPlane.ts',
      'src/lib/firstRun.test.ts',
      'src/lib/firstRun.ts',
      'src/routes/-firstRun.test.ts',
      'src/routes/_app/overview.tsx',
      'src/server/firstRun.test.ts',
      'src/server/firstRun.ts',
      'src/store/firstRun.test.ts',
      'src/store/firstRun.ts',
    ],
  },
  {
    task: 'TK-2390', pr: 'agent-core#38', expected: 'executor-infra',
    files: [
      '.github/workflows/ci.yml',
      'Dockerfile',
      'Dockerfile.applier',
      'Dockerfile.runtime',
      'docs/E2E.md',
      'scripts/join-node-g.sh',
      'scripts/k8s/applier/10-deployment.yaml',
      'tests/test_applier_entrypoint.py',
      'tests/test_join_node_g_secret.py',
    ],
  },
];

describe('ROUTE-CONTRACT-00: arming', () => {
  it('1. the harness can obtain a routing answer at all', () => {
    const r = routeFull('src/App.tsx');
    assert.equal(typeof r.executor, 'string', 'route-executor returned no executor field');
    assert.equal(r.executor, 'executor-frontend', 'the simplest possible probe already disagrees — every verdict below is unreadable');
  });
});

describe('ROUTE-CONTRACT-01: the five closed tasks reach the specialist that claimed them', () => {
  for (const p of PROBES) {
    it(`${p.task} (${p.pr}) -> ${p.expected}`, () => {
      const got = routeFull(p.files.join(','));
      assert.equal(got.executor, p.expected,
        `${p.task}: expected ${p.expected}, got ${got.executor} (${got.reason})`);
      assert.equal(got.input_kind, 'file-list');
    });
  }
});

describe('ROUTE-CONTRACT-02: the other direction — generic artefacts stay with executor-general', () => {
  const CONTROL = [
    'README.md',
    'LICENSE',
    '.gitignore',
    '.env',
    'notes.txt,TODO.txt',
    'package.json',
    '.planning/ROADMAP.md,.planning/STATE.md',
    'CHANGELOG.md,docs/adr/0001-decision.md',
  ];
  for (const c of CONTROL) {
    it(`${c} -> executor-general`, () => {
      assert.equal(route(c), 'executor-general');
    });
  }
  it('and it says so as a fallback, not as a match', () => {
    const r = routeFull('README.md');
    assert.equal(r.matched_agent, null);
    assert.equal(r.matched_pattern, null);
    assert.match(r.reason, /fallback, not a specialist match/);
  });
});

describe('ROUTE-CONTRACT-03: the argument is a FILE LIST, and the CLI says when it is not', () => {
  it('a task description is reported as not-a-file-list, not silently routed', () => {
    const r = routeFull("Pedro's provisioning debt — barerouter_memory migration, 7002 roles");
    assert.equal(r.executor, 'executor-general');
    assert.equal(r.input_kind, 'not-a-file-list');
    assert.match(r.reason, /FILE LIST/);
  });
  it('an empty argument is reported as empty, not as "no specialist matched"', () => {
    const r = routeFull('');
    assert.equal(r.executor, 'executor-general');
    assert.equal(r.input_kind, 'empty');
    assert.match(r.reason, /empty file list/);
  });
  it('a real file list is reported as file-list', () => {
    assert.equal(routeFull('services/api.py').input_kind, 'file-list');
  });
  it('the warning goes to stderr so stdout stays machine-readable', () => {
    const res = require('node:child_process').spawnSync(
      process.execPath, [TOOLS, 'route-executor', 'fix the auth boundary'],
      { encoding: 'utf-8', timeout: 15000 });
    assert.doesNotThrow(() => JSON.parse(res.stdout.trim()), 'stdout must stay parseable JSON');
    assert.match(res.stderr, /not a file list/);
  });
});

describe('ROUTE-CONTRACT-04: the table does not drift from the agent definitions', () => {
  const caps = JSON.parse(fs.readFileSync(CAPS_PATH, 'utf-8'));

  it('executor-infra owns shell scripts in BOTH the definition and the routing table', () => {
    const md = fs.readFileSync(INFRA_AGENT_MD, 'utf-8');
    const decl = md.split('\n').filter(l => l.startsWith('- **File patterns:**'));
    assert.equal(decl.length, 1, 'gsd-executor-infra.md must declare exactly one File patterns line');
    assert.ok(decl[0].includes('`*.sh`'),
      'the agent definition stopped declaring *.sh — the routing table below is no longer derived from it');
    const infra = caps.agents.find(a => a.id === 'gsd-executor-infra');
    assert.ok(infra.file_patterns.includes('*.sh'),
      'agent-capabilities.json lost *.sh: TK-2376 (docs/*.md + scripts/verify-provisioning.sh) falls back to executor-general again');
  });

  it('every file_pattern in the table actually routes to the agent that declares it', () => {
    // Both directions again: no pattern may be inert, and no pattern may be
    // captured by a different agent. A dead row in this table is invisible
    // otherwise — it simply never matches and the work lands on the fallback.
    const sample = (pattern) => {
      if (pattern.startsWith('*.')) return `src/example${pattern.slice(1)}`;
      if (pattern.endsWith('/*')) return `${pattern.slice(0, -2)}/example.txt`;
      if (pattern.endsWith('*')) return `${pattern.slice(0, -1)}.example`;
      return pattern;
    };
    const failures = [];
    for (const agent of caps.agents) {
      if (!agent.file_patterns || !agent.file_patterns.length) continue;
      for (const pattern of agent.file_patterns) {
        const got = routeFull(sample(pattern));
        if (got.matched_agent !== agent.id) {
          failures.push(`${agent.id} declares ${pattern} but ${sample(pattern)} -> ${got.matched_agent || got.executor}`);
        }
      }
    }
    assert.deepEqual(failures, [], `patterns that do not route to their own agent:\n  ${failures.join('\n  ')}`);
  });
});

describe('ROUTE-CONTRACT-05: backward compatibility', () => {
  it('.executor is still present and still a bare executor id', () => {
    for (const arg of ['src/App.tsx', 'Dockerfile', 'services/api.py', 'README.md']) {
      const r = routeFull(arg);
      assert.equal(typeof r.executor, 'string');
      assert.ok(r.executor.startsWith('executor-'), `${arg} -> ${r.executor}`);
      assert.ok(!r.executor.startsWith('gsd-'), 'the gsd- prefix must stay stripped');
    }
  });
});
