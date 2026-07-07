'use strict';

// Behavioral suite for Phase 76 Discipline Integration (plan 76-01, task 76-01-04).
// Proves all three DISC success criteria end-to-end: the validator/FIDEL/gates make a
// discipline decision on the RAW side-channel, never on the compressed summary, and the
// raw side-channel is itself scrubbed (single registry, scrub-last).
//
//   DISC-01  readers read raw, never compressed: a TEST_EVIDENCE check that FAILS on the
//            compressed summary PASSES on the resolved raw (the decision provably flips).
//   DISC-02  evidence_scrub runs LAST and also scrubs the raw side-channel file in place,
//            reusing the single evidence-scrub-patterns.json registry (no third copy).
//   DISC-03  compression is bypassed on the evidence path: the wrapper emits a resolvable
//            [gsd-compress:raw-ref <path>] marker only when it ACTUALLY compressed, so the
//            discipline decision is made on raw, not lossy, output.
//
// Idioms mirror tests/72-01-compress-engine.test.cjs and tests/68-evidence-scrub-node.test.cjs:
// node:test + node:assert/strict, fs.mkdtempSync tmp dirs, cleanup in try/finally, and no
// timing primitives (fully deterministic). The CLI is require-safe (precedent: 68-evidence-scrub).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const channel = require(path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'evidence-raw-channel.cjs'));
const cli = require(path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs'));
const wrapper = require(path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-compress.cjs'));

// A well-formed github token (ghp_ + 36 base62 chars) matching the single-registry
// github-token pattern (evidence-scrub-patterns.json) -> redacted as [scrubbed:github-token].
const GHP = 'ghp_0123456789012345678901234567890123456';
const REDACTED = '[scrubbed:github-token]';

// Run a body with an isolated side-channel dir; always restore env + delete the dir.
function withChannelDir(body) {
  const prev = process.env.GSD_COMPRESS_RAW_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '76-01-'));
  process.env.GSD_COMPRESS_RAW_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (prev === undefined) delete process.env.GSD_COMPRESS_RAW_DIR;
    else process.env.GSD_COMPRESS_RAW_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hasEvidence = (s) => cli.TEST_EVIDENCE_PATTERNS.some((p) => p.test(s));

// DISC-03 + DISC-01: the validator reads raw; the discipline decision flips FALSE -> TRUE.
test('DISC-03/DISC-01: compressed summary hides evidence; resolved raw restores it and flips the gate', () => {
  withChannelDir((dir) => {
    const rawPath = channel.writeRawChannel('node', ['--test'], 'ok\n5 passing\n', '', dir);
    assert.ok(rawPath, 'writeRawChannel must seed a side-channel file');

    // A compressed-looking T-phase blob: NO test-evidence pattern survives the summary,
    // but it carries the raw-ref marker back to its raw form.
    const compressed = 'test run summary: build ok (x3)\n' + channel.formatRawRef(rawPath);
    assert.equal(hasEvidence(compressed), false,
      'a gate on the compressed summary MUST miss the test evidence (DISC-01 hazard)');

    // The validator read-path resolves the marker to raw before judging.
    const resolved = cli.resolveRawEvidence(compressed);
    assert.ok(resolved.includes('5 passing'), 'resolveRawEvidence must splice the raw stdout back in');
    assert.equal(hasEvidence(resolved), true,
      'the discipline decision is provably made on RAW, not lossy, output (DISC-01/DISC-03)');
  });
});

// DISC-02: the raw side-channel is scrubbed in place AND the returned text is redacted.
test('DISC-02: a secret in the raw side-channel is redacted in both the returned text and the on-disk file', () => {
  withChannelDir((dir) => {
    const rawPath = channel.writeRawChannel('pytest', [], 'run ' + GHP + ' done\n', '', dir);
    const text = 'summary\n' + channel.formatRawRef(rawPath);

    const out = cli.resolveRawEvidence(text);
    assert.ok(out.includes(REDACTED), 'returned text must contain [scrubbed:github-token]');
    assert.ok(!out.includes(GHP), 'returned text must NOT contain the raw token');

    const onDisk = fs.readFileSync(rawPath, 'utf8');
    assert.ok(onDisk.includes(REDACTED), 'on-disk side-channel must be scrubbed in place (DISC-02)');
    assert.ok(!onDisk.includes(GHP), 'on-disk side-channel must NOT retain the raw token');
  });
});

// DISC-02: scrubEvidence runs LAST — a secret living only in the compressed summary
// (not in the raw file) is still redacted by the trailing scrub.
test('DISC-02: scrub-last catches a secret present only in the compressed summary', () => {
  withChannelDir((dir) => {
    const rawPath = channel.writeRawChannel('go', ['test'], 'clean output ok\n', '', dir);
    const text = 'leaked ' + GHP + ' in summary\n' + channel.formatRawRef(rawPath);

    // Simulate the cmdRpetd choke-point order: resolve (splice raw + scrub file) THEN scrub-last.
    const stored = cli.scrubEvidence(cli.resolveRawEvidence(text));
    assert.ok(stored.includes(REDACTED), 'scrub-last must redact the summary-only secret');
    assert.ok(!stored.includes(GHP), 'no raw token may survive to storage');
  });
});

// Fail-safe: no marker is a byte-identical no-op; a missing raw file never throws.
test('DISC fail-safe: no-marker passthrough is byte-identical; missing raw file yields UNRESOLVED without throwing', () => {
  const plain = 'plain evidence, no marker';
  assert.equal(cli.resolveRawEvidence(plain), plain, 'no marker => byte-identical passthrough');

  let out;
  assert.doesNotThrow(() => {
    out = cli.resolveRawEvidence('x ' + channel.formatRawRef('/no/such/file.raw'));
  }, 'an unresolvable marker must never throw');
  assert.ok(/UNRESOLVED/.test(out),
    'a missing raw file must leave a visible UNRESOLVED note (a gate never silently judges lossy output)');
});

// DISC-03 (wrapper unit): rawRefLine emits the marker only when compression actually occurred.
test('DISC-03: wrapper emits the raw-ref marker on real compression, nothing on --raw or identity', () => {
  withChannelDir(() => {
    const onCompress = wrapper.rawRefLine(false, 'small', 'a much longer raw output blob here', '', 'node', ['--test'], null);
    assert.ok(/\[gsd-compress:raw-ref /.test(onCompress),
      'a genuinely compressed command must emit a resolvable marker (DISC-03)');

    assert.equal(wrapper.rawRefLine(true, 'small', 'a much longer raw blob', '', 'node', ['--test'], null), '',
      '--raw bypass emits NO marker (TOGL-04)');
    assert.equal(wrapper.rawRefLine(false, 'same', 'same', '', 'ls', [], null), '',
      'identity passthrough emits NO marker (output is already raw)');
  });
});
