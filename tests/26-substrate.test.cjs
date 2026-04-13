// Tests: INFRA-01 (Valkey), INFRA-04 (tree-sitter Node)
const { test } = require('node:test');
const assert = require('node:assert/strict');

// INFRA-01 Tests
test('INFRA-01: docker-compose.yml uses valkey/valkey:8-alpine image', () => {
  const fs = require('fs');
  const content = fs.readFileSync('docker/docker-compose.yml', 'utf8');
  assert.ok(content.includes('valkey/valkey:8-alpine'), 'Must reference valkey/valkey:8-alpine');
  assert.ok(!content.includes('redis:7'), 'Must not reference redis:7');
  assert.ok(content.includes('BSD 3-Clause'), 'Must have BSD 3-Clause license comment');
});

test('INFRA-01: docker-compose.yml healthcheck uses valkey-cli', () => {
  const fs = require('fs');
  const content = fs.readFileSync('docker/docker-compose.yml', 'utf8');
  assert.ok(content.includes('valkey-cli'), 'Healthcheck must use valkey-cli');
});

test('INFRA-01: benchmark log exists and references Valkey 8', () => {
  const fs = require('fs');
  assert.ok(fs.existsSync('tests/fixtures/26-benchmark-log.txt'), 'Benchmark log must exist');
  const log = fs.readFileSync('tests/fixtures/26-benchmark-log.txt', 'utf8');
  assert.ok(log.includes('INFRA-01 Benchmark'), 'Log must contain INFRA-01 Benchmark header');
  assert.ok(log.includes('Valkey 8'), 'Log must reference Valkey 8');
});

test('INFRA-04: tree-sitter Node package importable', () => {
  const Parser = require('tree-sitter');
  assert.ok(typeof Parser === 'function', 'tree-sitter exports a Parser constructor');
});

test('INFRA-04: tree-sitter-javascript parses a JS snippet', () => {
  const Parser = require('tree-sitter');
  const JavaScript = require('tree-sitter-javascript');
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const tree = parser.parse('const x = 1 + 2;');
  assert.ok(tree.rootNode, 'parse must return a tree with rootNode');
  assert.ok(tree.rootNode.namedChildCount > 0, 'AST node count must be > 0');
});

test('INFRA-04: tree-sitter-typescript parses a TS snippet', () => {
  const Parser = require('tree-sitter');
  const TypeScript = require('tree-sitter-typescript').typescript;
  const parser = new Parser();
  parser.setLanguage(TypeScript);
  const tree = parser.parse('const x: number = 1;');
  assert.ok(tree.rootNode.namedChildCount > 0, 'TypeScript AST node count must be > 0');
});

test('INFRA-04: tree-sitter parses a .cjs-style snippet (CommonJS)', () => {
  const Parser = require('tree-sitter');
  const JavaScript = require('tree-sitter-javascript');
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const cjsSnippet = "const mod = require('path'); module.exports = { mod };";
  const tree = parser.parse(cjsSnippet);
  assert.ok(tree.rootNode.namedChildCount > 0, 'CJS AST node count must be > 0');
});
