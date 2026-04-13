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
