# Backup and restore

**Owner:** Phase 89, plan 89-04. **Replaces:** `scripts/backup.sh`,
`scripts/restore.sh` (both retired) and, as a *restore* mechanism,
`services/backup.py` `BackupManager`.

## Why this exists

On 2026-11-12 an installer run changed the operator's PostgreSQL with no backup
in place. Three things were supposed to cover that case, and none did:

| Thing | What it covered | Why it was not enough |
|---|---|---|
| `services/backup.py` `BackupManager` | 6 logical table types, gzip JSON, SHA-256 of the table data, `restore(mode=merge\|replace)`, `verify()`, `auto_backup()` keeping 7 | **It strips every embedding** (`services/pg_store.py:456`, `:2982`, `:3281` — three `d.pop("embedding", None)` sites) and covers 6 of about 22 tables. A restore from it is not a restore. |
| `scripts/backup.sh` | `tasks.json`, `memory.jsonl`, a plain-SQL `pg_dump`, keep-30 | A hard-coded credentialed DSN at line 8, and `pg_dump … && echo ok \|\| echo skipped` so a **failed dump exited 0**. No checksum, no manifest, no verification, no restore test. |
| `scripts/restore.sh` | the reverse | `psql < dump` with **no `ON_ERROR_STOP`** and stderr discarded, so a partial restore printed "restored"; `cp … \|\| true` silently skipped the pre-restore copy. |

So the existing `~/.amauta/backups/gsd-auto-*.json.gz` files are
**not restorable backups** (Phase 89 decision D9). Measured 2026-11-12 on
`gsd-auto-20261112.json.gz` (8 034 855 bytes): the string `"embedding"` appears
**zero** times and exactly **6** tables are covered (`gsd_memory`,
`gsd_tasks`, `gsd_shared_kb`, `gsd_task_validations`, `gsd_agent_performance`,
`gsd_audit_log`). They are **relabelled, not deleted**; the relabelling happens
on the operator's machine in plan 89-14.

## The verb

`services/backup_snapshot.py` ships its own `__main__` CLI, exactly as
`services/migrate_runner.py` and `services/migrate_sqlite_to_pg.py` do. Plan
89-11 adds the equivalent `gsd-tools backup` dispatch, so every command below
will have two forms.

```
create  --reason REASON
        [--scope {all,postgres,sqlite,tasks}] [--dsn DSN | --local-docker]
        [--sqlite PATH] [--data-dir DIR] [--backups-dir DIR]
        [--include-volume-tar] [--volume-path DIR] [--verify] [--json]
list    [--backups-dir DIR] [--reason REASON] [--json]
verify  <snapshot-dir> | --latest [--reason REASON] [--backups-dir DIR] [--json]
restore <snapshot-dir> [--dsn DSN | --local-docker] [--mode {replace,merge}]
        [--scope {all,postgres,sqlite,tasks}] [--confirm]
        [--no-pre-restore-snapshot] [--sqlite PATH] [--data-dir DIR]
        [--backups-dir DIR] [--json]
prune   [--backups-dir DIR] [--dry-run] [--json]
for     <step-name> [--scope SCOPE] [--backups-dir DIR] [--dsn DSN]
        [--sqlite PATH] [--data-dir DIR] [--include-volume-tar]
        [--volume-path DIR] [--json]
```

Exit codes: **0** success, **1** a typed backup failure (the payload is on
stdout with `--json`), **2** anything unexpected or an argparse error.
`verify` returns **1** when the snapshot does not verify.

### `--reason` is a CLOSED enum of eleven values

```
pre-migration  pre-upgrade  pre-rebuild  pre-reingest  pre-restore
post-load  pre-cutover  pre-embedding-cutover  post-cutover  manual  auto
```

Exported as the module constant `REASONS` and used directly as
`add_argument("--reason", choices=REASONS, …)`, so the enum and the flag cannot
drift apart. **If a later caller needs a value that is not in the enum, the
enum is wrong, not the caller** — an argparse rejection of a command the live
cutover types is exactly the class of defect that produced the 2026-11-12
incident.

`pre-reingest` exists so that the cutover's step 5 and step 13 do not share
`pre-rebuild`: they would, and `verify --latest --reason pre-rebuild` would then
resolve to the later one, pointing step 6's and step 7's rollbacks at the wrong
snapshot.

`--verify` is **accepted and is a no-op**, documented as such in `--help`:
`create` always verifies. The flag exists because the cutover's commands read
better with it, and because an operator who types it on a safety step must not
meet an argparse error.

## What a snapshot contains

One directory per snapshot, `<backups-dir>/<UTC-ISO-compact>-<reason>/`:

