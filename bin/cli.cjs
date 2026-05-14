#!/usr/bin/env node

/**
 * gsd-amauta CLI dispatcher
 *
 * Routes subcommands to the appropriate handler:
 *   gsd-amauta init [options]        -> bin/init.cjs
 *   gsd-amauta mcp register          -> registers MCP server with Claude Code
 *   gsd-amauta mcp status            -> checks MCP registration status
 *   gsd-amauta module <action> ...   -> get-shit-done/bin/gsd-tools.cjs module (Phase 49)
 *   gsd-amauta party <action> ...    -> get-shit-done/bin/gsd-tools.cjs party (Phase 50)
 *   gsd-amauta status (no args)      -> gsd-memory.cjs cmdStatus (system status)
 *   gsd-amauta status <id> <status>  -> gsd-amauta.cjs cmdStatus (task status change)
 *   gsd-amauta <anything else>       -> get-shit-done/bin/gsd-amauta.cjs
 *
 * This is the main bin entry for `npx gsd-amauta`.
 */

'use strict';

const path = require('path');
const { execSync, spawnSync } = require('child_process');

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

// ─── Module subcommand (Phase 49 MOD-03/MOD-04) ─────────────────────────────
//
// gsd-amauta module install <manifest.yaml>      → gsd-tools.cjs module install
// gsd-amauta module uninstall <module-name>      → gsd-tools.cjs module uninstall
// gsd-amauta module upgrade <new-manifest.yaml>  → gsd-tools.cjs module upgrade
// gsd-amauta module validate <manifest.yaml>...  → gsd-tools.cjs module validate (Phase 48 surface)
//
// Mirrors the 'mcp' branch above: rewrite argv to point at the gsd-tools
// entry-point, then require it. The require model preserves stdio so
// process.stdout/stderr/exit propagation is identical to direct invocation.

if (command === 'module') {
  const toolsPath = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  // Dispatch to gsd-tools.cjs module <action> ... via spawnSync so that
  // gsd-tools.cjs main() runs in a fresh process (gsd-tools.cjs guards
  // main() with `if (require.main === module)`, which blocks require()-based
  // dispatch). process.argv.slice(3) strips [node, cli.cjs, 'module'] and
  // forwards the action + flags verbatim.
  //
  //   [node, cli.cjs, 'module', 'install', '/path/to/m.yaml', '--json']
  //   spawns gsd-tools.cjs with args: ['module', 'install', '/path/to/m.yaml', '--json']
  const moduleArgs = process.argv.slice(3);
  const result = spawnSync('node', [toolsPath, 'module', ...moduleArgs], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  process.exit(result.status === null ? 1 : result.status);
}

// ─── Party subcommand (Phase 50 PARTY-01/PARTY-02) ─────────────────────────
//
// gsd-amauta party create --participants <...>   -> gsd-tools.cjs party create
// gsd-amauta party start <session_id>            -> gsd-tools.cjs party start
// gsd-amauta party pause <session_id>            -> gsd-tools.cjs party pause
// gsd-amauta party resume <session_id>           -> gsd-tools.cjs party resume
// gsd-amauta party terminate <session_id>        -> gsd-tools.cjs party terminate
// gsd-amauta party get <session_id>              -> gsd-tools.cjs party get
//
// Mirrors the 'module' branch above: spawnSync the gsd-tools entry-point
// so stdio/exit-code propagation matches direct invocation.

if (command === 'party') {
  const toolsPath = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  const partyArgs = process.argv.slice(3);
  const result = spawnSync('node', [toolsPath, 'party', ...partyArgs], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  process.exit(result.status === null ? 1 : result.status);
}

// ─── Agents subcommand (Phase 52 COMPILE-02 + COMPILE-03 + COMPILE-04) ─────
//
// gsd-amauta agents compile --target=<ide> [--out <dir>] [--hydrate <agent>] [--dry-run]
// gsd-amauta agents validate <agent-dir>
// gsd-amauta agents list [--source <dir>]
//
// Mirrors the 'module' and 'party' branches above: spawnSync the gsd-tools entry-point
// so stdio/exit-code propagation matches direct invocation.

if (command === 'agents') {
  const toolsPath = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  const agentsArgs = process.argv.slice(3);
  const result = spawnSync('node', [toolsPath, 'agents', ...agentsArgs], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  process.exit(result.status === null ? 1 : result.status);
}

// ─── Doctor subcommand (Phase 54 STAB-06) ──────────────────────────────────
//
// gsd-amauta doctor
//
// Diagnoses install state: paths, daemon, PG, Valkey, API keys,
// migrations, agents, skills. Exits 0 always.

if (command === 'doctor') {
  const doctorPath = path.resolve(__dirname, '../services/doctor.py');
  const result = spawnSync('python3', [doctorPath, ...process.argv.slice(3)], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  process.exit(result.status === null ? 1 : result.status);
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
