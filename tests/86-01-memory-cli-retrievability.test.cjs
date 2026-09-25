/**
 * TK-2386 — gsd-memory's write path reported success while storing nothing
 * retrievable. Four seams, one suite. Acceptance is RETRIEVABILITY, never an
 * exit code: store a text, then find it by a distinctive phrase from its own
 * body immediately afterwards.
 *
 * Measured 2026-09-13 against the daemon on 18799 (read-only probes):
 *   GET  /health              -> 200 {"status":"ok","pg_available":true,
 *                                     "pg_health":{"status":"error",
 *                                                  "error":"connection pool is closed"}}
 *   POST /api/memory/search   -> 500 {"error":"connection pool is closed"}
 * `gsd-memory health` printed "PG: connected" at rc 0 throughout.
 *
 * Every arm here runs against an in-process STUB daemon on an ephemeral port,
 * or against an unused port. No test in this file touches the real daemon
 * (18799), the RLM (18798), Redis, or any Postgres.
 *
 * The stub is faithful to amauta-daemon.py on the one behaviour that causes
 * the defect: `_resolve_project_id` (daemon line 1258) resolves
 * `body.get("project_id") or os.path.basename(os.getcwd())` — the basename of
 * the DAEMON's working directory, not the caller's. STUB_DAEMON_PROJECT below
 * stands in for that.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MEMORY_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

// Stands in for the daemon process's own CWD basename. Any value that is not
// the CLI caller's CWD basename reproduces the production asymmetry.
const STUB_DAEMON_PROJECT = 'stub-daemon-cwd';

// ═══════════════════════════════════════════════════════
// Stub daemon
// ═══════════════════════════════════════════════════════

/**
 * Start a stub amauta-daemon on an ephemeral port.
 *
 * @param {object} [opts]
 * @param {string} [opts.storeMode] 'ok' | 'dedup' | 'noop' | 'no_id' | 'error500'
 * @param {string} [opts.searchMode] 'ok' | 'error500'
 * @param {object} [opts.health] payload for GET /health
 * @returns {Promise<object>} handle with {port, rows, stores, searches, close()}
 */
