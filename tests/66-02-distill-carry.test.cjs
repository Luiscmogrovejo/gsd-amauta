'use strict';

// 66-02-05: mock-daemon proof that gsd-memory.cjs's distill pipeline carries
// citation signal forward across a merge (MEM-M4) and paginates eligibility
// beyond the old newest-1000 cap (MEM-L3). Deterministic — runs plain
// `distill` (no --use-llm), so distillStrategy is always 'concatenation' and
// no `claude` CLI is required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const GSD_MEMORY = path.resolve(__dirname, '../get-shit-done/bin/gsd-memory.cjs');

function startMockDaemon(entries) {
  const stores = [];
  const deletes = [];
  const requestedUrls = [];

  const server = http.createServer((req, res) => {
    requestedUrls.push(req.url);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); } catch { parsed = null; }
      }

      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url.startsWith('/api/memory/list')) {
        const u = new URL(req.url, 'http://localhost');
        const limit = parseInt(u.searchParams.get('limit') || '50', 10);
        const offset = parseInt(u.searchParams.get('offset') || '0', 10);
        const page = entries.slice(offset, offset + limit);
        res.writeHead(200);
        res.end(JSON.stringify({ results: page, total: entries.length }));
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

      res.writeHead(200);
      res.end(JSON.stringify({}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, stores, deletes, requestedUrls });
    });
  });
}

function runDistill(port, extraArgs = []) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(
      process.execPath,
      [GSD_MEMORY, 'distill', ...extraArgs],
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
      reject(new Error('distill timed out after 60s'));
    }, 60000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Five near-identical entries sharing a 9-word core (same fixture pattern as
// tests/66-01-distill-canary.test.cjs) so pairwise textSimilarity is
// 9/11 = 0.818 >= the 0.7 grouping threshold, guaranteeing a single 5-entry
// group. Two entries carry applied_count (3 and 4) and metadata.citations —
// the rest carry neither, proving the carry logic sums/unions rather than
// requiring every entry to have the fields.
function buildCarryEntries() {
  const tails = ['file', 'script', 'draft', 'patch', 'diff'];
  return tails.map((tail, i) => ({
    id: 9001 + i,
    text: `always verify migration numbers dynamically before authoring new database ${tail}`,
    source: i < 2 ? 'session-learning' : 'auto_learning',
    agent_id: 'executor-backend',
    applied_count: i === 0 ? 3 : (i === 1 ? 4 : 0),
    metadata: i === 0
      ? { citations: [{ task_id: 'TK-A' }] }
      : (i === 1 ? { citations: [{ task_id: 'TK-A' }, { task_id: 'TK-B' }] } : {}),
  }));
}

test('66-02-05: distill mergeBody carries applied_count sum + merged_sources + deduped citations', async () => {
  const entries = buildCarryEntries();
  const { server, port, stores, deletes } = await startMockDaemon(entries);

  try {
    const { code, stdout, stderr } = await runDistill(port);
    assert.equal(code, 0, `distill exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    assert.equal(stores.length, 1, `expected exactly 1 store body, got ${stores.length}`);
    const stored = stores[0];
    assert.ok(stored, 'captured store body was not valid JSON');

    // (a) applied_count sum: 3 + 4 + 0 + 0 + 0 === 7
    assert.equal(stored.applied_count, 7, `expected applied_count === 7, got ${stored.applied_count}`);

    // (b) merged_sources contains each distinct source string from the group
    assert.ok(Array.isArray(stored.metadata.merged_sources), 'metadata.merged_sources must be an array');
    const sources = new Set(stored.metadata.merged_sources);
    assert.ok(sources.has('session-learning'), 'merged_sources missing session-learning');
    assert.ok(sources.has('auto_learning'), 'merged_sources missing auto_learning');
    assert.equal(sources.size, 2, `expected exactly 2 distinct sources, got ${JSON.stringify(stored.metadata.merged_sources)}`);

    // (c) citations deduped to exactly TK-A + TK-B (union of [TK-A] and [TK-A, TK-B])
    assert.ok(Array.isArray(stored.metadata.citations), 'metadata.citations must be an array');
    const taskIds = stored.metadata.citations.map((c) => c.task_id).sort();
    assert.deepEqual(taskIds, ['TK-A', 'TK-B'], `expected deduped [TK-A, TK-B], got ${JSON.stringify(taskIds)}`);

    // (d) source stays 'distilled' — DATA-03 re-merge exclusion contract intact
    assert.equal(stored.source, 'distilled');

    // (e) 5 deletes total (4 removed + 1 keep)
    assert.equal(deletes.length, 5, `expected 5 deletes, got ${deletes.length}`);

    console.log(`PASS: applied_count=${stored.applied_count} merged_sources=${JSON.stringify(stored.metadata.merged_sources)} citations=${JSON.stringify(taskIds)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('66-02-05: distill eligibility pagination reaches offset=500 on a 501-row corpus', async () => {
  const entries = [];
  for (let i = 0; i < 501; i++) {
    entries.push({
      id: `mem-page-${i}`,
      text: `unrelated distinct entry number ${i} zz${i}`,
      source: 'session-learning',
      agent_id: 'x',
      applied_count: 0,
      metadata: {},
    });
  }
  const { server, port, requestedUrls } = await startMockDaemon(entries);

  try {
    // --dry-run: no store/delete calls needed to prove the pagination request
    // shape reached the daemon; this fixture's entries are all distinct
    // (no duplicate groups), so dry-run also keeps this test fast.
    const { code, stdout, stderr } = await runDistill(port, ['--dry-run']);
    assert.equal(code, 0, `distill --dry-run exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    const hasOffset500 = requestedUrls.some((u) => u.includes('offset=500'));
    assert.ok(
      hasOffset500,
      `expected an offset=500 request on a 501-row corpus; got URLs:\n${requestedUrls.join('\n')}`
    );

    console.log(`PASS: requested ${requestedUrls.length} list page(s), reached offset=500`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
