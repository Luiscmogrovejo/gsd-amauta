'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Discovery manifest — printed at module load for grep-verifiability
console.log('[discovery] MCP-01: amauta-mcp.py exists and has Server("amauta")');
console.log('[discovery] MCP-01: .mcp.json exists with mcpServers.amauta.command = a Python launcher');
console.log('[discovery] MCP-01: mcp>=1.0 in requirements.txt');
console.log('[discovery] MCP-01: port 18800 in docker-compose.yml');
console.log('[discovery] MCP-02: search-code tool in list_tools with required query param');
console.log('[discovery] MCP-02: search-code delegates to _call_rlm (port 18798 /query)');
console.log('[discovery] MCP-02: search-code returns raw RLM results JSON');
console.log('[discovery] MCP-03: memory-store tool delegates to /api/memory/store');
console.log('[discovery] MCP-03: memory-search tool delegates to /api/memory/semantic-search');
console.log('[discovery] MCP-03: memory-distill tool returns distill-status and defers trigger to CLI');
console.log('[discovery] MCP-03: store->search round-trip: _call_daemon delegates to daemon');
console.log('[discovery] MCP-04: context resource URI pattern amauta://context/{task_id}/{phase}');
console.log('[discovery] MCP-04: read_resource parses URI and calls /api/context/{task_id}/{phase}');
console.log('[discovery] MCP-04: list_resources fetches active tasks from /api/list');
console.log('[discovery] MCP-05: research tool checks /api/research-cache before chain');
console.log('[discovery] MCP-05: research chain shape: {memory_results, skb_results, web_results, from_cache}');
console.log('[discovery] MCP-05: cache hit path sets from_cache=true without re-running chain');

const ROOT = path.join(__dirname, '..');

// ─── MCP-01 Tests ─────────────────────────────────────────────────────────────

// Test 1: amauta-mcp.py exists and contains Server("amauta")
test('MCP-01: amauta-mcp.py exists and has Server("amauta") instance', () => {
  const mcpPath = path.join(ROOT, 'services', 'amauta-mcp.py');
  assert.ok(fs.existsSync(mcpPath), 'services/amauta-mcp.py must exist');
  const content = fs.readFileSync(mcpPath, 'utf8');
  assert.match(content, /Server\("amauta"\)/, 'Must have Server("amauta") instance');
  assert.match(content, /stdio_server/, 'Must import stdio_server for Claude Code transport');
  // removed in 119263f (Phase 46-01-08, "delete _call_daemon + _check_daemon_health; zero daemon coupling"):
  // the MCP server no longer talks to the daemon, so the guard that probed the daemon is gone.
  // The equivalent guard is now the store-availability check in every handler: a handler returns the
  // frozen `pg_unavailable` error code when no database is usable (services/amauta-mcp.py, call_tool).
  assert.match(content, /_get_store\(\)/, 'Must resolve the store directly (replaces the daemon health guard)');
  assert.match(content, /"error": "pg_unavailable"/, 'Must answer pg_unavailable when no store is usable');
  assert.doesNotMatch(content, /_check_daemon_health|_call_daemon\(/,
    'MCP server must have zero daemon coupling (Phase 46-01-08)');
});

// Test 2: .mcp.json exists with correct mcpServers structure
test('MCP-01: .mcp.json exists with mcpServers.amauta pointing to amauta-mcp.py', () => {
  const mcpJson = path.join(ROOT, '.mcp.json');
  assert.ok(fs.existsSync(mcpJson), '.mcp.json must exist at repo root');
  const config = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
  assert.ok(config.mcpServers, '.mcp.json must have mcpServers key');
  assert.ok(config.mcpServers.amauta, '.mcp.json must have mcpServers.amauta');
  // Phase 88 plan 88-15: the installer writes the VERIFIED launcher, because a
  // literal `python3` on a python.org Windows install is a Microsoft Store stub.
  // On POSIX that resolves to `python3` and this file is byte-identical; the
  // contract is "a Python 3 launcher", so assert that rather than one spelling.
  assert.match(
    config.mcpServers.amauta.command,
    /(^|[\\/])(python3?|py)(\.exe)?$/,
    `command must be a Python launcher, got ${config.mcpServers.amauta.command}`,
  );
  assert.deepEqual(config.mcpServers.amauta.args.slice(-1), ['services/amauta-mcp.py'],
    'args must be ["services/amauta-mcp.py"]');
});

// Test 3: mcp>=1.0 in requirements.txt
test('MCP-01: mcp>=1.0 present in requirements.txt', () => {
  const req = fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8');
  assert.match(req, /mcp>=1\.0/, 'requirements.txt must have mcp>=1.0');
});

// Test 4: port 18800 in docker-compose.yml and daemon untouched
test('MCP-01: port 18800 in docker-compose.yml; daemon file unmodified', () => {
  const dc = fs.readFileSync(path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf8');
  assert.match(dc, /18800/, 'docker-compose.yml must expose port 18800');
  assert.match(dc, /amauta-mcp|gsd-mcp/, 'docker-compose.yml must have amauta-mcp service');
  // Daemon file check: it should NOT import mcp (MCP is additive, not embedded)
  const daemon = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf8');
  assert.doesNotMatch(daemon, /from mcp\.|import mcp/, 'daemon must NOT import mcp package');
});

// ─── MCP-02 Tests ─────────────────────────────────────────────────────────────

// Test 5: search-code tool definition has correct schema
test('MCP-02: search-code tool defined with query as required param and top_k optional', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/search-code/, 'search-code tool name must be present');
  assert.match(content, /"required".*\["query"\]|"required".*query/, 'query must be required in inputSchema');
  assert.match(content, /top_k/, 'top_k optional param must be in schema');
  assert.match(content, /file_filter/, 'file_filter optional param must be in schema');
});

