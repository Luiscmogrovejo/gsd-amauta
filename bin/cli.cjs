#!/usr/bin/env node

/**
 * gsd-amauta CLI dispatcher
 *
 * Routes subcommands to the appropriate handler:
 *   gsd-amauta init [options]        -> bin/init.cjs
 *   gsd-amauta status (no args)      -> gsd-memory.cjs cmdStatus (system status)
 *   gsd-amauta status <id> <status>  -> gsd-amauta.cjs cmdStatus (task status change)
 *   gsd-amauta <anything else>       -> get-shit-done/bin/gsd-amauta.cjs
 *
 * This is the main bin entry for `npx gsd-amauta`.
 */

'use strict';

const command = process.argv[2];

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
