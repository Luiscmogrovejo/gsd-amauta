'use strict';

// 66-01-02: Canary test — real merge group through cmdDistill via mock daemon.
// Proves claudeSummarize's dead-code fix (MEM-H1, missing child_process require)
// plus the co-located --max-tokens CLI-flag fix (authorized via divergence report
// TK-1755-2026-07-03T16-41-58Z.json, orchestrator_response: expand-scope) actually
// resurrect the Claude distill path end-to-end. Zero production writes: a local
// mock daemon on an ephemeral port serves a REAL merge group and captures the
// store/delete bodies gsd-memory.cjs's real `distill --use-llm` code path emits.
//
// SKIPs cleanly (exit 0) when the `claude` CLI is unavailable — never a false
// red in CI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const GSD_MEMORY = path.resolve(__dirname, '../get-shit-done/bin/gsd-memory.cjs');

function claudeCliAvailable() {
  try {
    execSync('claude --version', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    return true;
  } catch {
    return false;
  }
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
  if (!claudeCliAvailable()) {
    console.log('SKIP: claude CLI unavailable — canary requires a Claude Code session');
    return;
  }

  const entries = buildEntries();
  const { server, port, stores, deletes } = await startMockDaemon(entries);

  let stdout = '';
  let stderr = '';

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [GSD_MEMORY, 'distill', '--use-llm'],
        {
          env: {
            ...process.env,
            GSD_AMAUTA_HOST: '127.0.0.1',
            GSD_AMAUTA_PORT: String(port),
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
