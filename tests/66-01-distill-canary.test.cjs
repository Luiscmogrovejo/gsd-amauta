'use strict';

// 66-01-02: Canary test — real merge group through cmdDistill via mock daemon.
// Proves claudeSummarize's dead-code fix (MEM-H1, missing child_process require)
// plus the co-located --max-tokens CLI-flag fix (authorized via divergence report
// TK-1755-2026-07-03T16-41-58Z.json, orchestrator_response: expand-scope) actually
// resurrect the Claude distill path end-to-end. Zero production writes: a local
// mock daemon on an ephemeral port serves a REAL merge group and captures the
// store/delete bodies gsd-memory.cjs's real `distill --use-llm` code path emits.
//
// Phase 88 plan 88-17 (ORC-05): this canary used to return early when no real `claude`
// was on PATH — a hidden skip in CI, and a real paid model call on a machine that has
// one. gsd-memory.cjs's distillation now goes through the shared runtime-llm helper, so
// the canary runs everywhere against a fake host-runtime CLI pinned with
// GSD_LLM_CLI_BIN, with no key and no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const GSD_MEMORY = path.resolve(__dirname, '../get-shit-done/bin/gsd-memory.cjs');

/**
 * Write the fake host-runtime CLI this canary now runs against, and return the
 * `GSD_LLM_CLI_BIN` value that launches it (plan 88-17, ORC-05).
 *
 * Until plan 88-17 this file probed for a REAL `claude` on PATH and returned early when
 * there was none. That was wrong in both directions: in CI, where no `claude` exists, it
 * was a hidden skip reported as a pass; on the operator's machine, where one does, the
 * canary made a real, paid model call from a unit test. gsd-memory.cjs's distillation now
 * goes through get-shit-done/bin/lib/runtime-llm.cjs, which honours `GSD_LLM_CLI_BIN`, so
 * the canary runs everywhere, deterministically, and calls nothing.
 *
 * The fake is a plain `.cjs` launched as `process.execPath <fake>.cjs` -- the one launch
 * form that works on every platform (a `.cmd` shim cannot be spawned without a shell).
 *
 * @param {string} dir directory to write the fake into
 * @returns {string} a JSON array suitable for GSD_LLM_CLI_BIN
 */
function writeFakeRuntimeCli(dir) {
  const file = path.join(dir, 'fake-claude.cjs');
  const summary =
    'Always verify migration numbers dynamically before authoring a new database file, '
    + 'script, draft, patch or diff.';
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    "try { fs.readFileSync(0, 'utf8'); } catch { /* the prompt arrives on stdin */ }",
    `process.stdout.write(JSON.stringify({ is_error: false, result: ${JSON.stringify(summary)}, usage: {} }));`,
    '',
  ].join('\n'));
  return JSON.stringify([process.execPath, file]);
}

// Five near-identical entries sharing a 9-word core (only the tail word
// differs per entry) so EVERY pairwise textSimilarity (gsd-memory.cjs :2026,
// Jaccard word-overlap on words > 2 chars) is 9/11 = 0.818 >= the 0.7
// grouping threshold, guaranteeing a single 5-entry group rather than a
// smaller subgroup + orphan. No metadata.what so they survive the
// structured-entry filter (gsd-memory.cjs :2198-2205); source
// 'session-learning' so they carry through the exclude_source=distilled
// list filter untouched.
function buildEntries() {
  const tails = ['file', 'script', 'draft', 'patch', 'diff'];
  return tails.map((tail, i) => ({
    id: 9001 + i,
    text: `always verify migration numbers dynamically before authoring new database ${tail}`,
    source: 'session-learning',
    agent_id: 'executor-backend',
    metadata: {},
  }));
}

function startMockDaemon(entries) {
  const stores = [];
  const deletes = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); } catch { parsed = null; }
      }

      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url.startsWith('/api/memory/list')) {
        res.writeHead(200);
        res.end(JSON.stringify({ results: entries, total: entries.length }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/memory/store') {
        stores.push(parsed);
        res.writeHead(200);
        res.end(JSON.stringify({ stored: true, id: 9100 }));
        return;
      }

      // MEMSAFE-03: distill removes a consumed original through the single
      // archive-then-delete call and requires exactly one row removed.
      if (req.method === 'POST' && req.url === '/api/memory/archive-delete') {
        deletes.push(parsed);
        res.writeHead(200);
        res.end(JSON.stringify({
          id: parsed.id, archived: 1, already_archived: false, deleted: 1, found: true,
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/memory/delete') {
        deletes.push(parsed);
        res.writeHead(200);
        res.end(JSON.stringify({ deleted: true }));
        return;
      }

      // Defensive catch-all for any other route the CLI might hit.
      res.writeHead(200);
      res.end(JSON.stringify({}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, stores, deletes });
    });
  });
}

test('66-01-02: real merge group through cmdDistill --use-llm reaches distill_strategy claude-*', async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-66-01-'));
  const fakeCli = writeFakeRuntimeCli(fakeDir);

  const entries = buildEntries();
  const { server, port, stores, deletes } = await startMockDaemon(entries);

  let stdout = '';
  let stderr = '';

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [GSD_MEMORY, 'distill', '--use-llm', '--confirm-destructive'],
        {
          env: {
            ...process.env,
            GSD_AMAUTA_HOST: '127.0.0.1',
            GSD_AMAUTA_PORT: String(port),
            // ORC-05: the host-runtime CLI is a fake, so this canary makes no model
            // call on any machine and needs no API key of any kind.
            GSD_LLM_CLI_BIN: fakeCli,
          },
        }
      );

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('distill --use-llm timed out after 120s'));
      }, 120000);

      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`distill --use-llm exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        } else {
          resolve();
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // (d) pre-fix failure signature must NOT reappear.
    assert.ok(
      !stderr.includes('Claude CLI (sonnet) unavailable: execSync is not defined'),
      `pre-fix ReferenceError signature reappeared in stderr:\n${stderr}`
    );

    // (a) exactly one store body captured; distill_strategy must be claude-*.
    assert.equal(stores.length, 1, `expected exactly 1 store body, got ${stores.length}`);
    const stored = stores[0];
    assert.ok(stored, 'captured store body was not valid JSON');
    const strategy = stored.metadata && stored.metadata.distill_strategy;
    assert.match(
      strategy || '',
      /^claude-(sonnet|haiku)$/,
      `distill_strategy was '${strategy}' — expected claude-sonnet or claude-haiku (NOT concatenation/ollama). stdout:\n${stdout}\nstderr:\n${stderr}`
    );

    // (b) merged text length + source.
    assert.ok(stored.text && stored.text.length >= 20, 'stored text shorter than 20 chars');
    assert.equal(stored.source, 'distilled');

    // (c) 5 deletes total (4 removed + 1 keep), all captured after the store.
    assert.equal(deletes.length, 5, `expected 5 deletes (4 removed + 1 keep), got ${deletes.length}`);

    console.log(`PASS: distill_strategy=${strategy} stores=${stores.length} deletes=${deletes.length}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
