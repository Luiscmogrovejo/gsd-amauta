# The cache (Redis / Valkey): one name, one chain, one resolver

**Written by plan 89-09 task 06.** Before it, ten sites read five environment names
with four different defaults, and a cache exported under the canonical name reached
only five of them. There is now exactly one resolver per language and every consumer
calls it.

| | |
|---|---|
| Canonical variable | **`GSD_REDIS_URL`** |
| Python resolver | `services/cache_url.py` — `redis_url()`, `redis_url_source()`, `masked_redis_url()`, `report()` |
| Node resolver | `get-shit-done/bin/lib/cache-url.cjs` — `cacheUrl()`, `cacheUrlSource()`, `maskedCacheUrl()`, `report()` |
| Proof the two agree | `tests/89-09-cache-url.test.cjs` feeds the same 14-rung table to both and compares the URL **and** the source for every rung |
| Proof nothing else reads the names | the lint in the same file, over `git ls-files`, with **no exception list** |

## The precedence chain

```
GSD_REDIS_URL                    the canonical name
  -> AMAUTA_REDIS_URL            legacy
  -> VALKEY_URL                  legacy
  -> REDIS_URL                   legacy
  -> REDIS_HOST + REDIS_PORT     legacy (either alone is enough; the other defaults)
  -> redis://127.0.0.1:<GSD_REDIS_PORT or 6379>/0
```

The first **non-blank** value wins; `FOO=` and `FOO="  "` count as unset, because an
empty variable is how a caller says "not configured". Every resolution can name the
variable that supplied it — `redis_url_source()` / `cacheUrlSource()` return the
name, `REDIS_HOST+REDIS_PORT`, or `default`.

### What each legacy name does now

Nothing was removed: all four legacy names are still read, in the order above, so no
existing deployment breaks. A value that comes from one of them emits **one**
deprecation warning per process, naming the legacy variable, the canonical one and
the **masked** URL:

```
[cache-url] REDIS_URL is deprecated: export GSD_REDIS_URL instead (resolved: redis://user:***@cache.internal:6379/0)
```

Python logs the same sentence through `logging.getLogger("services.cache_url")` at
`WARNING`. Once per name per process, not once per call.

### The default, and why its port is a variable

`redis://127.0.0.1:<GSD_REDIS_PORT or 6379>/0`. `GSD_REDIS_PORT` is the host-side
port `docker/docker-compose.yml` publishes the Valkey container on
(`"127.0.0.1:${GSD_REDIS_PORT:-6379}:6379"`), and `services/infra_detect.py` already
built its default that way. A default that ignored it would point infrastructure
detection at a port the container is not on. With `GSD_REDIS_PORT` unset the default
is `redis://127.0.0.1:6379/0`, which is what four of the ten pre-89-09 sites used.

**On the operator's machine 6379 is their OWN Redis server, not a container this
project owns.** Two consequences, both load-bearing:

* the resolvers construct no client and open no socket — they resolve **strings**;
* `services/amauta-mcp.py` asks for the **source** and treats `default` as "not
  configured", so an MCP server with no cache configured still builds no client.
  That is the pre-89-09 behaviour, kept deliberately.

## The neighbours that are NOT in the chain

| Variable | What it is | Why it is outside |
|---|---|---|
| `GSD_TEST_VALKEY_URL` | the test-side opt-in, exactly parallel to `GSD_TEST_POSTGRES_URL` (`tests/conftest.py:160`) | CI hands the disposable Valkey over under this name and `tests/conftest.py` decides what to do with it. A resolver that read it would let a test's cache reach the product by accident. |
| `GSD_REDIS_ENABLED` | whether the daemon manages a cache at all (`false` disables it even with a URL set) | a switch, not an address |
| `GSD_REDIS_PORT` | the host-side port `docker/docker-compose.yml` publishes on | read for the **default** only, through `services/pg_dsn.py` `redis_port()` |

## Who reports which name supplied the value

Both `doctor` and the daemon's `/health` publish it, through the extension hooks of
plan 89-09 task 05 (`services/report_hooks.py`):

```
$ gsd-amauta doctor
  [OK  ]  cache            redis://cacheuser:***@cache.internal:6379/2 from VALKEY_URL (canonical name is GSD_REDIS_URL)

$ curl -s http://127.0.0.1:18799/health | jq .extra.cache
{
  "cache_url_source": "VALKEY_URL",
  "cache_url_masked": "redis://cacheuser:***@cache.internal:6379/2",
  "cache_url_canonical": "GSD_REDIS_URL"
}
```

The row is always `OK`, never a warning: it is informational, the deprecation is
already warned once per process by the resolver, and a `WARN` would move `doctor`'s
exit code from 0 to 1 on every install that still exports a legacy name.

## The masking rule

**A cache URL can carry a password, so no reported form ever shows one.** Masking is
`services/pg_dsn.py` `mask_dsn` on the Python side and `maskUrl` in
`get-shit-done/bin/lib/cache-url.cjs` on the Node side, and
`tests/89-09-cache-url.test.cjs` proves the two produce the same string for the same
input:

```
redis://user:secret@h:6379/0   ->  redis://user:***@h:6379/0
```

The unmasked URL is passed to the client and to nothing else. It is never logged,
never printed and never put in a `/health` or `doctor` field.

## The consumers

Every one of these calls the resolver; a direct read is a lint failure
(`tests/89-09-cache-url.test.cjs`, no exception list):

| File | What it does with the URL |
|---|---|
| `services/amauta-daemon.py` | `CACHE_URL`: the daemon's own client, the watchdog, `/health` |
| `services/doctor.py` | the `valkey` row's fallback address |
| `services/infra_detect.py` | the address infrastructure detection probes |
| `services/rlm_graph.py` | the dependency-graph cache (RETR-05) |
| `services/rlm_reranker.py` | the rerank-score cache |
| `services/agent_hydrator.py` | `agent:<name>:recent_activity` reads |
| `services/amauta-mcp.py` | `MCPValkey`, the MCP tool cache |
| `scripts/tool-integrity.cjs` | the `tool_integrity:` hash baseline |
| `get-shit-done/bin/gsd-tools.cjs` | the circuit-breaker state (`cb:<agent>`) |

## Tests scrub the legacy names

`scripts/run-tests.cjs` `DELETED_KEYS` and `tests/conftest.py` `_DELETED_KEYS` both
delete all five legacy names from a test environment, and both **set**
`GSD_REDIS_URL` to an ephemeral free port. An ambient cache therefore cannot
outrank the disposable one, and `tests/88-01-runner-env.test.cjs` refuses a
`:6379/` or `:5433/` in the value the runner hands its children.
