'use strict';
// Generic (format-agnostic) fallback filter — FILT-06 (Phase 73).
//
// The last-resort compressor for noisy-but-unstructured commands (registered in
// 73-01-07 for a curated head list: npm/yarn/pnpm/pip/make/gradle/mvn/tsc/eslint).
// It is NOT a global catch-all: truly-unknown commands keep Phase 72's guaranteed
// `_passthrough` identity, because the engine has no wildcard head and Phase 73 is
// read-only on index.cjs.
//
// Two line-wise strategies:
//   1. dedup   — collapse runs of byte-identical lines to one representative + ` (×N)`.
//   2. truncate — if the (post-dedup) line count still exceeds CAP, keep HEAD + TAIL
//                 and elide the middle, BIAS-keeping any diagnostic line.
//
// Corruption invariant: representative lines and kept lines are emitted VERBATIM —
// never substring/trim/re-quote them. The only synthesized text is the ` (×N)`
// suffix, the elision marker, and the trailing escape-hatch line (all appended,
// never woven into a real line's bytes). NEVER throws; ALWAYS returns a string;
// raw-falls-back to `stdout` whenever compression would not help.

const MIN_LINES = 30; // below this, never bother — return raw.
const CAP = 200; // post-dedup line count that triggers middle-truncation.
const HEAD = 40; // lines kept from the top when truncating.
const TAIL = 40; // lines kept from the bottom when truncating.
// Diagnostic lines are never elided — keep them even in the truncated middle.
const BIAS = /error|fail|warning|panic|exception/i;
const ELIDE = (n) => `… ${n} lines elided (raw available) …`;
const ESCAPE_HATCH = '… output compressed (raw available) …';

/**
 * Compress noisy unstructured command output without corrupting any line.
 *
 * @param {string} stdout - Raw captured stdout. Non-strings coerce to '' (never throws).
 * @param {string} [stderr] - Unused; part of the shared filter contract signature.
 * @param {number} [code] - Unused; part of the shared filter contract signature.
 * @returns {string} Compressed output, or `stdout` verbatim when compression would not help.
 * @example
 *   transform(Array(300).fill('Downloading foo...').join('\n') + '\nerror: boom\n', '', 0)
 *   // => 'Downloading foo... (×300)\nerror: boom\n… output compressed (raw available) …\n'
 */
function transform(stdout /* , stderr, code */) {
  try {
    if (typeof stdout !== 'string') return '';
    if (stdout === '') return '';

    const hadTrailingNL = stdout.endsWith('\n');
    const lines = stdout.split('\n');
    if (hadTrailingNL) lines.pop(); // drop the empty element the trailing \n creates.

    // Below the size floor there is nothing worth compressing — return raw.
    if (lines.length < MIN_LINES) return stdout;

    // --- Strategy 1: dedup consecutive byte-identical runs ------------------
    const deduped = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let count = 1;
      while (i + 1 < lines.length && lines[i + 1] === line) {
        count++;
        i++;
      }
      // Representative emitted verbatim; ` (×N)` is an appended marker only.
      deduped.push(count > 1 ? `${line} (×${count})` : line);
    }

    // --- Strategy 2: middle-truncate, bias-keeping diagnostics --------------
    let out = deduped;
    if (deduped.length > CAP) {
      const head = deduped.slice(0, HEAD);
      const tail = deduped.slice(deduped.length - TAIL);
      const middle = deduped.slice(HEAD, deduped.length - TAIL);
      const kept = middle.filter((l) => BIAS.test(l)); // diagnostic lines survive.
      const elided = middle.length - kept.length;
      out = head.concat(kept, [ELIDE(elided)], tail);
    }

    let result = out.join('\n');
    if (hadTrailingNL) result += '\n';

    // Raw-fallback: if neither strategy actually shrank the payload, return raw.
    if (result.length >= stdout.length) return stdout;

    // Compression happened — append the escape-hatch line so the reader knows
    // the raw output is still recoverable.
    result += `${hadTrailingNL ? '' : '\n'}${ESCAPE_HATCH}\n`;
    return result;
  } catch {
    return typeof stdout === 'string' ? stdout : '';
  }
}

module.exports = { id: 'generic', match: () => true, transform };
