---
phase: 22-caveman-compressed-descriptions
verified_by: gsd-validator
verified_date: 2026-04-12
status: gaps_found
---

# Phase 22 Verification: Caveman-Compressed Descriptions

**Phase goal:** File descriptions and agent definitions deliver more signal per character.
Structured pipe-delimited file descriptions and grammar-stripped agent markdown cut character
counts by >= 30% while increasing distinct technical fact density by >= 40%.

**Requirements:** CAVE-01, CAVE-02, CAVE-03, CAVE-04

**Overall verdict:** GAPS_FOUND — CAVE-01, CAVE-03, CAVE-04 verified; CAVE-02 divergence
open (1.5% actual compression vs 30% target; properly surfaced via divergence protocol).

---

## Evidence Summary

### Test Run

```
$ python3 -m pytest tests/test_caveman_descriptions.py tests/test_grammar_strip.py tests/test_caveman_integration.py -v --tb=short

platform darwin -- Python 3.14.3, pytest-9.0.2
collected 54 items

tests/test_caveman_descriptions.py: 29 passed (CAVE-01)
tests/test_grammar_strip.py: 12 passed, 5 failed (CAVE-02 divergence)
tests/test_caveman_integration.py: 8 passed (CAVE-04 fact density + CAVE-01 wiring)

FAILED tests/test_grammar_strip.py::TestCompressionRatio::test_agent_file_reduction_ge_30_percent[agents/gsd-executor-backend.md]
  AssertionError: CAVE-02 DIVERGENCE: Original: 9833 chars, Stripped: 9686 chars,
  Ratio: 0.985 (required <= 0.70), Actual reduction: 1.5% (required >= 30%)
  Root cause: ~50-55% of file is code blocks, XML, YAML (preserved by spec).

FAILED tests/test_grammar_strip.py::TestCompressionRatio::test_agent_file_reduction_ge_30_percent[agents/gsd-checker.md]
  AssertionError: CAVE-02 DIVERGENCE: Original: 7933 chars, Stripped: 7851 chars,
  Ratio: 0.990, Actual reduction: 1.0%

FAILED tests/test_grammar_strip.py::TestCompressionRatio::test_agent_file_reduction_ge_30_percent[agents/gsd-researcher.md]
  AssertionError: CAVE-02 DIVERGENCE: Original: 8830 chars, Stripped: 8729 chars,
  Ratio: 0.989, Actual reduction: 1.1%

FAILED tests/test_grammar_strip.py::TestCompressionRatio::test_agent_file_reduction_ge_30_percent[agents/gsd-executor-general.md]
  AssertionError: CAVE-02 DIVERGENCE: Original: 9445 chars, Stripped: 9285 chars,
  Ratio: 0.983, Actual reduction: 1.7%

FAILED tests/test_grammar_strip.py::TestCompressionRatio::test_agent_file_reduction_ge_30_percent[agents/gsd-debugger.md]
  AssertionError: CAVE-02 DIVERGENCE: Original: 9564 chars, Stripped: 9397 chars,
  Ratio: 0.983, Actual reduction: 1.7%

========================= 5 failed, 49 passed in 0.13s =========================
```

```
$ node --test tests/22-caveman-bm25.test.cjs

▶ Phase 22 CAVE-03: BM25 Retrieval Benchmark
  ✔ ground truth has exactly 20 queries (0.426084ms)
  ✔ all expected_top3 files exist on disk (0.8065ms)
  ✔ BM25 tokenizer produces non-empty tokens for all corpus files (0.067375ms)
  ✔ compressed MRR >= 0.95 * original MRR (2.898541ms)
  ✔ no single query drops > 2 rank positions (2.2415ms)
✔ Phase 22 CAVE-03: BM25 Retrieval Benchmark (7.080459ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ duration_ms 861.34625
```

---

## Requirement-by-Requirement Verdict

### CAVE-01: Pipe-Delimited File Description Generator — PASS

