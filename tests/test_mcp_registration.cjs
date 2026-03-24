'use strict';

/**
 * MCP Registration Tests
 *
 * Verifies MCP server auto-registration logic in install.js
 * and validates the MCP server file structure.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('MCP Registration', () => {
  const mcpServerPath = path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs');
  const installPath = path.resolve(__dirname, '..', 'bin', 'install.js');

  test('mcp-server.cjs exists', () => {
    assert.ok(fs.existsSync(mcpServerPath), 'MCP server file should exist');
  });

  test('mcp-server.cjs contains startServer function', () => {
    const content = fs.readFileSync(mcpServerPath, 'utf8');
    assert.ok(content.includes('startServer'), 'Should contain startServer function');
  });

  test('install.js contains MCP registration code', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(content.includes('mcpServers'), 'install.js should reference mcpServers');
    assert.ok(content.includes('mcp-server.cjs'), 'install.js should reference mcp-server.cjs');
    assert.ok(content.includes("runtime === 'claude'"), 'MCP should be guarded by Claude runtime check');
  });

  test('install.js MCP registration preserves existing servers', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    // The code should init mcpServers from existing or empty, not overwrite
    assert.ok(
      content.includes('!settings.mcpServers'),
      'Should check for existing mcpServers before creating'
    );
  });

  test('install.js uninstall removes MCP entry', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      content.includes("delete settings.mcpServers['gsd-amauta']") ||
      content.includes('delete settings.mcpServers["gsd-amauta"]'),
      'Uninstall should delete gsd-amauta MCP entry'
    );
  });

  test('install.js cleans up empty mcpServers object on uninstall', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      content.includes('delete settings.mcpServers') &&
      content.includes("Object.keys(settings.mcpServers).length === 0"),
      'Should clean up empty mcpServers object'
    );
  });

  test('MCP server defines expected tools', () => {
    const content = fs.readFileSync(mcpServerPath, 'utf8');
    const expectedTools = ['memory-search', 'memory-store', 'task-list', 'task-status', 'rpetd-log', 'system-status'];
    for (const tool of expectedTools) {
      assert.ok(content.includes(`'${tool}'`), `MCP server should define tool: ${tool}`);
    }
  });

  test('MCP registration sets disabled to false', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(content.includes('disabled: false'), 'MCP entry should have disabled: false');
  });

  test('MCP registration uses path.resolve for absolute path', () => {
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      content.includes("path.resolve(__dirname, 'mcp-server.cjs')"),
      'Should use path.resolve for absolute path resolution'
    );
  });
});