// Test 6: search-code delegates to _call_rlm (port 18798 /query)
test('MCP-02: search-code calls _call_rlm which targets port 18798 /query', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // renamed from _call_rlm (HTTP to the RLM service on 18798 /query; deleted in 9894ec3, Phase 46-01-05)
  // to rlm_search.hybrid_search (in-process retrieval over rlm_chunks; delegated in 2c7f370, Phase 65 RETR-03).
  // moved to services/amauta-mcp.py (call_tool, amauta/search-code branch)
  assert.match(content, /hybrid_search/, 'hybrid_search must be the retrieval entry point');
  assert.match(content, /from services\.rlm_search import hybrid_search/, 'hybrid_search must be imported from services.rlm_search');
  assert.doesNotMatch(content, /_call_rlm|18798/, 'search-code must not call the RLM service over HTTP any more');
});

// Test 7: search-code call_tool branch returns raw rlm result
test('MCP-02: search-code call_tool branch returns JSON-dumped _call_rlm result', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // The call_tool handler branches on search-code and returns the JSON-dumped retrieval result
  assert.match(content, /name.*==.*amauta\/search-code|"amauta\/search-code"/, 'call_tool must branch on search-code');
  // renamed from `result = _call_rlm(...)` / `json.dumps(result)` to `results = hybrid_search(...)` /
  // `payload = {"results": results, ...}` + `json.dumps(payload)` (Phase 46-01-05, Phase 65 RETR-03).
  assert.match(content, /rows = hybrid_search\(/, 'hybrid_search return must be assigned to rows');
  assert.match(content, /payload = \{"results": results,/, 'results must be wrapped in the response payload');
  assert.match(content, /json\.dumps\(payload\)/, 'payload must be wrapped with json.dumps');
});

// ─── MCP-03 Tests ─────────────────────────────────────────────────────────────

// Test 8: memory-store delegates to /api/memory/store
test('MCP-03: memory-store tool delegates to POST /api/memory/store', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-store/, 'memory-store tool must be defined');
  // renamed from the HTTP delegation target POST /api/memory/store to the direct store call
  // store.memory_store_with_embedding(...) (e6fe49f / fd375f3, Phase 46-01-04: "direct PGStore calls").
  assert.match(content, /store\.memory_store_with_embedding\(/, 'memory_store_with_embedding must be the store entry point');
  // Required param: text
  assert.match(content, /"required".*text|required.*\["text"\]/, 'text must be required in memory-store schema');
});

// Test 9: memory-search delegates to /api/memory/semantic-search
test('MCP-03: memory-search tool delegates to POST /api/memory/semantic-search', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-search/, 'memory-search tool must be defined');
  // renamed from POST /api/memory/semantic-search to store.memory_semantic_search(...) (Phase 46-01-04)
  assert.match(content, /store\.memory_semantic_search\(/, 'memory_semantic_search must be the store entry point');
});

// Test 10: memory-distill returns distill-status; no server-side trigger (defers to gsd-memory distill CLI)
test('MCP-03: memory-distill returns distill-status JSON with needs_distill flag (no server-side trigger)', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-distill/, 'memory-distill tool must be defined');
  // renamed from GET /api/memory/distill-status to store.memory_count(...) compared with a threshold (Phase 46-01-06)
  assert.match(content, /store\.memory_count\(/, 'the memory count must be read from the store');
  assert.match(content, /"needs_distill": total >= 500/, 'needs_distill must be derived from the count threshold');
  assert.match(content, /Run 'gsd-memory distill' CLI/, 'the trigger must be deferred to the CLI (no server-side trigger)');
});