| Artefact | How | Notes |
|---|---|---|
| `postgres.dump` | `pg_dump -Fc --no-owner --no-privileges` | custom format, so `pg_restore --list` can parse it **without a database** (which is how `verify` checks it) and `pg_restore -j` works |
| `postgres-volume.tar.gz` | only with `--include-volume-tar`; cold `tar`, resolved through the platform helper and spawned as an argv list | the atomic undo, and the only artefact that preserves cluster-era state such as `shared_preload_libraries`. The caller stops the container; the command **refuses** while anything still LISTENs on the DSN's port, because a tar of a running cluster is a torn copy |
| `gsd_amauta.db` | `sqlite3.Connection.backup()` then `PRAGMA integrity_check` on the copy | the online-backup API, correct with a live writer. A plain copy of a WAL database is not a backup, and there is no `sqlite3` binary on Windows |
| `tasks.json` (+ `.bak`) | copied under `<data dir>/.amauta.lock` through `services/_platform.file_lock` — `amauta.py`'s own lock file and protocol (`amauta.py:511`, `:538-549`) | a different lock would be no lock at all against the running daemon |
| `install_record.json`, `last_backend`, `pg_retry_queue.json` | copied | the three files the 2026-11-12 incident proved matter |
| `manifest.json` | below | the file the guard reads |

`auto` snapshots stay **logical only** (dump + SQLite + the small files, no
tar). A full snapshot is about 95 MB today, so 30 days of daily full autos would
be about 2.8 GB.

## The manifest

```json
{ "schema": 1, "created_at": "<UTC ISO, Z>", "reason": "...", "scope": "...",
  "host": "...", "git_sha": "<40-hex or null>", "backend": "postgresql|sqlite",
  "dsn_fingerprint": "<sha256(host:port/database)[:16]>",
  "pg": { "server_version": "...", "applied_migrations": [...],
          "extensions": {"vector": "...", "pg_search": "..."},
          "tables": { "<t>": {"rows": N, "with_embedding": M,
                              "vector_dims": D, "vector_column": "..."} },
          "dump_source": "PATH|GSD_PG_DUMP_BIN|docker exec <container>",
          "dump_client_major": N },
  "sqlite": { "page_count": N, "integrity_check": "ok", "tables": {...} },
  "tasks": { "items": N, "copied": [...], "absent": [...] },
  "files": [ {"path": "...", "bytes": N, "sha256": "..." } ],
  "verified_at": "<UTC ISO, Z>", "verify_result": "ok" }
```

**Never a DSN, never a password, never an API key.** The connection is
identified only by `dsn_fingerprint`, and the password travels to `pg_dump` /
`pg_restore` in `PGPASSWORD` so it does not appear in a process listing either.
`verify` itself fails a manifest holding any value that looks like a DSN.

The per-table census — rows, the count of non-null vector values and the
declared vector dimension — is also the read-only measurement ROADMAP Phase 89
asks the merge plan to start from, which is why it lives in the manifest rather
than in a throwaway script.

## Verification is part of taking a backup

`create` ends by running `verify` on its own output and writes
`verified_at` / `verify_result` **only when every check passes**. A snapshot that
fails verification therefore has **no `verified_at` key at all** — not
`verified_at: null` — and the guard treats it as **absent**. That is what makes
"verified backups" mechanical rather than aspirational.

`verify` fails **closed**. Every check is an error, never a warning:

* every file named in `files` exists with the recorded size and SHA-256 (a
  mismatch names the expected AND the actual digest);
* no unrecorded extra artefact is present;
* `postgres.dump` parses under `pg_restore --list`;
* any `*.tar.gz` parses under `tar -tzf`;
* the SQLite copy passes `PRAGMA integrity_check`;
* `tasks.json` parses as JSON and its item count equals the manifest's;
* no manifest value looks like a DSN.

## Restore

```
python3 services/backup_snapshot.py restore <snapshot-dir> --mode replace --confirm
```

* It **refuses** a snapshot without `verified_at`, and it refuses one that fails
  a **fresh** verification — a snapshot can rot on disk after it was written, so
  the stored verdict alone is not enough.
* `--mode replace` on PostgreSQL requires `--confirm` and runs
  `pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges`.
  `--exit-on-error` is the `ON_ERROR_STOP` semantics `scripts/restore.sh`
  lacked: **a partial restore is a failure, never a "restored" message.**
* Before writing anything it takes a `reason=pre-restore` snapshot of the
  target, unless `--no-pre-restore-snapshot` is given explicitly — and that flag
  is recorded in the audit row.
* It writes a `gsd_audit_log` row with the snapshot id, the mode and any
  override.
* The SQLite and `tasks.json` legs fail loudly rather than `|| true`.

## Retention

| Reason | Rule |
|---|---|
| `auto` | keep the last **7** (matching today's `services/backup.py` `auto_backup`) |
| `manual` | **never pruned automatically** |
| every other reason | kept **30 days** and never fewer than the last **3** |

On top of all three, **the newest `verified` snapshot of any reason is never
deleted**: a retention rule that can delete the only restorable artefact of a
class is not a retention rule. `prune --dry-run` prints what it would remove.

## The guard: 24 hours, fail closed

`services/backup_guard.py` holds one predicate, used in two Python call sites:

```
recent_verified_backup(max_age_hours=24, scope="all", backups_dir=None,
                       dsn_fingerprint=None) -> (ok, manifest_or_None, reason)
require_recent_backup(step=..., ...)   # raises BackupRequired with a remedy
```

A snapshot counts only when it carries `verified_at`, its `reason` is a
data-touching one **or** `manual` (`auto` does **not** count — a daily
background copy is not evidence that anybody thought about this step), its
`scope` covers the step's, its `created_at` is within **24 hours** (decision
D7), and — when a fingerprint is given — it names the same database.

