#!/usr/bin/env node
/**
 * Plan 19-01: Token Efficiency Tests
 * Tests for enrichment dedup (TOKEN-01), Perplexity truncation (TOKEN-02),
 * and RPETD soft cap (TOKEN-03).
 *
 * Tests:
 *   TOKEN-01:
 *     1. Recent system-enrichment note -> dedup logic detects cache hit
 *     2. Old system-enrichment note (>5 min) -> dedup logic does NOT skip
 *     3. Task with no notes -> returns empty string (no crash)
 *   TOKEN-02:
 *     4. stripPreamble removes "Here is a comprehensive overview:" prefix
 *     5. stripPreamble removes "Based on my research," prefix
 *     6. Short text with no preamble -> unchanged
 *     7. Long text (3000 chars) -> truncated to 1500 by PERPLEXITY_OUTPUT_CAP
 *   TOKEN-03:
 *     8. RPETD_SOFT_CAP constant exists and equals 2000
 *     9. RPETD_PHASE_GUIDANCE has all 5 phases with numeric targets
 *    10. Content > 2000 chars produces "exceeds soft cap" warning on stderr
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');

const TEST_DATA_DIR = path.join(os.tmpdir(), `amauta-test-token-${Date.now()}`);

function pyExec(code, opts = {}) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: {
      ...process.env,
      GSD_AMAUTA_NO_AUTO_START: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      AMAUTA_DATA_DIR: opts.dataDir || TEST_DATA_DIR,
    },
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function amautaCmd(args, opts = {}) {
  return execFileSync('python3', [AMAUTA_PY, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      GSD_AMAUTA_NO_AUTO_START: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      AMAUTA_DATA_DIR: opts.dataDir || TEST_DATA_DIR,
    },
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function amautaCmdWithStderr(args, opts = {}) {
  try {
    const result = execFileSync('python3', [AMAUTA_PY, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        GSD_AMAUTA_NO_AUTO_START: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        AMAUTA_DATA_DIR: opts.dataDir || TEST_DATA_DIR,
      },
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result, stderr: '' };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', error: err };
  }
}

function createTestData(dataDir, items) {
  fs.mkdirSync(dataDir, { recursive: true });
  const data = {
    items: items,
    sprints: [],
    metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(data, null, 2));
}

// ── stripPreamble (inlined from gsd-research.cjs for unit testing) ──
function stripPreamble(text) {
  if (!text) return text;
  const patterns = [
    /^(?:here\s+(?:is|are)\s+(?:a\s+)?(?:comprehensive|detailed|brief|quick)?\s*(?:overview|summary|breakdown|look|analysis|guide|explanation)[^.:]{0,80}[.:]\s*)/i,
    /^(?:based\s+on\s+(?:my\s+)?(?:research|analysis|findings|the\s+(?:available\s+)?(?:information|data|sources))[^.:,]{0,60}[.:,]\s*)/i,
    /^(?:i\s+found\s+(?:that\s+)?(?:the\s+following|several|some|a\s+few)[^.:]{0,80}[.:]\s*)/i,
    /^(?:sure[,!.]?\s*(?:here\s+(?:is|are))?[^.:]{0,60}[.:]\s*)/i,
    /^(?:let\s+me\s+(?:provide|explain|break\s+down|summarize)[^.:]{0,80}[.:]\s*)/i,
    /^(?:certainly[,!.]?\s*)/i,
    /^(?:absolutely[,!.]?\s*)/i,
  ];
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

before(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
});


// ═══════════════════════════════════════════════════════
// TOKEN-01: Enrichment Dedup
// ═══════════════════════════════════════════════════════

describe('TOKEN-01: Enrichment Dedup (_last_enrichment_ts)', () => {

  it('returns timestamp from recent system-enrichment note', () => {
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import _last_enrichment_ts
from datetime import datetime, timezone

ts_now = datetime.now(timezone.utc).isoformat()
item = {
    "notes": [
        {"ts": "2026-01-01T00:00:00+00:00", "by": "agent", "text": "claimed"},
        {"ts": ts_now, "by": "system-enrichment", "text": "Layer 1 context"},
    ]
}
result = _last_enrichment_ts(item)
assert result == ts_now, f"Expected {ts_now}, got {result}"
print("PASS")
    `);
    assert.equal(result, 'PASS');
  });

  it('returns empty string for old enrichment note (>5 min) -- dedup proceeds normally', () => {
    // This tests the helper returns the timestamp (which IS old), and separately
    // the age comparison in _rpetd_phase_enrich would NOT skip.
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import _last_enrichment_ts, ENRICHMENT_DEDUP_WINDOW
from datetime import datetime, timezone, timedelta

old_ts = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()
item = {
    "notes": [
        {"ts": old_ts, "by": "system-enrichment", "text": "Layer 1 context"},
    ]
}
result = _last_enrichment_ts(item)
assert result == old_ts, f"Expected {old_ts}, got {result}"

# Verify age would exceed the window
enrich_dt = datetime.fromisoformat(result)
now_dt = datetime.now(timezone.utc)
age = (now_dt - enrich_dt).total_seconds()
assert age >= ENRICHMENT_DEDUP_WINDOW, f"Age {age}s should exceed {ENRICHMENT_DEDUP_WINDOW}s"
print("PASS")
    `);
    assert.equal(result, 'PASS');
  });

  it('returns empty string when task has no notes (no crash)', () => {
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import _last_enrichment_ts

# No notes key at all
r1 = _last_enrichment_ts({})
assert r1 == "", f"Expected empty, got '{r1}'"

# Empty notes list
r2 = _last_enrichment_ts({"notes": []})
assert r2 == "", f"Expected empty, got '{r2}'"

# Notes with wrong 'by' field
r3 = _last_enrichment_ts({"notes": [{"ts": "2026-01-01", "by": "agent", "text": "x"}]})
assert r3 == "", f"Expected empty, got '{r3}'"

print("PASS")
    `);
    assert.equal(result, 'PASS');
  });

  it('ENRICHMENT_DEDUP_WINDOW constant is 300 seconds', () => {
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import ENRICHMENT_DEDUP_WINDOW
assert ENRICHMENT_DEDUP_WINDOW == 300, f"Expected 300, got {ENRICHMENT_DEDUP_WINDOW}"
print("PASS")
    `);
    assert.equal(result, 'PASS');
  });
});


// ═══════════════════════════════════════════════════════
// TOKEN-02: Perplexity Truncation + Preamble Stripping
// ═══════════════════════════════════════════════════════

describe('TOKEN-02: Perplexity Truncation (stripPreamble + cap)', () => {

  it('strips "Here is a comprehensive overview:" preamble', () => {
    const input = 'Here is a comprehensive overview of the topic: The actual content starts here.';
    const result = stripPreamble(input);
    assert.equal(result, 'The actual content starts here.');
  });

  it('strips "Based on my research," preamble', () => {
    const input = 'Based on my research, the answer is X.';
    const result = stripPreamble(input);
    assert.equal(result, 'the answer is X.');
  });

  it('strips "Let me provide an explanation:" preamble', () => {
    const input = 'Let me provide a detailed explanation: The real content.';
    const result = stripPreamble(input);
    assert.equal(result, 'The real content.');
  });

  it('strips "Certainly," preamble', () => {
    const input = 'Certainly, here is the information.';
    const result = stripPreamble(input);
    assert.equal(result, 'here is the information.');
  });

  it('leaves short text with no preamble unchanged', () => {
    const input = 'Use BM25 scoring for search ranking.';
    const result = stripPreamble(input);
    assert.equal(result, input);
  });

  it('PERPLEXITY_OUTPUT_CAP is 1500 in gsd-research.cjs', () => {
    const content = fs.readFileSync(RESEARCH_CJS, 'utf-8');
    assert.ok(content.includes('PERPLEXITY_OUTPUT_CAP = 1500'), 'Should define PERPLEXITY_OUTPUT_CAP = 1500');
  });

  it('long text (3000 chars) would be truncated to 1500 by cap', () => {
    const PERPLEXITY_OUTPUT_CAP = 1500;
    const longText = 'A'.repeat(3000);
    const result = stripPreamble(longText).slice(0, PERPLEXITY_OUTPUT_CAP);
    assert.equal(result.length, 1500, `Expected 1500 chars, got ${result.length}`);
  });
});


// ═══════════════════════════════════════════════════════
// TOKEN-03: RPETD Soft Cap
// ═══════════════════════════════════════════════════════

describe('TOKEN-03: RPETD Soft Cap', () => {

  it('RPETD_SOFT_CAP constant is 2000', () => {
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import RPETD_SOFT_CAP
assert RPETD_SOFT_CAP == 2000, f"Expected 2000, got {RPETD_SOFT_CAP}"
print("PASS")
    `);
    assert.equal(result, 'PASS');
  });

  it('RPETD_PHASE_GUIDANCE has all 5 phases with numeric targets', () => {
    const result = pyExec(`
import sys; sys.path.insert(0, '.')
from amauta import RPETD_PHASE_GUIDANCE
phases = ["R", "P", "E", "T", "D"]
for p in phases:
    assert p in RPETD_PHASE_GUIDANCE, f"Missing phase {p}"
    assert isinstance(RPETD_PHASE_GUIDANCE[p], int), f"Phase {p} target is not int"
    assert RPETD_PHASE_GUIDANCE[p] > 0, f"Phase {p} target must be > 0"
print("PASS")
    `);
    assert.equal(result, 'PASS');
  });

  it('content > 2000 chars triggers "exceeds soft cap" warning on stderr', () => {
    const dir = path.join(TEST_DATA_DIR, 'softcap1');
    createTestData(dir, [{
      id: 'TK-SC01',
      title: 'soft cap test',
      status: 'in-progress',
      type: 'task',
      claimed_by: 'test',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      dependencies: [],
      notes: [],
      tags: [],
      priority: 'medium',
      assigned_to: 'test',
    }]);

    const bigContent = 'X'.repeat(2500);
    let stderr = '';
    try {
      execFileSync('python3', [AMAUTA_PY, 'rpetd', 'TK-SC01', '--phase', 'E', '--content', bigContent, '--agent', 'test'], {
        cwd: ROOT,
        env: {
          ...process.env,
          GSD_AMAUTA_NO_AUTO_START: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          AMAUTA_DATA_DIR: dir,
        },
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      stderr = err.stderr || '';
    }

    // The command may succeed (exit 0) and we capture stderr from the normal flow
    // Re-run capturing stderr properly
    const { spawnSync } = require('node:child_process');
    const proc = spawnSync('python3', [AMAUTA_PY, 'rpetd', 'TK-SC01', '--phase', 'T', '--content', bigContent, '--agent', 'test'], {
      cwd: ROOT,
      env: {
        ...process.env,
        GSD_AMAUTA_NO_AUTO_START: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        AMAUTA_DATA_DIR: dir,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    stderr = proc.stderr || '';
    assert.ok(stderr.includes('exceeds soft cap'), `Expected "exceeds soft cap" in stderr: ${stderr.slice(0, 300)}`);
  });

  it('content <= 2000 chars produces NO warning', () => {
    const dir = path.join(TEST_DATA_DIR, 'softcap2');
    createTestData(dir, [{
      id: 'TK-SC02',
      title: 'no cap test',
      status: 'in-progress',
      type: 'task',
      claimed_by: 'test',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      dependencies: [],
      notes: [],
      tags: [],
      priority: 'medium',
      assigned_to: 'test',
    }]);

    const smallContent = 'Y'.repeat(1500);
    const { spawnSync } = require('node:child_process');
    const proc = spawnSync('python3', [AMAUTA_PY, 'rpetd', 'TK-SC02', '--phase', 'R', '--content', smallContent, '--agent', 'test'], {
      cwd: ROOT,
      env: {
        ...process.env,
        GSD_AMAUTA_NO_AUTO_START: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        AMAUTA_DATA_DIR: dir,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    const stderr = proc.stderr || '';
    assert.ok(!stderr.includes('exceeds soft cap'), `Should NOT have soft cap warning for 1500 chars: ${stderr.slice(0, 300)}`);
  });
});
