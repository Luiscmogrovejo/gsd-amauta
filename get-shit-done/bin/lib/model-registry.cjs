'use strict';
/**
 * model-registry.cjs — the single JS entry point for resolving Claude model
 * aliases (fable | opus | sonnet | haiku) to their CURRENT canonical model ids.
 *
 * Backed by model-registry.json (the one source of truth — MODL-01 currency,
 * MODL-06 centralization). No claude-* literal should live anywhere else in the
 * JS runtime; call resolveModelId()/resolveModelAlias() instead.
 *
 * Fable degrades to the latest Opus when unavailable (operator directive:
 * "if no fable, back up into the latest opus"). Availability defaults to true
 * and is forced off with GSD_FABLE_AVAILABLE in {0,false,off,no}, or per-call
 * via opts.fableAvailable.
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'model-registry.json');

// Last-known-good defaults so a missing/corrupt registry never crashes a caller
// (memory distill / classifier are fail-open by contract).
const _FALLBACK_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
const _FALLBACK_FALLBACK = { fable: 'opus' };

let _cache = null;
function _load() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    _cache = {
      aliases: (raw && raw.aliases) || _FALLBACK_ALIASES,
      fallback: (raw && raw.fallback) || _FALLBACK_FALLBACK,
    };
  } catch (_e) {
    _cache = { aliases: _FALLBACK_ALIASES, fallback: _FALLBACK_FALLBACK };
  }
  return _cache;
}

function fableAvailable() {
  const v = String(process.env.GSD_FABLE_AVAILABLE || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return true; // default: available
}

/** The alias amauta should actually USE, honoring the fable→opus fallback.
 *  Pass this to `claude --print --model <alias>`. Unknown input returned as-is. */
function resolveModelAlias(alias, opts = {}) {
  const reg = _load();
  const key = String(alias == null ? '' : alias).trim().toLowerCase();
  if (key === 'fable') {
    const avail = opts.fableAvailable !== undefined ? opts.fableAvailable : fableAvailable();
    if (!avail) return (reg.fallback && reg.fallback.fable) || 'opus';
  }
  return key || alias;
}

/** Resolve an alias (or raw id) to the CURRENT canonical model id, honoring
 *  the fable→opus fallback. A value that isn't a known alias is returned
 *  unchanged (already a concrete id). */
function resolveModelId(alias, opts = {}) {
  const reg = _load();
  const key = String(alias == null ? '' : alias).trim().toLowerCase();
  if (!reg.aliases[key]) return alias; // concrete id or unknown → pass through
  const resolvedAlias = resolveModelAlias(key, opts);
  return reg.aliases[resolvedAlias] || reg.aliases[key];
}

function aliases() {
  return Object.assign({}, _load().aliases);
}

module.exports = { resolveModelId, resolveModelAlias, fableAvailable, aliases };
