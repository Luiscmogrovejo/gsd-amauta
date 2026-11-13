# The PostgreSQL of every CI cell, and the lexical engine it runs

The suite runs on nine required cells. Every one of them has a disposable
PostgreSQL, applies the product's own migrations to it, and runs the whole
Postgres-backed suite. They do **not** all run the same lexical search engine,
and this page says exactly which cell runs which, why, and what that means for
a test that asserts a ranking.

`pg_search` (ParadeDB's BM25 extension) is optional since plan 89-06. A
database that has it answers lexical queries with BM25; one that does not
answers them with plain PostgreSQL full-text search (`to_tsvector` /
`ts_rank_cd`) over the substitute indexes migration 033 creates. The two
engines find the same rows for the same words and are **not** claimed to rank
them alike.

## The nine cells

| Cell | How its database is provided | PostgreSQL | Lexical engine | Ranking assertions |
|---|---|---|---|---|
| `test (ubuntu-latest, node 20)` | The ParadeDB container image, pinned by digest, started as a step | 16 | `pg_search_bm25` | BM25: run |
| `test (ubuntu-latest, node 22)` | same | 16 | `pg_search_bm25` | BM25: run |
| `pytest (ubuntu-latest, python 3.12)` | same | 16 | `pg_search_bm25` | BM25: run |
| `test (macos-latest, node 20)` | Homebrew `postgresql@17` + `pgvector`, then the pinned ParadeDB installer package | 17 | `pg_search_bm25` | BM25: run |
| `test (macos-latest, node 22)` | same | 17 | `pg_search_bm25` | BM25: run |
| `pytest (macos-latest, python 3.12)` | same | 17 | `pg_search_bm25` | BM25: run |
| `test (windows-latest, node 20)` | The PostgreSQL the runner image carries + `pgvector` built from pinned source | 17 | `postgres_fts` | BM25-specific tests are listed exceptions; everything else runs |
| `test (windows-latest, node 22)` | same | 17 | `postgres_fts` | same |
| `pytest (windows-latest, python 3.12)` | same | 17 | `postgres_fts` | same |

The table is enforced, not just written. On a CI cell,
`tests/test_pg_substrate.py::test_infra03_pg_search_installed` fails unless the
cell's database runs the engine this table names for its platform, and
`test_the_documented_engine_of_every_cell_is_the_asserted_one` fails if this
table and the map that test uses disagree.

## Linux

The three Linux cells start `paradedb/paradedb:latest-pg16`, pinned by digest,
which ships PostgreSQL 16 with `pg_search` 0.24.1 already preloaded. This is
the image `docker/docker-compose.yml` pins, so it is the engine a default
installation runs.

## macOS

The three macOS cells run the real ParadeDB engine since plan 89-12. Before
it they ran the plain-PostgreSQL leg.

1. `brew install postgresql@17 pgvector` (plan 89-07).
2. `scripts/ci-postgres-cell.cjs --up` creates and starts a throwaway cluster.
3. `scripts/ci-install-pg-search-macos.cjs` downloads **one** ParadeDB release
   asset by its exact URL, refuses unless its SHA-256 equals the recorded pin,
   checks the Apple installer signature and Team ID, installs it, adds
   `pg_search` to `shared_preload_libraries`, restarts the cluster, and fails
   the step unless `CREATE EXTENSION pg_search` then reports the pinned
   version.
4. The migrations run. Migration 011 finds the extension loadable and takes
   its BM25 branch; 033 creates no substitute index.

What is pinned, and where it was measured:

| | |
|---|---|
| Release | ParadeDB `v0.26.6` |
| macOS 26 runner (`macos-latest` today) | `pg_search@17--0.26.6.arm64_tahoe.pkg`, SHA-256 `29460a509a62143561024fddeb89838c1b7dad89d4dd5e040118b1fb35b287a0` |
| macOS 15 runner | `pg_search@17--0.26.6.arm64_sequoia.pkg`, SHA-256 `99b426eda50b92999e8a5a0525caa382102278d5cbd55f6240741a5089353d44` |
| Signature | Apple Developer ID Installer, Team `NDJBT4LXCM`, notarized; checked on every run with `pkgutil --check-signature` |
| Sigstore bundle | Verified with `cosign verify-blob` when the pins were taken. `cosign` is not preinstalled on the runner, so a normal run does not repeat it and says so in its output; the SHA-256 pin binds every run to the bytes that were verified |

The package matches Homebrew's `postgresql@17` and nothing else was needed: its
payload goes to `/opt/homebrew/opt/paradedb`, and its postinstall script links
the library into `/opt/homebrew/lib/postgresql@17` and the control file into
`/opt/homebrew/share/postgresql@17/extension`, which are the directories that
cluster's `pg_config --pkglibdir` and `--sharedir` report.

Two things to know before changing any of this:

- **`macos-latest` moves, and the asset name carries the macOS code name.** The
  helper picks the package by the runner's macOS major version and refuses a
  major it has no pin for. When the label moves again the cell fails with
  `unpinned_macos`; the fix is to record the new asset's digest, not to loosen
  the check.
- **Present is not loaded.** With the package installed but not preloaded,
  `CREATE EXTENSION pg_search` fails, migration 011 treats that as "available
  but unusable" and falls back to full-text search *without failing*. That is
  the right behaviour for a user's machine and the wrong one for this cell,
  which is why the helper proves the load and the test above asserts the
  engine.

The macOS and Linux cells run the same engine in **different versions**:
`pg_search` 0.24.1 on PostgreSQL 16 on Linux, 0.26.6 on PostgreSQL 17 on
macOS. The Linux version is the one the pinned container image carries; the
macOS one is the release that publishes a package for the macOS version the
runner has. The suite is written to assert orderings and membership rather
than score values, and it passes on both.

## Windows

Windows runs the whole Postgres suite on plain PostgreSQL + pgvector. `pg_search` is a
Rust/pgrx extension with no Windows target and ParadeDB publishes no Windows asset of any
kind, so the ParadeDB BM25 ranking tests run on Linux and macOS. This is a stated capability
limit, not a deferred test: every test runs on Windows, against the documented
plain-PostgreSQL lexical leg.

Read precisely, "every test runs on Windows" means every test of behaviour
Windows can have. The 29 tests that need a ParadeDB database to exist (they
build one, or they measure a floor or a boost that only BM25 produces) cannot
run where no such database can be built; they are listed for `win32` in
`tests/skip-exceptions.d/89-07.json` under the class
`paradedb-engine-unavailable`, and they run on the Linux and macOS cells.
Every other Postgres-backed test, including every test of the lexical
fallback itself, runs on the Windows cells. There is no WSL2 or container
route on the hosted Windows runner (measured in plan 88-16), and none is
planned.

## Checking your own machine

The same answer the cells assert is available to an operator in two places:

- `doctor` prints a row in the `lexical` category: `OK` with
  `lexical search: ParadeDB pg_search BM25 (pg_search <version>)`, or `WARN`
  with `lexical search: plain PostgreSQL full-text (pg_search not installed)`
  and the note that ranking differs from the BM25 leg.
- The daemon's `/health` response carries the same under
  `extra.lexical`: `lexical_engine` is `pg_search_bm25` or `postgres_fts`,
  with `reason` and `degraded`.

Both read one resolver, `services/infra_detect.py` `lexical_engine`, which is
also what the search code consults, so the report cannot disagree with what a
query actually does. A default installation uses the ParadeDB container and
reports `pg_search_bm25`.
