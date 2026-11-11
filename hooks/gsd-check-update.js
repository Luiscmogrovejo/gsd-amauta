#!/usr/bin/env node
// GSD update check — LOCAL ONLY (no network), supply-chain safe.
//
// This fork (gsd-amauta) is updated ONLY from the local git repository, never
// from npm: the upstream package `get-shit-done-cc` was reported compromised,
// so the original hook's `npm view` call was removed on 2026-07-10 and is not
// coming back. No network calls, no child processes, no telemetry.
//
// What it does now: the hook used to hard-code update_available:false, so it
// could never report a stale install — the installed copy could sit versions
// behind the repo it came from and the statusline stayed quiet. It now does a
// purely local comparison:
//
//   installed  = <configDir>/get-shit-done/VERSION
//   package    = <plugin_root>/package.json .version
//   plugin_root comes from ~/.amauta/data/install_record.json, which
//               bin/init.cjs writes on a successful install.
//
// When the source path is unknown (no install record), the hook reports no
// update and says why — it never guesses and never reaches the network.

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

/** Compare dotted versions; returns 1 if a > b, -1 if a < b, 0 if equal/unknown. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10));
  const pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** The package directory this install came from, or null when unknown. */
function packageRoot() {
  const recordPath = path.join(homeDir, '.amauta', 'data', 'install_record.json');
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (record && record.plugin_root && fs.existsSync(path.join(record.plugin_root, 'package.json'))) {
      return record.plugin_root;
    }
  } catch (e) { /* no record / unreadable → unknown source */ }
  return null;
}

const globalConfigDir = detectConfigDir(homeDir);
const cacheDir = path.join(globalConfigDir, 'cache');
const cacheFile = path.join(cacheDir, 'gsd-update-check.json');
const versionFile = path.join(globalConfigDir, 'get-shit-done', 'VERSION');

let installed = '0.0.0';
try { installed = fs.readFileSync(versionFile, 'utf8').trim(); } catch (e) { /* not installed */ }

let latest = installed;
let source = 'unknown';
let note = 'install source unknown (no install record) — run `node bin/init.cjs` from the repo to record it';

const root = packageRoot();
if (root) {
  try {
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (pkgVersion) {
      latest = pkgVersion;
      source = root;
      note = 'local comparison against the repository this install came from (no network)';
    }
  } catch (e) { /* unreadable package.json → keep unknown */ }
}

const updateAvailable = compareVersions(latest, installed) > 0;

try {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    update_available: updateAvailable,
    installed,
    latest,
    source,
    checked: Math.floor(Date.now() / 1000),
    note,
    upgrade_command: 'git pull && node bin/init.cjs --upgrade',
    npm_check: 'disabled 2026-07-10 (supply-chain safety; local-repo updates only)',
  }));
} catch (e) { /* cache is best-effort */ }
