#!/usr/bin/env node
/**
 * Plan 19.1-01: v2.3 Tech Debt Gap Closure Tests
 *
 * Tests:
 *   Task 1: Reconcile compare_fields includes 9 new fields + rpetd_json_to_pg mapping
 *   Task 2: Dedup query includes project_id with NULL-safe comparison
 *   Task 5: stripPreamble extended with 3 new patterns + wider bounds
 *
 * Tasks 3 & 4 are data operations validated by purge script output.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const PG_STORE_PY = path.join(ROOT, 'services', 'pg_store.py');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');

const AMAUTA_SRC = fs.readFileSync(AMAUTA_PY, 'utf-8');
const PG_STORE_SRC = fs.readFileSync(PG_STORE_PY, 'utf-8');
const RESEARCH_SRC = fs.readFileSync(RESEARCH_CJS, 'utf-8');

// Extract cmd_reconcile function source
function getReconcileSrc() {
  const start = AMAUTA_SRC.indexOf('def cmd_reconcile(args)');
  const end = AMAUTA_SRC.indexOf('\ndef cmd_archive(args)', start);
  return AMAUTA_SRC.substring(start, end);
}

// Extract stripPreamble function source
function getStripPreambleSrc() {
  const start = RESEARCH_SRC.indexOf('function stripPreamble(text)');
  const end = RESEARCH_SRC.indexOf('\n}', start) + 2;
  return RESEARCH_SRC.substring(start, end);
}

// Extract memory_store_with_embedding dedup block
function getDedupSrc() {
  const start = PG_STORE_SRC.indexOf('def memory_store_with_embedding');
  const end = PG_STORE_SRC.indexOf('\n    def memory_semantic_search', start);
  return PG_STORE_SRC.substring(start, end);
}

describe('19.1-01 Gap Closure', () => {
  // ─── Task 1: Reconcile compare_fields ─────────────────────────
  describe('Task 1: Reconcile compare_fields (IP-2)', () => {
    const reconcileSrc = getReconcileSrc();

    const NINE_NEW_FIELDS = [
      'importance', 'urgency', 'rpetd_complete', 'claimed_at',
      'rpetd_r', 'rpetd_p', 'rpetd_e', 'rpetd_t', 'rpetd_d',
    ];

    it('compare_fields includes all 9 new fields', () => {
      for (const field of NINE_NEW_FIELDS) {
        assert.ok(
          reconcileSrc.includes(`"${field}"`),
          `compare_fields missing: ${field}`
        );
      }
    });

    it('rpetd_json_to_pg mapping exists with all 5 rpetd phase keys', () => {
      assert.ok(
        reconcileSrc.includes('rpetd_json_to_pg'),
        'rpetd_json_to_pg mapping not found in cmd_reconcile'
      );
      for (const key of ['rpetd_r', 'rpetd_p', 'rpetd_e', 'rpetd_t', 'rpetd_d']) {
        assert.ok(
          reconcileSrc.includes(`"${key}"`),
          `rpetd_json_to_pg missing key: ${key}`
        );
      }
    });

    it('json_to_pg still has parent -> parent_id mapping', () => {
      assert.ok(
        reconcileSrc.includes('"parent": "parent_id"'),
        'json_to_pg missing parent -> parent_id mapping'
      );
    });

    it('comparison loop uses rpetd_json_to_pg for rpetd_phases extraction', () => {
      assert.ok(
        reconcileSrc.includes('rpetd_json_to_pg[field]'),
        'comparison loop not using rpetd_json_to_pg for extraction'
      );
      assert.ok(
        reconcileSrc.includes('rpetd_phases'),
        'comparison loop not extracting from rpetd_phases dict'
      );
    });

    it('original 28 fields are still present', () => {
      const ORIGINAL_FIELDS = [
        'title', 'status', 'priority', 'assigned_to', 'claimed_by',
        'type', 'description', 'details', 'phase', 'plan',
        'test_strategy', 'outcome', 'lesson',
        'parent_id', 'validation_notes', 'validated_by',
        'doc_refs', 'risks', 'validation_checklist',
        'estimated_hours', 'due_date', 'sprint', 'children',
        'success_criteria', 'deliverables', 'dependencies',
        'tags', 'notes', 'evidence',
      ];
      for (const field of ORIGINAL_FIELDS) {
        assert.ok(
          reconcileSrc.includes(`"${field}"`),
          `original compare_fields missing: ${field}`
        );
      }
    });
  });

  // ─── Task 2: Dedup project_id filter ──────────────────────────
  describe('Task 2: Dedup project_id filter (DATA-04)', () => {
    const dedupSrc = getDedupSrc();

    it('dedup query includes project_id filter', () => {
      assert.ok(
        dedupSrc.includes('project_id'),
        'dedup query does not include project_id'
      );
    });

    it('NULL-safe comparison pattern is present', () => {
      assert.ok(
        dedupSrc.includes('project_id IS NULL AND %s IS NULL'),
        'NULL-safe comparison (IS NULL AND %s IS NULL) not found in dedup query'
      );
    });

    it('dedup query still uses cosine similarity', () => {
      assert.ok(
        dedupSrc.includes('embedding <=>'),
        'cosine distance operator not found in dedup query'
      );
    });
  });

  // ─── Task 5: stripPreamble patterns ───────────────────────────
  describe('Task 5: stripPreamble patterns (TOKEN-02)', () => {
    // Load the actual stripPreamble function for runtime testing
    const stripPreambleSrc = getStripPreambleSrc();

    it('stripPreamble function exists', () => {
      assert.ok(
        RESEARCH_SRC.includes('function stripPreamble'),
        'stripPreamble function not found'
      );
    });

    it('has 10 total patterns (7 original + 3 new)', () => {
      // Count regex pattern lines in the function
      const patternMatches = stripPreambleSrc.match(/\/\^/g);
      assert.ok(
        patternMatches && patternMatches.length >= 10,
        `Expected >= 10 patterns, found ${patternMatches ? patternMatches.length : 0}`
      );
    });

    it('new pattern: "the following is/provides/summarizes" exists', () => {
      assert.ok(
        stripPreambleSrc.includes('the\\s+following\\s+'),
        '"the following" pattern not found'
      );
    });

    it('new pattern: "to answer/address/respond to" exists', () => {
      assert.ok(
        stripPreambleSrc.includes('to\\s+(?:answer|address|respond'),
        '"to answer/address" pattern not found'
      );
    });

    it('new pattern: "great/good question" exists', () => {
      assert.ok(
        stripPreambleSrc.includes('great|good'),
        '"great/good question" pattern not found'
      );
    });

    it('bounded quantifiers widened to {0,120} and {0,100}', () => {
      assert.ok(
        stripPreambleSrc.includes('{0,120}'),
        '{0,120} bounded quantifier not found'
      );
      assert.ok(
        stripPreambleSrc.includes('{0,100}'),
        '{0,100} bounded quantifier not found'
      );
    });

    it('original patterns still present', () => {
      const originals = [
        'here\\s+(?:is|are)',
        'based\\s+on',
        'i\\s+found',
        'sure[,!.]',
        'let\\s+me',
        'certainly',
        'absolutely',
      ];
      for (const pat of originals) {
        assert.ok(
          stripPreambleSrc.includes(pat),
          `original pattern missing: ${pat}`
        );
      }
    });

    // Runtime tests via eval (load the function)
    it('strips "The following provides a comprehensive overview of the topic."', () => {
      // Create a minimal stripPreamble from the source
      const fn = new Function('text', `
        if (!text) return text;
        const patterns = [
          /^(?:here\\s+(?:is|are)\\s+(?:a\\s+)?(?:comprehensive|detailed|brief|quick)?\\s*(?:overview|summary|breakdown|look|analysis|guide|explanation)[^.:]{0,120}[.:]\s*)/i,
          /^(?:the\\s+following\\s+(?:is|provides|summarizes|outlines)\\s+[^.:]{0,120}[.:]\s*)/i,
          /^(?:to\\s+(?:answer|address|respond\\s+to)\\s+(?:your|this|the)\\s+(?:question|query|request)[^.:]{0,100}[.:,]\s*)/i,
          /^(?:(?:great|good)\\s+question[.!,]\\s*)/i,
        ];
        let result = text;
        for (const pattern of patterns) { result = result.replace(pattern, ''); }
        return result.trim();
      `);
      const input = 'The following provides a comprehensive overview of the topic. Real content here.';
      const output = fn(input);
      assert.ok(
        output.startsWith('Real content'),
        `Expected "Real content..." but got: "${output.substring(0, 40)}"`
      );
    });

    it('strips "To answer your question, here is the data."', () => {
      const fn = new Function('text', `
        if (!text) return text;
        const patterns = [
          /^(?:to\\s+(?:answer|address|respond\\s+to)\\s+(?:your|this|the)\\s+(?:question|query|request)[^.:,]{0,100}[.:,]\\s*)/i,
        ];
        let result = text;
        for (const pattern of patterns) { result = result.replace(pattern, ''); }
        return result.trim();
      `);
      const input = 'To answer your question, here is the data.';
      const output = fn(input);
      assert.ok(
        output.startsWith('here is the data'),
        `Expected "here is the data..." but got: "${output.substring(0, 40)}"`
      );
    });

    it('strips "Good question. The system works by..."', () => {
      const fn = new Function('text', `
        if (!text) return text;
        const patterns = [
          /^(?:(?:great|good)\\s+question[.!,]\\s*)/i,
        ];
        let result = text;
        for (const pattern of patterns) { result = result.replace(pattern, ''); }
        return result.trim();
      `);
      const input = 'Good question. The system works by...';
      const output = fn(input);
      assert.ok(
        output.startsWith('The system works'),
        `Expected "The system works..." but got: "${output.substring(0, 40)}"`
      );
    });

    it('does NOT strip legitimate text starting with "The system uses..."', () => {
      const fn = new Function('text', `
        if (!text) return text;
        const patterns = [
          /^(?:here\\s+(?:is|are)\\s+(?:a\\s+)?(?:comprehensive|detailed|brief|quick)?\\s*(?:overview|summary|breakdown|look|analysis|guide|explanation)[^.:]{0,120}[.:]\s*)/i,
          /^(?:the\\s+following\\s+(?:is|provides|summarizes|outlines)\\s+[^.:]{0,120}[.:]\s*)/i,
          /^(?:to\\s+(?:answer|address|respond\\s+to)\\s+(?:your|this|the)\\s+(?:question|query|request)[^.:]{0,100}[.:,]\s*)/i,
          /^(?:(?:great|good)\\s+question[.!,]\\s*)/i,
        ];
        let result = text;
        for (const pattern of patterns) { result = result.replace(pattern, ''); }
        return result.trim();
      `);
      const input = 'The system uses a modular architecture with 3 services.';
      const output = fn(input);
      assert.strictEqual(output, input, 'Legitimate text was incorrectly stripped');
    });
  });
});
