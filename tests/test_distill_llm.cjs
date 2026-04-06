'use strict';

/**
 * Plan 02-03: LLM Distill Tests
 *
 * Tests for LLM-based summarization helpers and fallback in gsd-memory.cjs distill command.
 * Uses code-structure verification (consistent with this codebase's test style) plus
 * runtime tests for helpers via a child_process module injection technique.
 *
 * Tests:
 *   1.  isOllamaAvailable function is defined
 *   2.  isOllamaAvailable uses 'which ollama'
 *   3.  selectOllamaModel prefers qwen3:8b (code check)
 *   4.  selectOllamaModel falls back to llama3.2:3b (code check)
 *   5.  selectOllamaModel returns null on error (code check)
 *   6.  llmSummarize truncates entries to 800 chars in prompt
 *   7.  llmSummarize returns null on short output (< 20 chars) -- code check
 *   8.  llmSummarize returns null on error via stderr write
 *   9.  distill without --use-llm uses concatenation strategy (default path)
 *   10. distill metadata includes distill_strategy and distill_model fields
 *   11. merged_from and original_count provenance fields are preserved
 *   12. --use-llm flag is in help text
 *   13. fallback messages present for no-ollama and no-models cases
 *   14. llmSummarize uses 30s timeout
 *   15. test exports present in module.exports block
 *   16. isOllamaAvailable returns true when which ollama succeeds (runtime)
 *   17. isOllamaAvailable returns false when which ollama throws (runtime)
 *   18. selectOllamaModel returns null when ollama list throws (runtime)
 *   19. llmSummarize returns null when ollama run throws (runtime)
 *   20. llmSummarize returns null for short output (runtime)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MEMORY_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-memory.cjs');
const SOURCE = fs.readFileSync(MEMORY_CJS, 'utf8');

// ── Helper: load helpers with a controllable execSync ────────────────────────

/**
 * Builds and evaluates the three helper functions in isolation with a
 * provided execSync stub, avoiding loading the full gsd-memory.cjs module.
 * Extracts each function's source from the file and eval()s it in a
 * sandboxed context with the given execSync.
 */
