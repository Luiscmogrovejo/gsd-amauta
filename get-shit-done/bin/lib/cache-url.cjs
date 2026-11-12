/**
 * get-shit-done/bin/lib/cache-url.cjs — the ONE place a Redis/Valkey URL is
 * resolved on the Node side (plan 89-09 task 04).
 *
 * `services/cache_url.py` is the Python half. **The two must not drift**, and
 * `tests/89-09-cache-url.test.cjs` PROVES it rather than asserting it: it feeds the
 * same environment table to both and compares the URL and the source for every rung.
 *
 * THE CHAIN, in precedence order:
 *
 *     GSD_REDIS_URL  ->  AMAUTA_REDIS_URL  ->  VALKEY_URL  ->  REDIS_URL
 *                    ->  REDIS_HOST + REDIS_PORT
 *                    ->  redis://127.0.0.1:<GSD_REDIS_PORT or 6379>/0
 *
 * `GSD_REDIS_URL` is canonical; the other four are legacy and warn ONCE per process,
 * naming the legacy variable, the canonical one and the MASKED URL.
 *
 * NOT in the chain: `GSD_TEST_VALKEY_URL` (the test-side opt-in, parallel to
 * `GSD_TEST_POSTGRES_URL`), `GSD_REDIS_ENABLED` (whether a cache is managed at all)
 * and `GSD_REDIS_PORT` (the host-side port docker/docker-compose.yml publishes on,
 * read for the DEFAULT only).
 *
 * This module resolves STRINGS. It constructs no client and opens no socket: the
 * local 6379 is the operator's own Redis server, not a container this project owns.
 */

'use strict';

/** The canonical variable. Everything else is legacy. */
const CANONICAL = 'GSD_REDIS_URL';

/** Full-URL names, in precedence order. The first non-blank one wins. */
const URL_NAMES = [CANONICAL, 'AMAUTA_REDIS_URL', 'VALKEY_URL', 'REDIS_URL'];

/** The host rung's variable name. */
const HOST_NAME = 'REDIS_HOST';

/** The port rung's variable name. */
const PORT_NAME = 'REDIS_PORT';

/** What `cacheUrlSource` returns for the host+port rung. */
const HOST_PORT_SOURCE = `${HOST_NAME}+${PORT_NAME}`;

/** What `cacheUrlSource` returns when nothing at all is configured. */
const DEFAULT_SOURCE = 'default';

/** Every legacy name, for the lint and the scrub lists. */
const LEGACY_NAMES = ['AMAUTA_REDIS_URL', 'VALKEY_URL', 'REDIS_URL', HOST_NAME, PORT_NAME];

/** Process-global: the legacy names already warned about. */
const warned = new Set();

/**
 * Host-side cache port: `GSD_REDIS_PORT`, default 6379. The Python half reads it
 * through `services/pg_dsn.py` `redis_port()`; this is the same rule.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function cachePort(env) {
  return (env.GSD_REDIS_PORT || '6379').trim() || '6379';
}

/**
 * Mask a password in a connection URL, the discipline `services/pg_dsn.py`
 * `mask_dsn` implements.
 *
 * @param {string} url
 * @returns {string} e.g. `redis://user:***@host:6379/0`
 * @example
 *   maskUrl('redis://u:secret@h:6379/0')  // 'redis://u:***@h:6379/0'
 */
function maskUrl(url) {
  // `g`, because the Python half is `re.sub`, which replaces every occurrence.
  return String(url || '').replace(/:\/\/([^:/@]+):([^@]*)@/g, '://$1:***@');
}

/**
 * The URL used when nothing is configured.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string}
 */
function defaultUrl(env = process.env) {
  return `redis://127.0.0.1:${cachePort(env)}/0`;
}

/**
 * Resolve the cache URL AND the name that supplied it, in one pass.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{url: string, source: string}}
 * @example
 *   resolve({VALKEY_URL: 'redis://h:1/0'})  // {url: 'redis://h:1/0', source: 'VALKEY_URL'}
 */
function resolve(env = process.env) {
  for (const name of URL_NAMES) {
    const value = String(env[name] || '').trim();
    if (value) return { url: value, source: name };
  }
  const host = String(env[HOST_NAME] || '').trim();
  const port = String(env[PORT_NAME] || '').trim();
  if (host || port) {
    return { url: `redis://${host || '127.0.0.1'}:${port || cachePort(env)}/0`, source: HOST_PORT_SOURCE };
  }
  return { url: defaultUrl(env), source: DEFAULT_SOURCE };
}

/**
 * Warn ONCE per process that a legacy name supplied the cache URL.
 *
 * @param {string} url the resolved URL; only its MASKED form is ever printed
 * @param {string} source the name that supplied it
 * @returns {boolean} true when this call emitted the warning
 */
function warnOnce(url, source) {
  if (source === CANONICAL || source === DEFAULT_SOURCE || warned.has(source)) return false;
  warned.add(source);
  process.stderr.write(
    `[cache-url] ${source} is deprecated: export ${CANONICAL} instead (resolved: ${maskUrl(url)})\n`
  );
  return true;
}

/**
 * The resolved cache URL, warning once per process on a legacy name.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string} a `redis://` URL; never empty
 * @example
 *   cacheUrl({GSD_REDIS_URL: 'redis://127.0.0.1:7000/0'})  // 'redis://127.0.0.1:7000/0'
 */
function cacheUrl(env = process.env) {
  const { url, source } = resolve(env);
  warnOnce(url, source);
  return url;
}

/**
 * Which environment name supplied the cache URL.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string} a name, `REDIS_HOST+REDIS_PORT`, or `default`
 * @example
 *   cacheUrlSource({})  // 'default'
 */
function cacheUrlSource(env = process.env) {
  return resolve(env).source;
}

/**
 * The resolved URL with any password masked, for reporting.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string}
 */
function maskedCacheUrl(env = process.env) {
  return maskUrl(resolve(env).url);
}

/**
 * The reporting fragment, identical in shape to `services/cache_url.py` `report()`.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{cache_url_source: string, cache_url_masked: string, cache_url_canonical: string}}
 */
function report(env = process.env) {
  const { url, source } = resolve(env);
  return { cache_url_source: source, cache_url_masked: maskUrl(url), cache_url_canonical: CANONICAL };
}

module.exports = {
  CANONICAL,
  URL_NAMES,
  HOST_NAME,
  PORT_NAME,
  HOST_PORT_SOURCE,
  DEFAULT_SOURCE,
  LEGACY_NAMES,
  cachePort,
  maskUrl,
  defaultUrl,
  resolve,
  cacheUrl,
  cacheUrlSource,
  maskedCacheUrl,
  report,
};
