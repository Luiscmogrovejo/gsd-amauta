'use strict';
/**
 * tests/61-01-persona-compile-registry.test.cjs — Phase 61 PERS-01 SC1 evidence.
 *
 * DYNAMIC-GLOB RATIONALE (Nyquist floor — Phase 60 precedent):
 * This test enumerates `agents/gsd-persona-*.md` via `fs.readdirSync` rather
 * than hardcoding a fixed 3-name list. The roster is expected to GROW beyond
 * the initial 3 launch personas (see 61-CONTEXT.md "Deferred Ideas" — mobile/
 * wearable/AI personas are explicitly future scope). A hardcoded list would
 * silently stop covering new personas the moment they land, exactly the
 * anti-pattern `tests/agents-compile-claude-target-byte-match.test.cjs`
 * exhibits today: it hardcodes `AGENT_NAMES` to a fixed count and currently
 * asserts `compiled.length === 22`, but `get-shit-done/agents/` has already
 * grown past that count without the lock test being updated (a pre-existing
 * staleness documented in plan 61-01's Objective, NOT fixed by this task).
 * This test intentionally scopes its byte-match assertion to `gsd-persona-*`
 * ONLY — it does not assert on non-persona agents, and does not attempt to
 * repair the Phase 52 lock test's stale count.
 *
 * Pure in-process compile — no network, no PG, no subprocess.
 * Run: node --test tests/61-01-persona-compile-registry.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const YAML_AGENTS_DIR = path.join(ROOT, 'get-shit-done', 'agents');
const CAPABILITIES_PATH = path.join(ROOT, 'get-shit-done', 'agent-capabilities.json');
const COMPILER = path.join(ROOT, 'scripts', 'agent-compiler.cjs');
const { compile } = require(COMPILER);

// The 3 launch personas (Phase 61 PERS-01) — a FLOOR, not the sole coverage.
// The roster-enumeration test below asserts the dynamic glob finds AT LEAST
// these 3; it does not restrict the glob to only these names.
const LAUNCH_PERSONAS = [
  'gsd-persona-senior-backend',
  'gsd-persona-frontend-specialist',
  'gsd-persona-systems-architect',
];

/** Dynamically enumerate all gsd-persona-*.md files in agents/. */
function listPersonaAgentNames() {
  return fs.readdirSync(AGENTS_DIR)
    .filter((f) => /^gsd-persona-.*\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

// ─── Group 1: Roster floor (dynamic glob, Nyquist) ────────────────────────

describe('[PERS-01] Persona roster: dynamic-glob floor (never a hardcoded list)', () => {
  const personaNames = listPersonaAgentNames();

  test('agents/gsd-persona-*.md count is at least 3', () => {
    assert.ok(
      personaNames.length >= 3,
      `Expected >= 3 persona agents, found ${personaNames.length}: ${personaNames.join(', ')}`
    );
  });

  test('the 3 launch personas are present in the dynamic glob', () => {
    for (const name of LAUNCH_PERSONAS) {
      assert.ok(
        personaNames.includes(name),
        `Launch persona ${name} missing from dynamic glob result: ${personaNames.join(', ')}`
      );
    }
  });

  for (const name of listPersonaAgentNames()) {
    test(`${name} has a sibling get-shit-done/agents/${name}/AGENT.yaml`, () => {
      const yamlPath = path.join(YAML_AGENTS_DIR, name, 'AGENT.yaml');
      assert.ok(
        fs.existsSync(yamlPath),
        `Missing AGENT.yaml for persona ${name} at ${yamlPath}`
      );
    });
  }
});

// ─── Group 2: SC1 byte-match (personas only) ──────────────────────────────

describe('[PERS-01][SC1] Persona compile byte-match (scoped to gsd-persona-* only)', () => {
  test('compile(claude-code) is byte-for-byte identical to agents/gsd-persona-*.md for every dynamically-globbed persona', (t) => {
    const personaNames = listPersonaAgentNames();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-byte-match-'));
    t.after(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    const result = compile('claude-code', {
      source: YAML_AGENTS_DIR,
      outDir: tmpDir,
    });

    assert.equal(
      result.errors.length, 0,
      `compile() must produce 0 errors. Got: ${JSON.stringify(result.errors)}`
    );

    const diffs = [];

    for (const name of personaNames) {
      const canonicalPath = path.join(AGENTS_DIR, `${name}.md`);
      const generatedPath = path.join(tmpDir, `${name}.md`);

      let canonical;
      try {
        canonical = fs.readFileSync(canonicalPath, 'utf8');
      } catch (e) {
        diffs.push(`${name}: MISSING canonical file at ${canonicalPath}`);
        continue;
      }

      let generated;
      try {
        generated = fs.readFileSync(generatedPath, 'utf8');
      } catch (e) {
        diffs.push(`${name}: MISSING generated file at ${generatedPath} (compile did not emit this persona)`);
        continue;
      }

      if (canonical !== generated) {
        let firstDiffByte = -1;
        for (let i = 0; i < Math.min(canonical.length, generated.length); i++) {
          if (canonical[i] !== generated[i]) { firstDiffByte = i; break; }
        }
        const lenMsg = canonical.length !== generated.length
          ? ` (length: canonical=${canonical.length} generated=${generated.length})`
          : '';
        let ctxMsg = '';
        if (firstDiffByte >= 0) {
          const ctxStart = Math.max(0, firstDiffByte - 20);
          const ctxEnd = Math.min(canonical.length, firstDiffByte + 40);
          ctxMsg = ` | byte ${firstDiffByte}${lenMsg}`
            + ` | canonical[${ctxStart}:${ctxEnd}]=${JSON.stringify(canonical.slice(ctxStart, ctxEnd))}`
            + ` | generated[${ctxStart}:${Math.min(generated.length, ctxEnd)}]=${JSON.stringify(generated.slice(ctxStart, Math.min(generated.length, ctxEnd)))}`;
        } else if (canonical.length !== generated.length) {
          ctxMsg = lenMsg;
        }
        diffs.push(`${name}: byte mismatch${ctxMsg}`);
      }
    }

    assert.strictEqual(
      diffs.length, 0,
      `SC1 byte-match FAILED for ${diffs.length} persona(s):\n${diffs.join('\n')}\n\n` +
      `HALT-AND-DIVERGE: do NOT edit agents/gsd-persona-*.md or AGENT.yaml to fix this.\n` +
      `Route to: scripts/agent-compiler.cjs (fix emitter) OR scripts/agent-md-to-yaml.cjs (fix converter).\n\n` +
      `Scope note: this test asserts ONLY on gsd-persona-* agents. The pre-existing 8-agent ` +
      `byte-match drift among non-persona agents (documented in plan 61-01's Objective) is ` +
      `OUT OF SCOPE here — see tests/agents-compile-claude-target-byte-match.test.cjs.`
    );
  });
});

// ─── Group 3: Registry integrity (both directions) ────────────────────────

describe('[PERS-01] Registry integrity: get-shit-done/agent-capabilities.json', () => {
  const capabilities = JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf8'));
  const allAgentIds = new Set(capabilities.agents.map((a) => a.id));
  const personaEntries = capabilities.agents.filter((a) => a.kind === 'persona');
  const personaEntryIds = new Set(personaEntries.map((a) => a.id));
  const personaNames = listPersonaAgentNames();

  test('every dynamically-globbed persona .md has a kind:"persona" registry entry', () => {
    for (const name of personaNames) {
      assert.ok(
        personaEntryIds.has(name),
        `agents/${name}.md exists but no kind:"persona" entry found in agent-capabilities.json`
      );
    }
  });

  test('every persona registry entry has base_executor as a non-empty array', () => {
    for (const entry of personaEntries) {
      assert.ok(
        Array.isArray(entry.base_executor) && entry.base_executor.length >= 1,
        `${entry.id}: base_executor must be a non-empty array, got: ${JSON.stringify(entry.base_executor)}`
      );
    }
  });

  test('every base_executor value resolves to an existing gsd-executor-* id in the same file', () => {
    for (const entry of personaEntries) {
      for (const baseId of entry.base_executor) {
        assert.ok(
          baseId.startsWith('gsd-executor-'),
          `${entry.id}: base_executor value "${baseId}" does not start with "gsd-executor-"`
        );
        assert.ok(
          allAgentIds.has(baseId),
          `${entry.id}: base_executor value "${baseId}" does not resolve to an existing agent id in agent-capabilities.json`
        );
      }
    }
  });

  test('every persona registry entry has file_patterns deep-equal to []', () => {
    for (const entry of personaEntries) {
      assert.deepStrictEqual(
        entry.file_patterns, [],
        `${entry.id}: file_patterns must be [] (personas never participate in routeExecutor()), got: ${JSON.stringify(entry.file_patterns)}`
      );
    }
  });

  test('inverse: every kind:"persona" registry entry has a corresponding agents/<id>.md file (no registry-only ghosts)', () => {
    for (const entry of personaEntries) {
      const mdPath = path.join(AGENTS_DIR, `${entry.id}.md`);
      assert.ok(
        fs.existsSync(mdPath),
        `Registry entry ${entry.id} has kind:"persona" but no corresponding file at ${mdPath} (registry-only ghost)`
      );
    }
  });
});

// ─── Group 4: Frontmatter conformance floor ────────────────────────────────

describe('[PERS-01] Persona frontmatter conformance floor', () => {
  for (const name of listPersonaAgentNames()) {
    test(`${name}.md has exactly 10 "## " sections`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${name}.md has ${count} sections, expected 10`);
    });

    test(`${name}.md contains "npm ci"`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
      assert.ok(content.includes('npm ci'), `${name}.md missing "npm ci"`);
    });

    test(`${name}.md contains the verbatim "# hooks:" comment block`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
      assert.ok(content.includes('# hooks:'), `${name}.md missing "# hooks:"`);
    });

    test(`${name}.md last non-empty line is exactly "<!-- CACHE_BREAKPOINT -->"`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      assert.strictEqual(
        lines[lines.length - 1].trim(), '<!-- CACHE_BREAKPOINT -->',
        `${name}.md last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
      );
    });
  }
});
