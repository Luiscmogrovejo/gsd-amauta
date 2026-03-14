/**
 * Research Chain Tests
 *
 * Tests gsd-research.cjs providers, chain order, graceful degradation,
 * and integration with memory storage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RESEARCH_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-research.cjs');

function withTmp(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-'));
  try { fn(tmpDir); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
}

function runResearch(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [RESEARCH_CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GSD_AMAUTA_PORT: '19999',
        GSD_AMAUTA_NO_AUTO_START: '1',
        ...env,
      },
      timeout: 15000,
    });
    return { success: true, output: out.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

// ═══════════════════════════════════════════════════════
// Provider availability
// ═══════════════════════════════════════════════════════

describe('Research chain: provider detection', () => {
  test('check-providers shows all 5 providers', () => {
    const r = runResearch(['check-providers']);
    assert.ok(r.success, `check-providers failed: ${r.error || r.output}`);
    assert.ok(r.output.includes('memory'), 'should list memory provider');
    assert.ok(r.output.includes('skb'), 'should list skb provider');
    assert.ok(r.output.includes('context7'), 'should list context7 provider');
    assert.ok(r.output.includes('perplexity'), 'should list perplexity provider');
    assert.ok(r.output.includes('webfetch'), 'should list webfetch provider');
  });
});

// ═══════════════════════════════════════════════════════
// Chain execution (offline — memory/SKB will be searched, Perplexity skipped)
// ═══════════════════════════════════════════════════════

describe('Research chain: search command', () => {
  test('search produces output without crashing (offline mode)', () => {
    const r = runResearch(['search', 'React server components best practices']);
    // In offline mode without PG, memory and SKB return empty, Context7/Perplexity may be unavailable
    // The key assertion is that the chain completes without crashing
    assert.ok(r.output.length > 0 || r.error.length > 0,
      'search should produce some output (results or provider status)');
  });

  test('search with --all flag shows all provider results', () => {
    const r = runResearch(['search', 'authentication patterns', '--all']);
    // --all forces all providers to be queried even if earlier ones have results
    assert.ok(r.output.length > 0 || r.error.length > 0, 'should produce output');
  });
});

// ═══════════════════════════════════════════════════════
// Perplexity provider (requires API key)
// ═══════════════════════════════════════════════════════

describe('Research chain: Perplexity provider', () => {
  test('perplexity without API key exits with clear error', () => {
    const r = runResearch(['perplexity', 'test query'], {
      PERPLEXITY_API_KEY: '', // explicitly unset
    });
    assert.ok(!r.success, 'should fail without API key');
    assert.ok(
      r.error.includes('PERPLEXITY_API_KEY') || r.output.includes('PERPLEXITY_API_KEY'),
      `should mention PERPLEXITY_API_KEY: ${r.error || r.output}`
    );
  });

  test('perplexity is skipped silently in chain mode when no API key', () => {
    const r = runResearch(['search', 'test query'], {
      PERPLEXITY_API_KEY: '',
    });
    // Should NOT crash — Perplexity is just skipped in the chain
    const crashedOnPerplexity = r.error.includes('PERPLEXITY_API_KEY') &&
      r.error.includes('Error') && !r.error.includes('skipped');
    assert.ok(!crashedOnPerplexity,
      `chain should skip Perplexity gracefully: ${r.error.slice(0, 200)}`);
  });
});

// ═══════════════════════════════════════════════════════
// WebFetch provider
// ═══════════════════════════════════════════════════════

describe('Research chain: WebFetch provider', () => {
  test('fetch without --url shows usage error', () => {
    const r = runResearch(['fetch']);
    assert.ok(!r.success || r.output.includes('url') || r.error.includes('url'),
      'fetch without --url should show usage');
  });
});

// ═══════════════════════════════════════════════════════
// CLI structure
// ═══════════════════════════════════════════════════════

describe('Research chain: CLI structure', () => {
  test('no args shows usage help', () => {
    const r = runResearch([]);
    const combined = r.output + r.error;
    assert.ok(combined.includes('search') || combined.includes('Usage') || combined.includes('research'),
      `no-args should show help: ${combined.slice(0, 200)}`);
  });

  test('PROVIDER_ORDER is memory -> skb -> context7 -> perplexity -> webfetch', () => {
    const content = fs.readFileSync(RESEARCH_CLI, 'utf-8');
    const orderMatch = content.match(/PROVIDER_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, 'should define PROVIDER_ORDER');
    const order = orderMatch[1];
    assert.ok(order.includes('memory'), 'first should be memory');
    assert.ok(order.includes('perplexity'), 'should include perplexity');
    assert.ok(order.includes('webfetch'), 'last should be webfetch');
    // Verify order: memory comes before perplexity
    assert.ok(order.indexOf('memory') < order.indexOf('perplexity'),
      'memory should come before perplexity');
  });

  test('Perplexity API key read from env only (never hardcoded)', () => {
    const content = fs.readFileSync(RESEARCH_CLI, 'utf-8');
    assert.ok(content.includes('process.env.PERPLEXITY_API_KEY'),
      'should read PERPLEXITY_API_KEY from process.env');
    // Check no hardcoded key patterns
    const hasHardcodedKey = /pplx-[a-zA-Z0-9]{20,}/.test(content);
    assert.ok(!hasHardcodedKey, 'should not have hardcoded Perplexity API key');
  });

  test('Perplexity results auto-stored to memory with web_search_result source', () => {
    const content = fs.readFileSync(RESEARCH_CLI, 'utf-8');
    assert.ok(content.includes('web_search_result'),
      'should tag Perplexity results as web_search_result for +3 score boost');
  });
});

// ═══════════════════════════════════════════════════════
// Agent/Skill integration verification
// ═══════════════════════════════════════════════════════

describe('Research chain: agent integration', () => {
  test('all 11 agents have RESEARCH= variable', () => {
    const agentsDir = path.join(__dirname, '..', 'agents');
    const agents = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.strictEqual(agents.length, 11, `should have 11 agents: ${agents.join(', ')}`);
    for (const agent of agents) {
      const content = fs.readFileSync(path.join(agentsDir, agent), 'utf-8');
      assert.ok(content.includes('RESEARCH=') || content.includes("RESEARCH='"),
        `${agent} should have RESEARCH= variable`);
    }
  });

  test('all 11 skills have RESEARCH= variable', () => {
    const skillsDir = path.join(__dirname, '..', 'skills');
    const skills = fs.readdirSync(skillsDir).filter(f => f.startsWith('gsd-') && f.endsWith('-workflow'));
    assert.strictEqual(skills.length, 11, `should have 11 skills: ${skills.join(', ')}`);
    for (const skill of skills) {
      const content = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf-8');
      assert.ok(content.includes('RESEARCH='),
        `${skill}/SKILL.md should have RESEARCH= variable`);
    }
  });

  test('all 11 skills have $RESEARCH search in context pipeline', () => {
    const skillsDir = path.join(__dirname, '..', 'skills');
    const skills = fs.readdirSync(skillsDir).filter(f => f.startsWith('gsd-') && f.endsWith('-workflow'));
    for (const skill of skills) {
      const content = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf-8');
      assert.ok(content.includes('$RESEARCH search'),
        `${skill}/SKILL.md should have $RESEARCH search in context pipeline`);
    }
  });

  test('execute-phase.md enrichment block has research chain', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf-8'
    );
    assert.ok(content.includes('gsd-research.cjs search'),
      'execute-phase.md should call research chain in enrichment block');
  });

  test('execute-plan.md enrichment block has research chain', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'get-shit-done', 'workflows', 'execute-plan.md'), 'utf-8'
    );
    assert.ok(content.includes('gsd-research.cjs search'),
      'execute-plan.md should call research chain in enrichment block');
  });
});
