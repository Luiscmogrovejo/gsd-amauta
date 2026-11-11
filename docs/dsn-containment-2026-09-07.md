# Shared-service containment — what it covers, and what it does not

**Measured 2026-09-07 on `fix/memory-distill-containment` at `1210604`.**
macOS 25.3.0 (darwin arm64) · node v20.19.0 and v22.14.0 · CPython 3.14.3
(`/opt/homebrew/bin/python3`) · psycopg2 2.9.11.

Everything below is a statement about **that tree on that day, on that
configuration**. It is not a claim about the future and not a claim about any
other machine. If you are reading this after someone has edited
`services/pg_dsn.py`, re-measure before relying on it.

---

## 1. What happened

On 2026-09-07 a triage run wrote **8 `party_session` rows to the shared
development PostgreSQL on 127.0.0.1:5433**. The rows were left in place
deliberately; deleting them is a second disturbance to a shared service for a
cosmetic gain.

The reach was three call frames deep, and no test file on that path contained a
line of database code:

```
tests/party-{cli,e2e}.test.cjs, tests/party-decisions-{cli,e2e}.test.cjs
  -> node get-shit-done/bin/gsd-tools.cjs party create      (spawnSync)
    -> python3 services/party_session_cli.py create         (spawnSync)
      -> services/party_session.create()
        -> services/pg_store.PGStore()  ->  psycopg2 pool  ->  LIVE DATABASE
```

`services/pg_store.py:114` hardcoded the shared DSN as the fallback for an
unset `GSD_POSTGRES_URL`. The lane unset that variable **on purpose, to match
CI**. Unsetting the override did not disable the database — it removed the only
protection and handed the connection to a hardcoded pointer at the shared one.
A safety measure inverted into the hazard.

---

## 2. What the change does

`services/pg_dsn.py` is now the only place a PostgreSQL DSN is resolved.
`require_dsn()` has **no fallback branch**. An absent DSN raises
`UnconfiguredPostgresDSN` with a message naming what to export and why.

Five hardcoded fallbacks were deleted:

| File | What it was |
|---|---|
| `services/pg_store.py` | `DEFAULT_PG_URL` (the incident) |
| `services/complexity_scorer.py` | `_DEFAULT_PG_URL` |
| `services/skill_invocation_store.py` | `_DEFAULT_PG_URL` |
| `services/step-orchestrator.py` | `_DEFAULT_PG_URL` |
| `services/rlm-service.py` | inline `os.environ.get(..., "postgresql://…")` |

`pg_store.PGStore.__init__` resolves the DSN **before** it checks for psycopg2,
so containment holds identically on a machine with no driver instead of being
masked by an `ImportError`.

**Explicit configuration is honoured in full.** An operator who exports
`GSD_POSTGRES_URL` is saying yes. Containment is about the *absent* case only.

### The safe value

```
GSD_POSTGRES_URL='postgresql:///gsd_amauta_test?host=/nonexistent/gsd-amauta-containment'
```

`host=` begins with `/`, so libpq treats it as a Unix-domain socket directory
and **never falls back to TCP**. The directory does not exist, so the attempt
fails in ~1 ms with ENOENT (measured 2026-09-07). This is stronger than a wrong
TCP port, which is merely a refused connection to a machine you did reach.

---

## 3. What containment does NOT cover

Do not read this section as a list of small print. Each row is a live route to
a shared service that this change did not close.

### 3.1 Redis on 6379 — NOT COVERED

Two things listen on 6379 (native redis pid 1115 on IPv4; Docker pid 54005 on
the IPv6 wildcard), so it is not one service. These defaults point at it when
configuration is absent, and all remain in place:

| File | Default |
|---|---|
| `services/amauta-daemon.py:693` | `GSD_REDIS_URL` → `redis://127.0.0.1:6379/0` |
| `services/rlm_reranker.py:209-210` | `REDIS_HOST`/`REDIS_PORT` → `127.0.0.1`/`6379` |
| `services/rlm_graph.py:289-290` | same |
| `services/doctor.py:92,98` | `redis://127.0.0.1:6379/0` |
| `services/infra_detect.py:284` | same |
| `scripts/tool-integrity.cjs:49` | `AMAUTA_REDIS_URL` → `redis://127.0.0.1:6379` |

`services/pg_store.py`'s embedding cache (L648-676) is **already contained by
construction**: it calls `amauta_daemon_redis.get_redis_client()`, which returns
a client the daemon injects at startup and `None` in every other process. It has
no default of its own. Verified 2026-09-07.