Reason strings: `ok`, `no_snapshot`, `unverified_only`, `stale`,
`scope_mismatch`, `fingerprint_mismatch`, `disarmed`.

**Call sites in this plan:**

* `services/migrate_runner.py` — in `apply_migrations` after the DSN is resolved
  and **before the first `BEGIN`** (so a refusal has not even opened a
  connection), and in `auto_baseline`;
* `services/migrate_sqlite_to_pg.py` — in `migrate()` when `dry_run` is False.

`--dry-run` and `--status` are **never** gated, which is what keeps the
cutover's read-only census read-only.

`bin/init.cjs`'s six installer call sites are plan **89-11**'s (Phase 89
decision D8: all of the phase's edits to that canary-pinned file land in one
plan).

### Arming — kill-switch-first

| Environment | Armed? |
|---|---|
| nothing set | **yes** |
| `GSD_BACKUP_GUARD=off` | no |
| `GSD_BACKUP_GUARD=on` | **yes**, always |
| `GSD_TEST_MODE` truthy | no |
| `CI` set and non-empty | no |
| `CI` set **and** `GSD_BACKUP_GUARD=on` | **yes** |

The suite is therefore unaffected by default — and CI arms it explicitly in
`tests/test_89_04_backup_guard.py` to prove it **fires**, because a guard CI
never sees fire is a guard nobody has tested.

### The refusal and its remedy

```json
{ "error": "backup_required", "step": "migrations", "scope": "all",
  "max_age_hours": 24, "guard_reason": "no_snapshot",
  "newest": null, "newest_age_hours": null,
  "remedy": "<python> services/backup_snapshot.py for migrations --backups-dir …",
  "override_flags": ["--allow-stale-backup", "--no-backup-check"],
  "kill_switch": "GSD_BACKUP_GUARD=off" }
```

The `remedy` is a command that **exists** and is runnable **exactly as
printed** — the test extracts it, splits it and runs it unchanged, then asserts
the guard passes. A remedy nobody has run is a guess.

### Overrides are explicit and recorded

| Flag | Effect |
|---|---|
| `--allow-stale-backup` | accept a verified snapshot older than 24 hours |
| `--no-backup-check` | skip the check entirely; prints the full consequence sentence |

Both are written to `gsd_audit_log` (`event_type = 'backup_guard_override'`)
where a database is reachable, and to the install record's `last_override`
where one exists. Neither creates an install record that was not there.

## Where `pg_dump` comes from

Resolution order, measured per cell rather than assumed:

1. `GSD_PG_DUMP_BIN` / `GSD_PG_RESTORE_BIN` when set — an absolute path,
   validated to exist. A set-but-wrong value is an **error**, not a silent
   fall-through.
2. A host tool whose **major version is >= the server's**. An older client is
   refused: it produces an archive the server's own `pg_restore` may not accept.
3. `docker exec <container> <tool>` — **only** when `GSD_BACKUP_ALLOW_DOCKER=1`
   is set explicitly. The container name comes from
   `GSD_BACKUP_DOCKER_CONTAINER` (default `gsd-postgres`). No default path and
   no test reaches this step.
4. Otherwise the typed error `pg_dump_unavailable`, naming both environment
   variables and the measured client and server versions.

**The operator's own machine falls to step 3 or 4.** Measured 2026-11-12: the
host carries `pg_dump` **14.22** (Homebrew) while the container serves
PostgreSQL 16, so step 2 refuses it. For the live cutover either set
`GSD_PG_DUMP_BIN` to a 16-or-newer binary, or set `GSD_BACKUP_ALLOW_DOCKER=1`
and let the container's own client do the work.

## Windows and macOS notes

* **There is no `sqlite3` binary on Windows.** The SQLite leg uses Python's
  `sqlite3.Connection.backup()` and never shells out.
* `tar` is resolved through `services/_platform.which` and spawned as an argv
  list. There is no shell string anywhere in the module, so no quoting bug can
  turn a path into a command.
* On the Windows runner PostgreSQL 17 is installed but **not on PATH**; the tool
  resolver honours `PGBIN`, which is set there.
* `scripts/backup.sh` and `scripts/restore.sh` need `bash`, which the Windows
  cell does not have — part of why they are retired rather than fixed.
* `pg_search` (ParadeDB) has no Windows build, which is why the PostgreSQL tests
  run on the Linux cells today. Phase 89 plan 89-07 owns that.

## Retired scripts

Both scripts are kept as **loud refusals** rather than deleted: deleting them
would break operator muscle memory and any stale doc link silently, while a
refusal naming the replacement and the three defects does not. Each prints its
defects and exits **2**.
