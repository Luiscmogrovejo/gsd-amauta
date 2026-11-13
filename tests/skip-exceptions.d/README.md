# `tests/skip-exceptions.d/` — the skip ledger, one shard per owner

The skip gate (plan 88-19, FND-04) refuses a test that skips without an entry here,
and refuses an entry that excuses nothing on a full run. Plan 89-09 **sharded** what
used to be a single 467-entry array in `tests/skip-exceptions.json`.

## Why it is a directory

A flat JSON array is textually merge-hostile: when two branches each add an entry,
git can resolve the array without a conflict and **lose** one of them — and the gate
then reports a *skip*, not a *loss*. Phase 89 had eight plans that each needed to add
or remove entries, which forced them into eight different waves. One file per owner
removes that constraint entirely.

## The rules

1. **One shard per owning plan**, named `<plan>.json` — `89-01.json`, `89-05.json`,
   `89-07.json` — or `carried.json` for entries no Phase 89 plan owns.
2. **A plan edits only its own shard and its own delta file.** The exception is a plan
   that *closes* an entry another plan created: that is allowed, and the closing plan
   must name the entry and the shard it came out of in its own record.

   Every entry added or removed since the shard migration is declared in
   `tests/skip-exceptions.d/delta/<plan>.json` — one file per owning plan:

   ```json
   {
     "plan": "89-05",
     "shard": "tests/skip-exceptions.d/89-05.json",
     "shard_is_all_added": false,
     "note": "why these entries exist and what closes them",
     "added":   [ ["name", "file", "platform", "context", "reason", "reason_class", "owner", owner_phase, "exit_criterion"] ],
     "removed": [ ... ]
   }
   ```

   `added` and `removed` hold **full nine-field tuples** in `FIELDS` order.
   `shard_is_all_added` is required and must be declared, never guessed: `true`
   when the plan OPENED its shard, so every entry in it is one of that plan's
   additions and the two counts must match (89-01, 89-02, 89-04); `false` when
   plan 89-09's migration filled the shard from the pre-shard ledger, so the
   plan's additions are a subset of it (89-05, `carried`).

   **`closed` is a THIRD, optional list** (plan 89-07). It carries a tuple a
   plan ADDED after the shard migration and a later plan then DELETED. Such a
   tuple nets to zero against the pre-shard ledger, so it belongs in neither
   `added` (it is no longer live) nor `removed` (`removed` reconstructs the
   pre-shard 467 and would double-count it) — and without a third list the
   declaration would simply vanish, taking every assertion about what the plan
   had owned with it. Like `removed`, a `closed` tuple must be in no shard.

   **A plan that has closed every entry it owned has NO shard.** An empty `[]`
   array is deliberately not kept: the shard file is deleted and the plan's
   delta file, which still declares everything, is what remains. The loader
   allows a delta whose plan has no shard **only when its `added` is empty**, so
   a missing shard can never hide a live entry.
   `tests/89-09-skip-shards.test.cjs` loads the union of these files and proves that
   the pre-shard 467-entry set, plus every `added`, minus every `removed`, is still
   exactly the live union — so an entry cannot change without a declaration. It also
   proves that a plan's `added` is **exactly** what its own shard holds and that its
   `removed` is in no shard.

   `delta/` is **not** a shard directory: all four readers enumerate
   `tests/skip-exceptions.d/` non-recursively and keep only `*.json` names, and
   `delta` has no such suffix. Nothing in it is ever read as a skip exception.

   A malformed delta file — not a JSON object, a missing or non-array `added`/
   `removed`, a row that is not a nine-element tuple, the same tuple twice in one file
   or across two, a `plan` that disagrees with the file name, an empty or absent
   directory — **fails closed**: the loader reports it by name and the test is red.

   Plan 89-05 introduced this layout (addendum A). Before it, both lists were shared
   arrays inside `tests/89-09-skip-shards.test.cjs`, which made that one file conflict
   in three of wave 2's four parallel PRs.
3. **The union is what is read.** Every reader loads the union of
   `tests/skip-exceptions.d/*.json` (sorted by name) plus `tests/skip-exceptions.json`
   when that legacy file still exists:
   - `scripts/skip-gate.cjs` — `loadUnion(repoRoot)` / `loadUnionForGate(repoRoot)`,
     called from `scripts/run-tests.cjs`;
   - `tests/support/skip_gate.py` — `load_union(repo_root)`, called from
     `tests/conftest.py`;
   - `get-shit-done/bin/lib/planning-drift.cjs` — `skipExceptionsSources(root)`;
   - `tests/88-19-skip-gate.test.cjs` — the ledger's own test block.