They were left alone **as a judgement, not an oversight**: for the daemon and
the RLM these defaults *are* the operating configuration of a running service,
and failing closed there breaks the product rather than a test. The disturbance
class also differs — a cache write is evictable, a `party_session` INSERT is
durable shared state. That is a reason to rank it lower, not a reason to call
it safe. **A test that drives `rlm_reranker`, `rlm_graph` or the daemon with no
`GSD_REDIS_URL` set will still write to whichever of the two 6379 listeners it
reaches.**

### 3.2 The daemon (18799) and the RLM (18798) — NOT COVERED

`amauta.py` (L894, L1166, L1278, L1332, L1354, L2153, L3696-3698, L5875),
`services/doctor.py:16-17`, and the `get-shit-done/bin/gsd-*.cjs` clients all
default to `127.0.0.1:18799` / `18798`. `GSD_AMAUTA_NO_AUTO_START=1` stops a
daemon being *started*, but nothing stops one being *called*.

### 3.3 Other PostgreSQL routes still holding a hardcoded DSN

- `scripts/purge-test-data.py:34` — `postgresql://luismogrovejo@127.0.0.1:5432/gsd_amauta`.
  Note **5432**, not 5433: a different instance from the one in the incident.
  This script's purpose is destructive, and it is not covered.
- `scripts/backup.sh:8`, `scripts/restore.sh:7` — `${GSD_POSTGRES_URL:-postgresql://gsd:…@127.0.0.1:5433/…}`.
- `bin/install.js:3047,3142,3169,3190` — the installer, which is *supposed* to
  know a default; it writes config rather than connecting to do work.
- `services/infra_detect.py:104,108,126,199` — a detector whose job is to probe.
- **Test files carry their own copies.** Measured 2026-09-07: **18 test files
  plus one fixture** (`tests/fixtures/68-build-log-fixtures.json`) still embed
  `postgresql://gsd:…@127.0.0.1:5433/gsd_amauta` as their own default
  (`tests/test_65_{hybrid_generic,retrieval_e2e,vector_leg}.py`,
  `tests/test_66_{bitemporal,hybrid_memory,store_dedup}.py`,
  `tests/test_69_ast_parity_e2e.py`, `tests/test_85_memsafe_counter_proofs.py`,
  `tests/test_pg_substrate.py`, `tests/test_telemetry.py`,
  `tests/test_party_{decisions,decisions_migration,decision_trail,dissent_no_rollback,session_migration}.py`,
  `tests/step-orchestrator.test.cjs`, `tests/sharded-workflow-integration.test.cjs`,
  `tests/scale-adaptive-integration.test.cjs`).
  **Containment in `services/` does not reach them.** They set the DSN
  explicitly, which is exactly the case containment is required to honour.
  Closing this belongs to the separate service-touching-tests workflow.

### 3.4 An empty DSN is not the same as no DSN

`resolve_dsn()` treats an empty or whitespace-only variable as unset, on
purpose: handing libpq an empty conninfo string makes it fall back to the
ambient `PG*` environment and the default local socket. Two test files already
do `GSD_POSTGRES_URL: ''` (`tests/84-01-project-scoping.test.cjs:81`,
`tests/14-plan-to-tasks.test.cjs:846`); before this change that string was
truthy-checked inconsistently across call sites.

### 3.5 The interpreter is chosen by PATH

`gsd-tools.cjs` spawns bare `python3` (L5074). Which interpreter that is — and
therefore whether psycopg2 exists at all — depends on the caller's PATH. A run
where `python3` has no psycopg2 looks contained and is not; it merely cannot
connect today.

### 3.6 The guards already in the suite are the wrong kind

12 of the 22 service-touching files are **availability guards** (*skip when the
daemon is unreachable*). They protect the test from a missing service and
therefore **drive it whenever it is present**. Exactly two files in the suite
are containment guards: `tests/85-01-memsafe-containment.test.cjs` and the new
`tests/86-01-dsn-containment.test.cjs`.

### 3.7 What was not measured

- **Node 18.** The CI matrix is `[18, 20, 22]`. No node 18 is installed on this
  machine (`~/.nvm/versions/node` holds v20.11.1, v20.19.0, v22.14.0), so the
  gate results are from 20 and 22 only. Node 18 is untested for this change.
- **Linux and Windows.** CI runs `ubuntu-latest`, `macos-latest`,
  `windows-latest`. Only macOS was measured. On Windows there is no Unix-domain
  socket, so the behaviour of `CONTAINMENT_TEST_DSN` there is **unknown** —
  libpq may fall back to a TCP default. Measure before trusting it on Windows.
- **The other 209 test files.** Not run. 108 of them were failing before this
  change for unrelated reasons.
