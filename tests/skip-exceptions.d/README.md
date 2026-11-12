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
     "note": "why these entries exist and what closes them",
     "added":   [ ["name", "file", "platform", "context", "reason", "reason_class", "owner", owner_phase, "exit_criterion"] ],
     "removed": [ ... ]
   }
   ```

   `added` and `removed` hold **full nine-field tuples** in `FIELDS` order.
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
