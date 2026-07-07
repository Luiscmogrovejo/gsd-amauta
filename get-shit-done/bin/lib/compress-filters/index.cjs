'use strict';
const fs = require('fs');
const path = require('path');

// GSD_COMPRESS_REGISTRY_PATH is an authoritative test seam (mirrors
// GSD_HOOK_ALLOWLISTS_PATH): when set it is read unconditionally.
function registryPath() {
  return process.env.GSD_COMPRESS_REGISTRY_PATH ||
    path.resolve(__dirname, '..', '..', '..', 'config', 'compress-registry.json');
}
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), 'utf8')); }
  catch { return { registry_version: '0', entries: [] }; }   // fail-open: no registry -> passthrough-all
}
function _passthroughChain() {
  return [require('./_passthrough.cjs').transform];
}
// selectChain(commandName) -> array of transform fns (stdout, stderr, code) => string.
// Phase 72: registry is empty, so this ALWAYS returns [_passthrough.transform].
// NEVER throws — any lookup/require failure degrades to passthrough.
function selectChain(commandName) {
  try {
    const reg = loadRegistry();
    const entries = Array.isArray(reg.entries) ? reg.entries : [];
    const entry = entries.find((e) =>
      e && e.enabled !== false && Array.isArray(e.heads) && e.heads.includes(commandName));
    if (!entry || !entry.filter) return _passthroughChain();
    const mod = require(path.join(__dirname, entry.filter + '.cjs'));
    if (mod && typeof mod.transform === 'function') return [mod.transform];
    return _passthroughChain();
  } catch {
    return _passthroughChain();
  }
}
// selectFilterId(commandName) -> the matched entry's filter basename, or '_passthrough'.
// Returns a FILTER id (class label like 'git'|'test'|'_passthrough'), NEVER the command
// string — this is what keeps the compression_run payload command-content-free. Never throws.
function selectFilterId(commandName) {
  try {
    const reg = loadRegistry();
    const entries = Array.isArray(reg.entries) ? reg.entries : [];
    const entry = entries.find((e) =>
      e && e.enabled !== false && Array.isArray(e.heads) && e.heads.includes(commandName));
    return (entry && entry.filter) ? entry.filter : '_passthrough';
  } catch { return '_passthrough'; }
}
module.exports = { selectChain, selectFilterId, loadRegistry, registryPath };