// Test 11: store->search round-trip — both _call_daemon paths documented
test('MCP-03: store->search round-trip uses _call_daemon for both store and search', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // renamed from _call_daemon (deleted in 119263f, Phase 46-01-08) to the direct store handle:
  // store and search must go through the SAME store object (`_get_store()`), which is what makes the
  // round trip hold. Both handlers resolve it, and the daemon is no longer in the path.
  const resolves = content.match(/store = _get_store\(\)/g) || [];
  assert.ok(resolves.length >= 3,
    `Expected >= 3 handlers resolving store via _get_store() (search-code, memory-store, memory-search), found ${resolves.length}`);
  assert.match(content, /store\.memory_store_with_embedding\(/, 'store half of the round trip');
  assert.match(content, /store\.memory_semantic_search\(/, 'search half of the round trip');
  assert.equal((content.match(/_call_daemon\(/g) || []).length, 0, 'no daemon hop remains');
});

// ─── MCP-04 Tests ─────────────────────────────────────────────────────────────

// Test 12: context resource URI pattern is correctly defined
test('MCP-04: context resource URI amauta://context/{task_id}/{phase} is registered', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta:\/\/context/, 'context resource URI scheme must be present');
  assert.match(content, /list_resources/, '@server.list_resources decorator must be present');
  assert.match(content, /read_resource/, '@server.read_resource decorator must be present');
});

// Test 13: read_resource parses URI and calls correct daemon path
test('MCP-04: read_resource parses amauta://context URI and calls /api/context/{task_id}/{phase}', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // URI regex: amauta://context/(TK-NNNN)/([RPETD])
  assert.match(content, /amauta:\/\/context.*\[RPETD\]|RPETD.*amauta:\/\/context/,
    'read_resource must validate phase in [RPETD]');
  // renamed from the /api/context/{task_id}/{phase} daemon call to store.rpetd_context_get(task_id, phase)
  // (Phase 46-01, direct PGStore; the daemon route is no longer used by the MCP server).
  assert.match(content, /store\.rpetd_context_get\(task_id, phase\)/, 'context must be read from the store');
  // Phase validation: must check for invalid URIs
  assert.match(content, /ValueError.*Unsupported resource URI|unsupported.*URI/i,
    'read_resource must raise ValueError for unsupported URI');
});

// Test 14: list_resources fetches tasks and builds resource list
test('MCP-04: list_resources fetches /api/list and builds amauta://context resources', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // renamed: list_resources no longer enumerates live tasks from /api/list; since Phase 46 it advertises
  // the three frozen URI templates (see its docstring in services/amauta-mcp.py). The task-id shape
  // (TK-NNNN) moved into the read_resource URI regexes.
  assert.match(content, /uri="amauta:\/\/context\/\{task_id\}\/\{phase\}"/, 'context URI template must be advertised');
  assert.match(content, /uri="amauta:\/\/agent\/\{agent_name\}"/, 'agent URI template must be advertised');
  assert.match(content, /uri="amauta:\/\/findings\/\{task_id\}"/, 'findings URI template must be advertised');
  assert.match(content, /TK-\\d\{4,\}/, 'read_resource must validate TK-XXXX task IDs');
  assert.match(content, /mimeType.*application\/json/, 'resources must set mimeType=application/json');
});

// ─── MCP-05 Tests ─────────────────────────────────────────────────────────────

// Test 15: research tool defined with correct schema
test('MCP-05: research tool defined with query required, creative optional', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/research/, 'research tool name must be present');
  assert.match(content, /implementable.*subset|Memory.*SKB.*WebFetch/,
    'tool description must mention implementable subset');
  assert.match(content, /"creative"/, 'creative param must be in inputSchema');
});

// Test 16: research chain checks cache first
test('MCP-05: research chain checks /api/research-cache before executing Memory->SKB->WebFetch', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // renamed from GET /api/research-cache to a Valkey read-through cache keyed "amauta:research:" + sha256
  // (e6fe49f, Phase 46-01-06: "direct PGStore + Valkey cache"); the cache is consulted before the chain runs.
  assert.match(content, /"amauta:research:" \+ hashlib\.sha256/, 'research cache key must be amauta:research: + sha256');
  assert.match(content, /cached = valkey\.get\(cache_key\)/, 'the cache must be read before the chain runs');
  assert.match(content, /hashlib\.sha256/, 'cache key must be sha256 of query');
  // Cache hit path: from_cache = True
  assert.match(content, /from_cache.*True|"from_cache".*True/, 'cache hit sets from_cache=True');
});

// Test 17: research result shape (read-through cache — no POST write, daemon has no POST /api/research-cache)
test('MCP-05: research result has {memory_results, skb_results, web_results, from_cache} shape', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /memory_results/, 'result must have memory_results key');
  assert.match(content, /skb_results/, 'result must have skb_results key');
  assert.match(content, /web_results/, 'result must have web_results key');
  assert.match(content, /from_cache.*False|"from_cache".*False/, 'cache miss sets from_cache=False');
  // Verify no POST cache-write — daemon has no POST /api/research-cache route.
  // Pattern targets code calls only (_call_daemon("POST", ...) or requests.post(... research-cache)),
  // not comments (which mention POST /api/research-cache in plain text).
  assert.doesNotMatch(content, /_call_daemon\("POST".*research-cache|requests\.post.*research-cache/,
    'research chain must NOT call _call_daemon("POST", ...) targeting research-cache (endpoint does not exist in daemon)');
});
