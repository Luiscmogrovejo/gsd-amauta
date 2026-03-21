#!/usr/bin/env node

/**
 * gsd-amauta CLI dispatcher
 *
 * Routes subcommands to the appropriate handler:
 *   gsd-amauta init [options]        -> bin/init.cjs
 *   gsd-amauta mcp register          -> registers MCP server with Claude Code
 *   gsd-amauta mcp status            -> checks MCP registration status
 *   gsd-amauta status (no args)      -> gsd-memory.cjs cmdStatus (system status)
 *   gsd-amauta status <id> <status>  -> gsd-amauta.cjs cmdStatus (task status change)
 *   gsd-amauta <anything else>       -> get-shit-done/bin/gsd-amauta.cjs
 *
 * This is the main bin entry for `npx gsd-amauta`.
 */

'use strict';

const path = require('path');
const { execSync } = require('child_process');

const command = process.argv[2];

// ─── MCP subcommand ─────────────────────────────────────────────────────────

if (command === 'mcp') {
  const subCmd = process.argv[3];
  const mcpServerPath = path.resolve(__dirname, 'mcp-server.cjs');

  if (subCmd === 'register') {
    console.log('Registering GSD-Amauta MCP server with Claude Code...');
    try {
      execSync(
        `claude mcp add gsd-amauta --transport stdio -- node "${mcpServerPath}"`,
        { stdio: 'inherit' }
      );
      console.log('MCP server registered successfully.');
    } catch (err) {
      if (err.status) {
        console.error('Failed to register MCP server. Is the Claude CLI installed?');
        console.error('Install it from: https://claude.ai/cli');
        process.exit(1);
      }
    }
  } else if (subCmd === 'status') {
    console.log('Checking MCP registration status...');
    try {
      const output = execSync('claude mcp list', { encoding: 'utf8' });
      const registered = output.includes('gsd-amauta');
      if (registered) {
        console.log('gsd-amauta MCP server is registered.');
        // Show the relevant line(s) from the listing
        const lines = output.split('\n').filter((l) => l.includes('gsd-amauta'));
        lines.forEach((l) => console.log('  ' + l.trim()));
      } else {
        console.log('gsd-amauta MCP server is NOT registered.');
        console.log('Run: gsd-amauta mcp register');
      }
    } catch {
      console.error('Could not check MCP status. Is the Claude CLI installed?');
      process.exit(1);
    }
  } else {
    console.log('Usage:');
    console.log('  gsd-amauta mcp register   Register MCP server with Claude Code');
    console.log('  gsd-amauta mcp status     Check MCP registration status');
  }
  process.exit(0);
}

// ─── Status routing ─────────────────────────────────────────────────────────

// Detect whether "status" is system status (no id) or task status change (with id).
// "amauta status" or "amauta status --json" -> system status (gsd-memory.cjs)
// "amauta status TK-001 done"               -> task status change (gsd-amauta.cjs)
const nextArg = process.argv[3];
const isStatusSystemCheck = command === 'status' && (!nextArg || nextArg.startsWith('--'));

if (command === 'init') {
  require('./init.cjs');
} else if (isStatusSystemCheck) {
  // System status: rewrite argv so gsd-memory.cjs sees "status" as its command
  process.argv = [process.argv[0], process.argv[1], 'status',
                  ...process.argv.slice(3)];
  require('../get-shit-done/bin/gsd-memory.cjs');
} else {
  // All other commands (including "status <id> <new-status>")
  // Delegate to existing gsd-amauta.cjs for task management commands
  // (board, stats, show, next, list, add, claim, rpetd, validate, daemon, etc.)
  require('../get-shit-done/bin/gsd-amauta.cjs');
}
