#!/usr/bin/env node
/**
 * amauta — Amauta v1 CLI
 *
 * Canonical entry point. Delegates to gsd-amauta.cjs.
 * Both `amauta` and `gsd-amauta` resolve to the same CLI.
 *
 * Usage: node amauta.cjs <command> [args]
 */
require(require('path').join(__dirname, 'gsd-amauta.cjs'));
