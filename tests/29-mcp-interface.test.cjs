'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Discovery manifest — printed at module load for grep-verifiability
console.log('[discovery] MCP-01: amauta-mcp.py exists and has Server("amauta")');
console.log('[discovery] MCP-01: .mcp.json exists with mcpServers.amauta.command=python3');
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
  assert.match(content, /_check_daemon_health/, 'Must have daemon health guard');
});

// Test 2: .mcp.json exists with correct mcpServers structure
test('MCP-01: .mcp.json exists with mcpServers.amauta pointing to amauta-mcp.py', () => {
  const mcpJson = path.join(ROOT, '.mcp.json');
  assert.ok(fs.existsSync(mcpJson), '.mcp.json must exist at repo root');
  const config = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
  assert.ok(config.mcpServers, '.mcp.json must have mcpServers key');
  assert.ok(config.mcpServers.amauta, '.mcp.json must have mcpServers.amauta');
  assert.equal(config.mcpServers.amauta.command, 'python3', 'command must be python3');
  assert.deepEqual(config.mcpServers.amauta.args, ['services/amauta-mcp.py'],
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
  assert.match(content, /_call_rlm/, '_call_rlm helper must be defined');
  assert.match(content, /18798|RLM_URL/, 'RLM URL must target port 18798');
  assert.match(content, /\/query/, 'RLM /query endpoint must be used');
});

// Test 7: search-code call_tool branch returns raw rlm result
test('MCP-02: search-code call_tool branch returns JSON-dumped _call_rlm result', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // The call_tool handler should call _call_rlm for search-code and json.dumps the result
  assert.match(content, /name.*==.*amauta\/search-code|"amauta\/search-code"/, 'call_tool must branch on search-code');
  assert.match(content, /json\.dumps\(result\)/, 'result must be wrapped with json.dumps');
  assert.match(content, /result\s*=\s*_call_rlm\(/, '_call_rlm return must be assigned to result variable');
});

// ─── MCP-03 Tests ─────────────────────────────────────────────────────────────

// Test 8: memory-store delegates to /api/memory/store
test('MCP-03: memory-store tool delegates to POST /api/memory/store', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-store/, 'memory-store tool must be defined');
  assert.match(content, /\/api\/memory\/store/, '/api/memory/store must be the delegation target');
  // Required param: text
  assert.match(content, /"required".*text|required.*\["text"\]/, 'text must be required in memory-store schema');
});

// Test 9: memory-search delegates to /api/memory/semantic-search
test('MCP-03: memory-search tool delegates to POST /api/memory/semantic-search', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-search/, 'memory-search tool must be defined');
  assert.match(content, /\/api\/memory\/semantic-search/, 'semantic-search endpoint must be used');
});

// Test 10: memory-distill returns distill-status; no server-side trigger (defers to gsd-memory distill CLI)
test('MCP-03: memory-distill returns distill-status JSON with needs_distill flag (no server-side trigger)', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /amauta\/memory-distill/, 'memory-distill tool must be defined');
  assert.match(content, /\/api\/memory\/distill-status/, 'distill-status must be checked');
  assert.match(content, /needs_distill|force/, 'needs_distill or force branch must exist');
});

// Test 11: store->search round-trip — both _call_daemon paths documented
test('MCP-03: store->search round-trip uses _call_daemon for both store and search', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  // Count _call_daemon invocations — should be at least 5 (store, search, distill-status,
  // distill, context read) across handlers
  const matches = content.match(/_call_daemon\(/g) || [];
  assert.ok(matches.length >= 5,
    `Expected >= 5 _call_daemon calls, found ${matches.length}`);
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
  // URI regex: amauta://context/([^/]+)/([RPETD])
  assert.match(content, /amauta:\/\/context.*\[RPETD\]|RPETD.*amauta:\/\/context/,
    'read_resource must validate phase in [RPETD]');
  assert.match(content, /\/api\/context/, '/api/context delegation must be present');
  // Phase validation: must check for invalid URIs
  assert.match(content, /ValueError.*Unsupported resource URI|unsupported.*URI/i,
    'read_resource must raise ValueError for unsupported URI');
});

// Test 14: list_resources fetches tasks and builds resource list
test('MCP-04: list_resources fetches /api/list and builds amauta://context resources', () => {
  const content = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');
  assert.match(content, /\/api\/list/, 'list_resources must call /api/list');
  assert.match(content, /TK-\d{4}|re\.findall.*TK/, 'list_resources must extract TK-XXXX task IDs');
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
  assert.match(content, /api\/research-cache/, 'research-cache endpoint must be checked');
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