4. **The schema is the gate's and is unchanged**: nine fields, every one required —
   `name`, `file`, `platform`, `context`, `reason`, `reason_class`, `owner`,
   `owner_phase`, `exit_criterion`. `scripts/skip-gate.cjs` `SCHEMA` and
   `tests/support/skip_gate.py` `SCHEMA` are the authority, and
   `tests/88-19-skip-gate.test.cjs` proves the two agree.
5. **A duplicate `(file, name, platform)` across two shards is a finding**
   (`SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS`), not a merge. Two shards holding one
   key means two plans own it, and whichever deletes it first leaves the skip still
   excused by the other. A duplicate *inside* one shard stays
   `SKIP_EXCEPTIONS_MALFORMED`, as it always was.
6. **An unreadable or non-array shard is a finding**, never a pass: the gate fails
   closed. For the runner, an empty directory with no legacy file is a finding too.

## Why `tests/skip-exceptions.json` is still accepted

`tests/fixtures/planning-drift/skip-ledger-agrees/tests/skip-exceptions.json` and
`…/skip-ledger-disagrees/…` carry one each. Rewriting those fixture trees would mix a
fixture change into a loader change, so the legacy single file remains a valid input
and the fixtures are untouched. The repository root has no such file.

## The shards as plan 89-09 created them

| Shard | Entries | Who removes them |
|---|---|---|
| `89-01.json` | 11 `retrieval-leg-routed-89` | plan 89-01 (closed by 89-07-04) |
| `89-05.json` | 26 `pg-no-disposable-database` on the four `tests/test_a2a_*.py` | plan 89-05 (closed by 89-07-04) |
| `89-07.json` | the remaining 386 `pg-no-disposable-database` | plan 89-07 |
| `carried.json` | the 44 not owned by Phase 89 | their own phases |

`11 + 26 + 386 + 44 = 467`, set-equal to the pre-shard array on the full nine-field
tuple — the proof is in `tests/89-09-skip-shards.test.cjs`.

## What the shards hold now

Every change since is declared in `delta/`, so this table is derivable rather than
authoritative. New shards appear as their plans open them.

| Shard | Change since 89-09 | Who removes what is left |
|---|---|---|
| `89-01.json` | removed its 11, added 16, and plan 89-07 closed all 16 — **shard deleted** | — |
| `89-02.json` | opened with 56, all 56 closed by plan 89-07 — **shard deleted** | — |
| `89-04.json` | opened with 51, all 51 closed by plan 89-07 (46 with a database, 5 with a major-16 client) — **shard deleted** | — |
| `89-05.json` | removed the 26 `test_a2a_*` entries with the feature, added 24, all 24 closed by plan 89-07 — **shard deleted** | — |
| `89-06.json` | opened with 70, all 70 closed by plan 89-07 — **shard deleted** | — |
| `89-07.json` | the 386 entries 89-09 migrated in are gone; the shard now holds plan 89-07's own 334 additions in two classes (see below) | Phase 100 |
| `89-08.json` | opened with 26 `pg-no-disposable-database-local` entries (`all` / `local`): the PostgreSQL-backed tests of `tests/test_89_08_blue_green_backfill.py` (migration 034, the re-embed job, the cutover, the mixed-model refusal) | Phase 100 |
| `89-10.json` | opened with 1 `pg-no-disposable-database-local` entry (`all` / `local`): the store-through-a-PostgreSQL-daemon acceptance of the managed keys file | Phase 100 |
| `carried.json` | unchanged | their own phases |

### What `89-07.json` holds, and why its entries are not owned by Phase 89

Plan 89-07 gave the macOS and Windows cells a disposable PostgreSQL, so the whole
`pg-no-disposable-database` class — **598 entries across six shards** — excuses
nothing on any CI cell and is gone. **No entry anywhere is owned by Phase 89 any
more**, which is what lets the phase close. What plan 89-07 WROTE, measured
rather than estimated, is:

| Class | Entries | Platform / context | Owner |
|---|---|---|---|
| `pg-no-disposable-database-local` | 304 (239 python + 65 node) | `all` / `local` | Phase 100 |
| `paradedb-engine-unavailable` | 30 (15 tests × `darwin` + `win32`) | per-platform / `any` | Phase 100 |

The 304 came from the gate's own `SKIP_UNLISTED` list on a local full run with
`CI` unset and `GSD_TEST_POSTGRES_URL` unset — one row per test rather than one
per test per system, which is why the count is about half of 598 and not 598.
The gate REFUSES a `context: "local"` entry when `CI` is set, so none of them can
ever excuse a CI cell.

The 30 are the tests that need the **ParadeDB** lexical engine on the two cells
whose PostgreSQL has no `pg_search` control file at all. Fifteen of them carry
BOTH a local row and a per-platform row, because the two obstacles are different
(no database at all, versus a database with no `pg_search`) and neither excuses
the other's cell.
