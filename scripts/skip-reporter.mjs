/**
 * A `node --test` reporter that records every SKIPPED or TODO test as one JSON
 * line, for `scripts/skip-gate.cjs` to match against `tests/skip-exceptions.json`
 * (plan 88-19, FND-04).
 *
 * WHY A CUSTOM REPORTER AND NOT TAP — measured in task 88-19-01 on Node v20.19.0,
 * v22.22.3 and v25.8.1:
 *
 *   TAP carries NO file attribution on a multi-file run. `node --test a b` emits one
 *   flat plan in which no subtest names a file, so a TAP parser can recover
 *   `(name, reason)` but never `file` — and the gate's match key is
 *   `(file, name, platform)`. The reporter event stream, by contrast, carries
 *   `data.file` on every event on all three interpreters, plus `data.skip` (the reason,
 *   or `true`) and `data.details.type === 'suite'`.
 *
 * The human reporter is NOT replaced: `scripts/run-tests.cjs` passes
 * `--test-reporter=spec --test-reporter-destination=stdout` alongside this one, so the
 * terminal still shows per-test output.
 *
 * Output: one JSON object per line, `{kind, file, name, reason}` where `kind` is
 * `skip`, `suite-skip`, `todo` or `suite-todo`. Nothing else is written, so an empty
 * file means "nothing skipped" and a MISSING file means the reporter never ran, which
 * the gate treats as a failure rather than as a pass.
 *
 * @param {AsyncIterable<{type: string, data: object}>} source the test event stream
 * @yields {string} one JSON line per skipped or todo test
 * @example
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *        --test-reporter=file:///repo/scripts/skip-reporter.mjs \
 *        --test-reporter-destination=/run/skips.jsonl tests/a.test.cjs
 */
export default async function* skipReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data || {};
    const skipped = data.skip !== undefined && data.skip !== false;
    const todo = data.todo !== undefined && data.todo !== false;
    if (!skipped && !todo) continue;
    const suite = Boolean(data.details && data.details.type === 'suite');
    const marker = skipped ? 'skip' : 'todo';
    const reason = skipped ? data.skip : data.todo;
    yield `${JSON.stringify({
      kind: suite ? `suite-${marker}` : marker,
      file: typeof data.file === 'string' ? data.file : '',
      name: typeof data.name === 'string' ? data.name : '',
      reason: typeof reason === 'string' ? reason : '',
    })}\n`;
  }
}