**Requirement:** File description generator outputs structured format matching
`^.+\|.deps:.+\|.touches:.+\|.tests:.+\|.+$`; test verifies 10 sample files produce
parseable descriptions.

**Evidence:**
- `services/caveman_descriptions.py` exists; `generate_caveman_description(path)` importable
- `python3 -c "from services.caveman_descriptions import generate_caveman_description; print('CAVE-01 import OK')"` → OK
- 10/10 sample files match pipe regex (verified directly): all pass
- `python3 -c "... ok=sum(1 for f in files if rx.match(generate_caveman_description(f))); print(f'{ok}/10 match pipe regex')"` → `10/10 match pipe regex`
- 29/29 tests in `tests/test_caveman_descriptions.py` pass: regex match, 500-char limit, segment structure, language detection, callable signature, fallback behavior
- Daemon wired: `grep -c 'generate_caveman_description' services/amauta-daemon.py` → 2 occurrences
- `grep -c 'description_fn=None' services/amauta-daemon.py` → 0 (placeholder fully replaced)
- `cave_description_fn = generate_caveman_description` confirmed live in amauta-daemon.py
- Integration tests: 8/8 pass in `tests/test_caveman_integration.py` (fact density + wiring)
- AST check: `services/caveman_descriptions.py` parses cleanly

**CAVE-01 verdict: PASS**

---

### CAVE-02: Grammar-Stripping of Agent Definitions — GAPS_FOUND

**Requirement:** Agent markdown files processed through grammar-stripping; articles, filler
words, hedging removed; output is valid markdown; character count reduced >= 30%.

**Evidence:**
- `services/grammar_strip.py` exists; `strip_grammar(text)` importable
- `python3 -c "from services.grammar_strip import strip_grammar; print('CAVE-02 import OK')"` → OK
- Behavioral tests: 12/17 pass — article removal, filler removal, hedging removal, preservation of code blocks / YAML / URLs / file paths all work correctly
- Compression ratio tests: 5/5 FAIL with documented divergence:
  - `agents/gsd-executor-backend.md`: 9833 → 9686 chars, ratio 0.985 (1.5% reduction)
  - `agents/gsd-checker.md`: 7933 → 7851 chars, ratio 0.990 (1.0% reduction)
  - `agents/gsd-researcher.md`: 8830 → 8729 chars, ratio 0.989 (1.1% reduction)
  - `agents/gsd-executor-general.md`: 9445 → 9285 chars, ratio 0.983 (1.7% reduction)
  - `agents/gsd-debugger.md`: 9564 → 9397 chars, ratio 0.983 (1.7% reduction)

**Root cause (documented in Plan 22-01 SUMMARY.md):**
Agent `.md` files are ~50-55% code blocks (bash, python), XML tags, and YAML frontmatter — all
preserved verbatim by spec. Only ~45-50% of characters are processable plain text. Articles +
fillers + hedging represent ~1.5% of total file characters. Achieving 30% total reduction would
require cutting ~56% of processable-text-only, which is unreachable with the plan's word lists.

**Divergence protocol compliance:** Properly surfaced. The executor committed 5 failing tests
with full root-cause documentation in assertion messages (not silently adjusted). Tests are
intentionally failing as the divergence report.

**Resolution paths available (Phase 22.1 or operator decision):**
- Option A: Expand stripping vocabulary to cover verbose markdown patterns / boilerplate sections
- Option B: Revise CAVE-02 metric to measure reduction on processable-text-only
- Option C: Revise threshold to reflect achievable compression (~5%) on dense technical files

**CAVE-02 verdict: GAPS_FOUND** (divergence properly surfaced; Phase 23 not blocked — depends
on CAVE-01 which is verified)

---

### CAVE-03: BM25 Retrieval MRR Benchmark — PASS

**Requirement:** BM25 MRR on compressed >= 95% of original MRR across 20 queries; no single
query drops > 2 rank positions.

