#!/usr/bin/env node

/**
 * gsd-amauta CLI dispatcher
 *
 * Routes subcommands to the appropriate handler:
 *   gsd-amauta init [options]  -> bin/init.cjs
 *   gsd-amauta <anything else> -> get-shit-done/bin/gsd-amauta.cjs
 *
 * This is the main bin entry for `npx gsd-amauta`.
 */

'use strict';

const command = process.argv[2];

if (command === 'init') {
  require('./init.cjs');
} else {
  // Delegate to existing gsd-amauta.cjs for task management commands
  // (board, stats, show, next, list, add, claim, rpetd, validate, daemon, etc.)
  require('../get-shit-done/bin/gsd-amauta.cjs');
}
