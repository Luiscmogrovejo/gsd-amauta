#!/usr/bin/env node
// GSD update check — NEUTRALIZED (2026-07-10, supply-chain safety).
//
// This fork (gsd-amauta) is updated ONLY from the local git repository
// (/Users/.../Code/gsd-amauta) via a manual, verified file sync. The original
// hook queried the UPSTREAM npm package `get-shit-done-cc` on every session
// start and fed an "update available" nag into the statusline — steering the
// operator toward `npx get-shit-done-cc`, which installs upstream code this
// fork does not trust (upstream reported compromised). No version telemetry,
// no network calls, no child processes.
//
// It now only maintains the local cache so the statusline never nags:
// update_available is always false; `installed` reflects the local VERSION.

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();

function detectConfigDir(baseDir) {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'get-shit-done', 'VERSION'))) {
    return envDir;
  }
  for (const dir of ['.config/opencode', '.opencode', '.gemini', '.claude']) {
    if (fs.existsSync(path.join(baseDir, dir, 'get-shit-done', 'VERSION'))) {
      return path.join(baseDir, dir);
    }
  }
  return envDir || path.join(baseDir, '.claude');
}

const globalConfigDir = detectConfigDir(homeDir);
const cacheDir = path.join(globalConfigDir, 'cache');
const cacheFile = path.join(cacheDir, 'gsd-update-check.json');
const versionFile = path.join(globalConfigDir, 'get-shit-done', 'VERSION');

let installed = '0.0.0';
try { installed = fs.readFileSync(versionFile, 'utf8').trim(); } catch (e) {}

try {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    update_available: false,
    installed,
    latest: installed,
    checked: Math.floor(Date.now() / 1000),
    neutralized: 'upstream get-shit-done-cc check disabled 2026-07-10 (supply-chain safety; local-repo updates only)',
  }));
} catch (e) {}