function buildHelpersWithExecSync(execSyncFn) {
  // Extract function bodies from source using simple start/end detection
  function extractFunction(name) {
    const startMarker = `function ${name}(`;
    const startIdx = SOURCE.indexOf(startMarker);
    if (startIdx === -1) throw new Error(`Function ${name} not found in source`);

    // Walk forward counting braces to find the closing brace
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let endIdx = startIdx;
    let foundFirstBrace = false;

    for (let i = startIdx; i < SOURCE.length; i++) {
      const ch = SOURCE[i];
      if (inString) {
        if (ch === stringChar && SOURCE[i - 1] !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
      if (ch === '{') { depth++; foundFirstBrace = true; }
      if (ch === '}') { depth--; }
      if (foundFirstBrace && depth === 0) { endIdx = i + 1; break; }
    }
    return SOURCE.slice(startIdx, endIdx);
  }

  const isOllamaAvailableSrc = extractFunction('isOllamaAvailable');
  const selectOllamaModelSrc = extractFunction('selectOllamaModel');
  const llmSummarizeSrc = extractFunction('llmSummarize');

  // Build a module context where require('child_process') returns our mock
  const fakeRequire = (mod) => {
    if (mod === 'child_process') return { execSync: execSyncFn };
    return require(mod);
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function('require', 'process', `
    ${isOllamaAvailableSrc}
    ${selectOllamaModelSrc}
    ${llmSummarizeSrc}
    return { isOllamaAvailable, selectOllamaModel, llmSummarize };
  `);

  return factory(fakeRequire, process);
}

// ── Code structure tests ─────────────────────────────────────────────────────

describe('distill LLM flag and code structure (02-03)', () => {
  test('isOllamaAvailable function is defined', () => {
    assert.ok(
      SOURCE.includes('function isOllamaAvailable()'),
      'Should define isOllamaAvailable()'
    );
  });

  test('isOllamaAvailable uses which ollama to detect binary', () => {
    assert.ok(
      SOURCE.includes("execSync('which ollama'"),
      'isOllamaAvailable should call which ollama'
    );
  });

  test('selectOllamaModel prefers qwen3:8b over other models', () => {
    assert.ok(
      SOURCE.includes("'qwen3:8b'") && SOURCE.includes('ollama list'),
      'selectOllamaModel should prefer qwen3:8b and use ollama list'
    );
  });

  test('selectOllamaModel falls back to llama3.2:3b when qwen3:8b absent', () => {
    assert.ok(
      SOURCE.includes("'llama3.2:3b'"),
      'selectOllamaModel should include llama3.2:3b as secondary preference'
    );
  });

  test('selectOllamaModel returns null when no models found', () => {
    // The catch block returns null
    const selectSrc = SOURCE.slice(
      SOURCE.indexOf('function selectOllamaModel()'),
      SOURCE.indexOf('function llmSummarize(')
    );
    assert.ok(
      selectSrc.includes('return null'),
      'selectOllamaModel should return null on error'
    );
  });

  test('llmSummarize truncates each entry to 800 chars in the prompt', () => {
    assert.ok(
      SOURCE.includes('.slice(0, 800)'),
      'llmSummarize should truncate entry text to 800 chars'
    );
  });

  test('llmSummarize returns null for suspiciously short output (< 20 chars)', () => {
    assert.ok(
      SOURCE.includes('summary.length < 20'),
      'llmSummarize should return null when output < 20 chars'
    );
  });

  test('llmSummarize writes to stderr on error', () => {
    assert.ok(
      SOURCE.includes('[distill] LLM summarization failed'),
      'llmSummarize should log errors to stderr'
    );
  });

  test('distill without --use-llm uses concatenation strategy (default path)', () => {
    assert.ok(
      SOURCE.includes("distillStrategy = 'concatenation'"),
      "Should set distillStrategy = 'concatenation' as default/fallback"
    );
  });

  test('distill metadata includes distill_strategy field', () => {
    assert.ok(
      SOURCE.includes('distill_strategy: distillStrategy'),
      'mergeBody.metadata should include distill_strategy'
    );
  });

  test('distill metadata includes distill_model field', () => {
    assert.ok(
      SOURCE.includes('distill_model:') && SOURCE.includes("distillStrategy === 'claude-sonnet'"),
      'mergeBody.metadata should include distill_model with provider-conditional value'
    );
  });

  test('distill metadata preserves merged_from and original_count provenance', () => {
    assert.ok(
      SOURCE.includes('merged_from: group.map(e => e.id)'),
      'mergeBody.metadata should include merged_from provenance'
    );
    assert.ok(
      SOURCE.includes('original_count: group.length'),
      'mergeBody.metadata should include original_count provenance'
    );
  });

  test('--use-llm flag is documented in help text', () => {
    assert.ok(
      SOURCE.includes('--use-llm'),
      'Should mention --use-llm in help or flag handling'
    );
  });

  test('fallback message present when no Claude API key and no Ollama available', () => {
    assert.ok(
      SOURCE.includes('no Claude API key and no Ollama available. Falling back to concatenation'),
      'Should have a fallback message when neither Claude nor Ollama is available'
    );
  });

  test('llmSummarize uses 30s timeout to prevent hangs', () => {
    assert.ok(
      SOURCE.includes('timeout: 30000'),
      'llmSummarize should use a 30s timeout'
    );
  });

  test('test exports are present under require.main !== module guard', () => {
    assert.ok(
      SOURCE.includes('_test_isOllamaAvailable') &&
      SOURCE.includes('_test_selectOllamaModel') &&
      SOURCE.includes('_test_llmSummarize') &&
      SOURCE.includes('_test_claudeSummarize'),
      'Should export test helpers via _test_ prefix (including claudeSummarize)'
    );
    assert.ok(
      SOURCE.includes('require.main !== module'),
      'Test exports should be guarded by require.main !== module'
    );
  });
});

// ── Runtime tests with injected execSync ─────────────────────────────────────

describe('isOllamaAvailable runtime (02-03)', () => {
  test('returns true when which ollama succeeds', () => {
    const helpers = buildHelpersWithExecSync((cmd) => {
      if (cmd === 'which ollama') return '/usr/local/bin/ollama\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    assert.strictEqual(helpers.isOllamaAvailable(), true);
  });

  test('returns false when which ollama throws', () => {
    const helpers = buildHelpersWithExecSync(() => {
      throw new Error('not found');
    });
    assert.strictEqual(helpers.isOllamaAvailable(), false);
  });
});

describe('selectOllamaModel runtime (02-03)', () => {
  test('prefers qwen3:8b when present', () => {
    const listOutput = 'NAME            ID    SIZE\nqwen3:8b        abc   5.2GB\nllama3.2:3b     def   2.0GB\n';
    const helpers = buildHelpersWithExecSync((cmd) => {
      if (cmd === 'ollama list') return listOutput;
      throw new Error(`unexpected: ${cmd}`);
    });
    assert.strictEqual(helpers.selectOllamaModel(), 'qwen3:8b');
  });

  test('falls back to llama3.2:3b when qwen3:8b absent', () => {
    const listOutput = 'NAME            ID    SIZE\nllama3.2:3b     def   2.0GB\nmistral:7b      ghi   4.1GB\n';
    const helpers = buildHelpersWithExecSync((cmd) => {
      if (cmd === 'ollama list') return listOutput;
      throw new Error(`unexpected: ${cmd}`);
    });
    assert.strictEqual(helpers.selectOllamaModel(), 'llama3.2:3b');
  });

  test('returns null when ollama list throws', () => {
    const helpers = buildHelpersWithExecSync(() => {
      throw new Error('connection refused');
    });
    assert.strictEqual(helpers.selectOllamaModel(), null);
  });

  test('returns first available model when neither preferred model is found', () => {
    const listOutput = 'NAME            ID    SIZE\nmistral:7b      ghi   4.1GB\n';
    const helpers = buildHelpersWithExecSync((cmd) => {
      if (cmd === 'ollama list') return listOutput;
      throw new Error(`unexpected: ${cmd}`);
    });
    assert.strictEqual(helpers.selectOllamaModel(), 'mistral:7b');
  });
});

describe('llmSummarize runtime (02-03)', () => {
  test('returns trimmed summary text on success', () => {
    const summary = '  Key insight: auth tokens expire after 24h.  ';
    const helpers = buildHelpersWithExecSync((cmd) => {
      if (cmd.startsWith('ollama run')) return summary;
      throw new Error(`unexpected: ${cmd}`);
    });
    const entries = [
      { text: 'auth tokens have a 24h expiry', source: 'auto_learning' },
      { text: 'refresh tokens are used to get new access tokens', source: 'lesson-learned' },
    ];
    const result = helpers.llmSummarize(entries, 'qwen3:8b');
    assert.strictEqual(result, summary.trim());
  });

  test('returns null when ollama run throws an error', () => {
    const helpers = buildHelpersWithExecSync(() => {
      throw new Error('model not found');
    });
    const result = helpers.llmSummarize([{ text: 'entry', source: 'auto_learning' }], 'qwen3:8b');
    assert.strictEqual(result, null);
  });

  test('returns null when LLM output is too short (< 20 chars)', () => {
    const helpers = buildHelpersWithExecSync(() => 'ok\n');
    const result = helpers.llmSummarize([{ text: 'some entry', source: 'auto_learning' }], 'qwen3:8b');
    assert.strictEqual(result, null);
  });

  test('truncates output to 4000 chars', () => {
    const longOutput = 'x'.repeat(5000);
    const helpers = buildHelpersWithExecSync(() => longOutput);
    const result = helpers.llmSummarize([{ text: 'memory entry', source: 'auto_learning' }], 'qwen3:8b');
    assert.ok(result !== null, 'Should return non-null for long valid output');
    assert.ok(result.length <= 4000, `Should truncate to 4000 chars (got ${result.length})`);
  });
});

// ── Claude API provider chain tests ──────────────────────────────────────────

describe('Claude API provider chain code structure', () => {
  test('claudeSummarize function is defined', () => {
    assert.ok(
      SOURCE.includes('function claudeSummarize(entries, model)'),
      'Should define claudeSummarize(entries, model)'
    );
  });

  test('claudeSummarize uses Anthropic Messages API endpoint', () => {
    assert.ok(
      SOURCE.includes("hostname: 'api.anthropic.com'") &&
      SOURCE.includes("path: '/v1/messages'"),
      'claudeSummarize should call api.anthropic.com/v1/messages'
    );
  });

  test('claudeSummarize sends required Anthropic headers', () => {
    assert.ok(
      SOURCE.includes("'x-api-key': apiKey") &&
      SOURCE.includes("'anthropic-version': '2023-06-01'") &&
      SOURCE.includes("'content-type': 'application/json'"),
      'claudeSummarize should include x-api-key, anthropic-version, and content-type headers'
    );
  });

  test('claudeSummarize returns null when ANTHROPIC_API_KEY is not set', () => {
    assert.ok(
      SOURCE.includes("if (!apiKey) { resolve(null); return; }"),
      'claudeSummarize should early-return null when API key is missing'
    );
  });

  test('claudeSummarize uses 30s timeout', () => {
    // Count timeout: 30000 occurrences — should be in both llmSummarize and claudeSummarize
    const timeouts = SOURCE.match(/timeout: 30000/g) || [];
    assert.ok(
      timeouts.length >= 2,
      `Should have timeout: 30000 in both llmSummarize and claudeSummarize (found ${timeouts.length})`
    );
  });

  test('distill loop tries Claude Sonnet before Haiku', () => {
    const sonnetIdx = SOURCE.indexOf("'claude-sonnet-4-5-20250514'");
    const haikuIdx = SOURCE.indexOf("'claude-haiku-4-5-20251001'");
    assert.ok(sonnetIdx > -1, 'Should reference claude-sonnet-4-5-20250514 model');
    assert.ok(haikuIdx > -1, 'Should reference claude-haiku-4-5-20251001 model');
    assert.ok(sonnetIdx < haikuIdx, 'Sonnet should be tried before Haiku in the provider chain');
  });

  test('distill_strategy metadata tracks provider: claude-sonnet, claude-haiku, ollama, or concatenation', () => {
    assert.ok(SOURCE.includes("distillStrategy = 'claude-sonnet'"), 'Should set claude-sonnet strategy');
    assert.ok(SOURCE.includes("distillStrategy = 'claude-haiku'"), 'Should set claude-haiku strategy');
    assert.ok(SOURCE.includes("distillStrategy = 'ollama'"), 'Should set ollama strategy');
    assert.ok(SOURCE.includes("distillStrategy = 'concatenation'"), 'Should set concatenation strategy');
  });

  test('_test_claudeSummarize is exported for testing', () => {
    assert.ok(
      SOURCE.includes('_test_claudeSummarize: claudeSummarize'),
      'Should export claudeSummarize via _test_ prefix'
    );
  });

  test('help text mentions Claude provider chain', () => {
    assert.ok(
      SOURCE.includes('Claude Sonnet > Haiku > Ollama'),
      'Help text should mention Claude > Ollama provider chain'
    );
  });
});