**Evidence:**
- `tests/22-caveman-bm25.test.cjs` exists (451 LOC, inline BM25 implementation)
- 5/5 tests pass:
  - ground truth has exactly 20 queries
  - all expected_top3 files exist on disk
  - BM25 tokenizer produces non-empty tokens for all corpus files
  - compressed MRR >= 0.95 * original MRR
  - no single query drops > 2 rank positions
- 20-file corpus with both original (first 500 chars) and compressed (caveman) descriptions
- Node test runner exit code 0; duration 861ms

**CAVE-03 verdict: PASS**

---

### CAVE-04: Fact Density Measurement — PASS

**Requirement:** For 10 representative files, compressed 500-char descriptions contain >= 40%
more distinct technical facts (identifiers, relationships, constraints) than original 500-char
descriptions.

**Evidence:**
- `tests/fixtures/cave-04-fact-annotations.json` exists with exactly 10 entries
- All 10 entries satisfy `compressed_fact_count >= original_fact_count * 1.4`:
  - `services/context_validator.py`: 13 → 20 facts (1.54x)
  - `services/rpetd_context.py`: 14 → 20 facts (1.43x)
  - `services/caveman_descriptions.py`: 17 → 24 facts (1.41x)
  - `services/grammar_strip.py`: 13 → 19 facts (1.46x)
  - `services/amauta-daemon.py`: 10 → 21 facts (2.10x)
  - `get-shit-done/bin/gsd-amauta.cjs`: 9 → 16 facts (1.78x)
  - `get-shit-done/bin/gsd-rlm.cjs`: 9 → 17 facts (1.89x)
  - `get-shit-done/bin/gsd-memory.cjs`: 15 → 22 facts (1.47x)
  - `agents/gsd-executor-backend.md`: 20 → 28 facts (1.40x — tightest, exact boundary)
  - `tests/test_context_validator.py`: 14 → 21 facts (1.50x)
- Minimum ratio: 1.40 (gsd-executor-backend.md); average ratio: ~1.60x
- Integration tests: 8/8 pass in `tests/test_caveman_integration.py` (TestFactDensity class)

**CAVE-04 verdict: PASS**

---

## Quality Gates

| Gate | Check | Result |
|------|-------|--------|
| Gate 1 — Branch evidence | feat/* commits visible in git log (2557f15, 57eee36, 2c6cbcc) | PASS |
| Gate 2 — LEARNING block | Plan 22-01 SUMMARY.md documents placeholder-protection pattern and divergence documentation in test assertions | PASS |
| Gate 3 — Test evidence | Raw terminal output with counts above (49 pass, 5 fail Python; 5/5 Node) | PASS |
| Gate 4 — PR URL | Internal project (no GitHub remote); commits land directly on master — overridden via local-only project pattern | NOTE |

Gate 4 note: This project has no GitHub remote for PRs. All commits go directly to master.
This is the established pattern across all prior verified phases (Phases 20, 21, etc.).

---

## Regression Check

- Phase 21 tests: 20/20 pass (confirmed in Plan 22-01 SUMMARY.md)
- Full CJS suite: 2173 tests, 2160 pass, 11 fail — same 11 pre-existing failures as Phase 21
  baseline (confirmed in Plan 22-02 SUMMARY.md); 0 new failures introduced
- AST check: all 4 Python files (caveman_descriptions, grammar_strip, amauta-daemon,
  context_validator) parse cleanly

---

## Summary

| Requirement | Status |
|-------------|--------|
| CAVE-01 | PASS |
| CAVE-02 | GAPS_FOUND (divergence: 1.5% actual vs 30% target; properly documented) |
| CAVE-03 | PASS |
| CAVE-04 | PASS |

Phase 22 is functionally complete. The core capability (pipe-delimited descriptions, daemon
wiring, BM25 retrieval preservation, fact density improvement) is delivered and verified.
Phase 23 is unblocked — it depends on CAVE-01 (live), not CAVE-02.

The CAVE-02 gap requires an operator decision on resolution path (expand vocabulary, revise
metric definition, or revise threshold) before the compression ratio requirement can be closed.