async function startStubDaemon(opts = {}) {
  const storeMode = opts.storeMode || 'ok';
  const searchMode = opts.searchMode || 'ok';
  const state = {
    rows: [],      // every row the stub actually persisted
    stores: [],    // every store body the CLI actually sent (arming evidence)
    searches: [],  // every search body the CLI actually sent
    seq: 0,
  };

  const readBody = (req) => new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });

  const send = (res, status, payload) => {
    const s = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(s);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/health') {
      return send(res, 200, opts.health || {
        status: 'ok', pid: process.pid, pg_available: true,
        pg_health: { status: 'ok', dsn_host: '127.0.0.1' },
      });
    }

    // The write path calls this straight after a store. Always "no distill
    // needed": this suite must never be able to trigger a destructive merge.
    if (route === '/api/memory/distill-status') {
      return send(res, 200, { total: 0, needs_distill: false });
    }

    if (route === '/api/memory/store') {
      const body = await readBody(req);
      state.stores.push(body);
      if (storeMode === 'error500') {
        return send(res, 500, { error: 'connection pool is closed' });
      }
      // Faithful to amauta-daemon.py:1258 — the daemon's own CWD, not the caller's.
      const project_id = body.project_id || STUB_DAEMON_PROJECT;
      if (storeMode === 'dedup') {
        // amauta-daemon.py:2743 — 200 with no `id` key.
        return send(res, 200, {
          stored: false, dedup_skipped: true,
          existing_id: 'mem-deadbeefcafe', similarity: 0.97,
        });
      }
      if (storeMode === 'noop') {
        // amauta-daemon.py:2760 — 200, no row inserted, no `id` key.
        return send(res, 200, { stored: false, noop: true, existing_id: null });
      }
      const id = `mem-${String(++state.seq).padStart(12, '0')}`;
      if (storeMode === 'no_id') {
        // The unenumerated-sentinel branch: 200, stored:true, still no id.
        return send(res, 200, { stored: true, project_id });
      }
      state.rows.push({
        id,
        text: body.text,
        source: body.source,
        project_id,
        tags: body.tags || [],
        metadata: body.metadata || {},
      });
      return send(res, 200, { id, stored: true, embedded: false, project_id });
    }

    if (route === '/api/memory/search' || route === '/api/memory/semantic-search') {
      const body = await readBody(req);
      state.searches.push(body);
      if (searchMode === 'error500') {
        return send(res, 500, { error: 'connection pool is closed' });
      }
      const project_id = body.project_id || STUB_DAEMON_PROJECT;
      const needle = String(body.query || '').toLowerCase();
      const results = state.rows.filter((r) =>
        r.project_id === project_id &&
        (!body.source || r.source === body.source) &&
        r.text.toLowerCase().includes(needle)
      );
      return send(res, 200, { results, count: results.length });
    }

    return send(res, 404, { error: 'Unknown route' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Run the memory CLI against a given port, from a given CWD.
 * Never throws on a non-zero exit — the exit code is the measurement.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
async function runCli(args, { port, cwd, env = {} }) {
  try {
    const r = await execFileAsync(process.execPath, [MEMORY_CLI, ...args], {
      cwd,
      timeout: 20000,
      env: {
        ...process.env,
        GSD_AMAUTA_HOST: '127.0.0.1',
        GSD_AMAUTA_PORT: String(port),
        GSD_AMAUTA_NO_AUTO_START: '1',
        // Never let a test reach the real distill path.
        GSD_MEMORY_AUTO_DISTILL: '0',
        NO_COLOR: '1',
        ...env,
      },
    });
    return { code: 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

function makeProjectDir() {
  // A distinctive basename: this becomes the CLI-side project_id via
  // autoProjectId() = path.basename(process.cwd()).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk2386proj-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

// ═══════════════════════════════════════════════════════
// 1. Retrievability — the acceptance criterion
// ═══════════════════════════════════════════════════════

describe('TK-2386 retrievability: a stored text is findable by its own phrase', () => {
  let stub, projDir;

  before(async () => { stub = await startStubDaemon(); projDir = makeProjectDir(); });
  after(async () => {
    await stub.close();
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('store then search by a distinctive phrase finds the entry', async () => {
    const phrase = 'quetzalcoatl-ratchet-7731';
    const text = `A lane learning containing ${phrase} as its distinctive phrase.`;

    const stored = await runCli(['store', text, '--source', 'lesson-learned'], {
      port: stub.port, cwd: projDir,
    });
    assert.strictEqual(stored.code, 0, `store must succeed: ${stored.stderr}`);

    // ARMING: the verdict below is only meaningful if the CLI actually reached
    // the stub. A suite that never issued a store cannot read as green.
    assert.strictEqual(stub.state.stores.length, 1,
      'ARMING FAILURE: the CLI never sent a store to the stub daemon');
    assert.strictEqual(stub.state.rows.length, 1,
      'ARMING FAILURE: the stub persisted no row');

    const found = await runCli(['search', phrase, '--json'], {
      port: stub.port, cwd: projDir,
    });
    assert.strictEqual(found.code, 0, `search must succeed: ${found.stderr}`);

    const payload = JSON.parse(found.stdout);
    assert.strictEqual(payload.count, 1,
      `stored text must be retrievable by its own phrase immediately afterwards. ` +
      `store sent project_id=${JSON.stringify(stub.state.stores[0].project_id)}, ` +
      `search sent project_id=${JSON.stringify(stub.state.searches[0].project_id)} ` +
      `(undefined => the daemon substitutes its OWN cwd basename). stdout=${found.stdout}`);
    assert.ok(payload.results[0].text.includes(phrase));
  });

  test('search resolves project_id the same way store does', async () => {
    const expected = path.basename(projDir);
    const s = stub.state.stores[stub.state.stores.length - 1];
    const q = stub.state.searches[stub.state.searches.length - 1];
    assert.strictEqual(s.project_id, expected,
      'store must scope to the CALLER cwd basename');
    assert.strictEqual(q.project_id, expected,
      'search must scope to the same project store wrote to — a search that ' +
      'omits project_id is resolved against the DAEMON cwd (amauta-daemon.py:1258)');
  });

  test('semantic-search resolves project_id symmetrically too', async () => {
    const phrase = 'tlaloc-cistern-4402';
    await runCli(['store', `Another entry, ${phrase} inside.`, '--source', 'lesson-learned'], {
      port: stub.port, cwd: projDir,
    });
    const r = await runCli(['semantic-search', phrase, '--json'], {
      port: stub.port, cwd: projDir,
    });
    assert.strictEqual(r.code, 0, `semantic-search must succeed: ${r.stderr}`);
    const q = stub.state.searches[stub.state.searches.length - 1];
    assert.strictEqual(q.project_id, path.basename(projDir),
      'semantic-search must scope to the caller project, like store');
  });
});

// ═══════════════════════════════════════════════════════
// 2. `learn --source` must not be discarded
// ═══════════════════════════════════════════════════════

describe('TK-2386 learn honours --source / --tags / --project', () => {
  let stub, projDir;

  before(async () => { stub = await startStubDaemon(); projDir = makeProjectDir(); });
  after(async () => {
    await stub.close();
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('free-text learn forwards --source lesson-learned', async () => {
    const r = await runCli([
      'learn', 'LEARNING [tk2386]: a free-text learning body',
      '--source', 'lesson-learned',
      '--tags', 'category:verification,barerouter',
      '--project', 'barerouter',
    ], { port: stub.port, cwd: projDir });

    assert.strictEqual(r.code, 0, `learn must succeed: ${r.stderr}`);
    assert.strictEqual(stub.state.stores.length, 1,
      'ARMING FAILURE: the CLI never sent a store to the stub daemon');

    const body = stub.state.stores[0];
    assert.strictEqual(body.source, 'lesson-learned',
      `learn must not overwrite --source with auto_learning (got ${body.source})`);
    assert.strictEqual(body.project_id, 'barerouter',
      `learn must honour --project (got ${body.project_id})`);
    assert.ok(Array.isArray(body.tags) && body.tags.length > 0,
      `learn must forward --tags (got ${JSON.stringify(body.tags)})`);
  });

  test('free-text learn still defaults to auto_learning without --source', async () => {
    const r = await runCli(['learn', 'a learning with no explicit source'], {
      port: stub.port, cwd: projDir,
    });
    assert.strictEqual(r.code, 0, `learn must succeed: ${r.stderr}`);
    const body = stub.state.stores[stub.state.stores.length - 1];
    assert.strictEqual(body.source, 'auto_learning',
      'the documented default must be unchanged when --source is absent');
  });

  test('a lesson-learned entry is retrievable under --source lesson-learned', async () => {
    const phrase = 'huitzilin-beacon-9915';
    await runCli(['learn', `LEARNING: ${phrase} is the distinctive phrase`,
      '--source', 'lesson-learned'], { port: stub.port, cwd: projDir });

    const r = await runCli(['search', phrase, '--source', 'lesson-learned', '--json'], {
      port: stub.port, cwd: projDir,
    });
    assert.strictEqual(r.code, 0, `search must succeed: ${r.stderr}`);
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.count, 1,
      `a learning stored with --source lesson-learned must be retrievable with ` +
      `--source lesson-learned. stdout=${r.stdout}`);
  });
});

// ═══════════════════════════════════════════════════════
// 3. Never "Stored undefined"
// ═══════════════════════════════════════════════════════

describe('TK-2386 the write path never reports an undefined id', () => {
  test('a dedup-skipped 200 names the existing id, never "undefined"', async () => {
    const stub = await startStubDaemon({ storeMode: 'dedup' });
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['store', 'a duplicate body', '--source', 'lesson-learned'], {
        port: stub.port, cwd: projDir,
      });
      assert.strictEqual(stub.state.stores.length, 1,
        'ARMING FAILURE: the CLI never sent a store to the stub daemon');
      assert.ok(!/Stored\s+undefined/.test(r.stdout + r.stderr),
        `must never print "Stored undefined": stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(/mem-deadbeefcafe/.test(r.stdout + r.stderr),
        `must name the existing mem-id the caller should cite: ${r.stdout}${r.stderr}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('a no-op 200 (nothing landed) exits non-zero rather than claiming a store', async () => {
    const stub = await startStubDaemon({ storeMode: 'noop' });
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['store', 'a body that no-ops', '--source', 'lesson-learned'], {
        port: stub.port, cwd: projDir,
      });
      assert.strictEqual(stub.state.stores.length, 1,
        'ARMING FAILURE: the CLI never sent a store to the stub daemon');
      assert.notStrictEqual(r.code, 0,
        `nothing was stored, so the write must not report success: ` +
        `code=${r.code} stdout=${r.stdout}`);
      assert.ok(!/Stored\s+undefined/.test(r.stdout + r.stderr),
        `must never print "Stored undefined": ${r.stdout}${r.stderr}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('a 200 with stored:true but no id exits non-zero', async () => {
    const stub = await startStubDaemon({ storeMode: 'no_id' });
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['learn', 'a body whose id never comes back'], {
        port: stub.port, cwd: projDir,
      });
      assert.notStrictEqual(r.code, 0,
        `an id-less success is not a success the caller can cite: code=${r.code}`);
      assert.ok(!/Stored\s+undefined/.test(r.stdout + r.stderr),
        `must never print "Stored undefined": ${r.stdout}${r.stderr}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════
// 4. Degradation refuses at a non-zero exit, naming the degradation
// ═══════════════════════════════════════════════════════

describe('TK-2386 a degraded memory CLI refuses instead of reporting success', () => {
  const UNUSED_PORT = 59999;

  test('daemon unreachable: store refuses at non-zero and names the degradation', async () => {
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['store', 'text written while the daemon is down'], {
        port: UNUSED_PORT, cwd: projDir,
      });
      assert.notStrictEqual(r.code, 0,
        `a write that did not reach the store must not exit 0: stdout=${r.stdout}`);
      assert.ok(/unreachable/i.test(r.stderr),
        `stderr must name the degradation class: ${r.stderr}`);
      assert.ok(/file mode/i.test(r.stderr),
        `stderr must name the opt-in that would restore file mode: ${r.stderr}`);
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('daemon unreachable: search refuses at non-zero (never a file-mode answer at rc 0)', async () => {
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['search', 'anything at all'], {
        port: UNUSED_PORT, cwd: projDir,
      });
      assert.notStrictEqual(r.code, 0,
        `a search answered from .planning files is not an answer from memory: ` +
        `code=${r.code} stdout=${r.stdout}`);
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('daemon 500: refuses at non-zero and does NOT claim PG is down', async () => {
    const stub = await startStubDaemon({ searchMode: 'error500' });
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['search', 'a query the daemon 500s on'], {
        port: stub.port, cwd: projDir,
      });
      assert.notStrictEqual(r.code, 0, `a 500 is not a result: stdout=${r.stdout}`);
      assert.ok(/500/.test(r.stderr), `stderr must name the status: ${r.stderr}`);
      assert.ok(!/PG unavailable/i.test(r.stderr),
        `a 5xx is a route-handler exception, not proof PG is down: ${r.stderr}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('a refused write leaves the caller repository untouched', async () => {
    // Measured 2026-09-13 by the orchestrator: with PG down, `gsd-memory learn`
    // fell back to file mode and appended a "## Learnings" section to
    // .planning/STATE.md IN THE CALLER'S CURRENT DIRECTORY — a tracked file in
    // a read-only primary checkout. The silent degrade did not merely lose the
    // write; it wrote somewhere nobody asked it to. The default path must
    // touch nothing.
    const projDir = makeProjectDir();
    const statePath = path.join(projDir, '.planning', 'STATE.md');
    const memDir = path.join(projDir, '.planning', 'memory');
    fs.writeFileSync(statePath, '# Amauta State\n\n## Learnings\n');
    const before = fs.readFileSync(statePath, 'utf-8');
    try {
      const r = await runCli(['learn', 'a learning written while PG is down'], {
        port: UNUSED_PORT, cwd: projDir,
      });
      assert.notStrictEqual(r.code, 0, 'the write must be refused');
      assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before,
        'a refused write must not append to the caller\'s .planning/STATE.md');
      assert.ok(!fs.existsSync(memDir),
        'a refused write must not create .planning/memory in the caller repo');
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('file mode still works, but only behind the explicit opt-in', async () => {
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['store', 'deliberate offline entry'], {
        port: UNUSED_PORT, cwd: projDir,
        env: { GSD_MEMORY_FILE_MODE: '1' },
      });
      assert.strictEqual(r.code, 0,
        `the opt-in must preserve the offline file-mode path: ${r.stderr}`);
      assert.ok(/file mode/i.test(r.stdout + r.stderr), 'must still say file mode');
      const memDir = path.join(projDir, '.planning', 'memory');
      assert.ok(fs.existsSync(memDir), 'file-mode store must still write the file');
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. health must not report a degraded PG as connected
// ═══════════════════════════════════════════════════════

describe('TK-2386 health reports the PG pool honestly', () => {
  test('daemon ok + pool closed => non-zero, and does not print "connected"', async () => {
    // The exact /health payload measured on 18799 on 2026-09-13.
    const stub = await startStubDaemon({
      health: {
        status: 'ok', pid: 81360, pg_available: true, backend: 'postgresql',
        pg_health: { status: 'error', error: 'connection pool is closed' },
      },
    });
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['health'], { port: stub.port, cwd: projDir });
      const all = r.stdout + r.stderr;
      assert.notStrictEqual(r.code, 0,
        `health must not exit 0 while every memory call 500s: stdout=${r.stdout}`);
      assert.ok(!/PG:\s+connected/.test(r.stdout),
        `health must not print "PG: connected" off the startup-time flag: ${r.stdout}`);
      assert.ok(/connection pool is closed/.test(all),
        `health must surface the daemon's own pg_health error: ${all}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('daemon ok + pool ok => exit 0 and reports connected', async () => {
    const stub = await startStubDaemon();
    const projDir = makeProjectDir();
    try {
      const r = await runCli(['health'], { port: stub.port, cwd: projDir });
      assert.strictEqual(r.code, 0, `a healthy daemon must still pass: ${r.stderr}`);
      assert.ok(/connected/.test(r.stdout), `should report connected: ${r.stdout}`);
    } finally {
      await stub.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });
});
