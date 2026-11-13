# Keys and secrets

How the daemon and the Python entry points get their API keys, and what the
product is allowed to say about them.

## The rule

**No agent, no log and no report ever emits a key value** — not the value, not a
prefix or suffix, not its length. Reports state **presence** and **source**
only. Agents test for presence; they never read, print, copy or upload the
contents of the keys file or of any `.env`.

## The keys file

| | |
|---|---|
| Path | `~/.amauta/env` — `<home>/.amauta/env`, resolved with `pathlib.Path.home()` (`%USERPROFILE%\.amauta\env` on Windows) |
| Permissions | owner-only: `chmod 600 ~/.amauta/env` (`0400` is accepted too) |
| Format | `NAME=value` lines; `#` comments and blank lines are skipped; one layer of quotes comes off |
| Location | outside every repository, so it cannot be committed, indexed or shipped |

The file is deliberately not named `.env`: no leading dot, so it is obviously a
managed file and not a per-project one.

Names the product reads from it: `VOYAGE_API_KEY` (embeddings),
`PERPLEXITY_API_KEY` (research-chain web leg), `OPENAI_API_KEY` (embedding
fallback). No Anthropic key is needed or read: model calls go through the host
runtime.

**Nothing creates the file implicitly.** The loader never does. The installer
creates it with mode `0600` and a commented template (plan 89-11); the operator
types the values in.

## What reads it, and in what order

One loader, `services/_dotenv.py`, runs at import time in the four Python entry
points: `amauta.py`, `services/amauta-daemon.py`, `services/rlm-service.py` and
`services/amauta-mcp.py`.

1. **The process environment always wins.** A variable that is already set is
   never overridden by a file.
2. **The keys file** — `GSD_DOTENV_PATH` when it is set, otherwise
   `~/.amauta/env`.
3. **The legacy files, unchanged**: `<repo_root>/.env`, else `/srv/amauta/.env`
   (the first of the two that exists is the only one of the two that is read).

The keys file is a layer in front of the legacy files, not a replacement: a
name it does not define still comes from the legacy `.env`. Creating the keys
file therefore switches nothing off.

### `GSD_DOTENV_PATH`

Names the keys file explicitly, and is honoured **always** — in a test session
and outside one. It replaces the default `~/.amauta/env` (the two are not both
read). The launchd service sets it in its plist (plan 89-14), so the daemon's
source of keys can be read from the plist alone while the plist itself holds no
secret.

A value placed directly in the plist's `EnvironmentVariables`, or set with
`launchctl setenv`, is not supported: the first is world-readable and shown by
`launchctl print`, the second is session-global and does not survive a reboot.
The macOS Keychain is the better long-term home and is deferred to the managed
environment file work of Phase 96 (CFG-08).

### In a test session

Under `GSD_TEST_MODE` (`1`/`true`/`yes`/`on`) or `PYTEST_CURRENT_TEST` the
loader is **inert**: it reads neither `~/.amauta/env` nor any `.env`. The single
opt-in is `GSD_DOTENV_PATH`, which a test sets to a temporary file holding an
obviously fake value. The reporting functions follow the same rule, and judge it
on the process environment even when they are handed a mapping.

## A keys file that is too open is refused

**POSIX (Linux, macOS).** If the keys file has any group or other permission
bit, nothing is read from it and the loader raises
`ManagedEnvPermissionError` (a `PermissionError`, code `MANAGED_ENV_TOO_OPEN`):

```
refusing to read the keys file /home/u/.amauta/env: its mode is 0644, so it is
accessible by the group or by other users. It must be owner-only.
Fix: chmod 600 /home/u/.amauta/env
```

The mode is checked on the open file descriptor, so the file that is checked is
the file that is read, and a symbolic link is judged by its target. The entry
point stops; it does not continue without keys. `doctor` does not stop: it
prints a `WARN` row with the same fix and reports the key absent.

**Windows.** There are no POSIX mode bits and the access-control list is **not**
inspected. The file is read as it is. `doctor` and `/health` say so:
`permissions: "not_checked_windows"`, and the `doctor` row reads "its
permissions are NOT checked on Windows". The file sits under the user profile,
whose default ACL grants the user, SYSTEM and Administrators; keeping it there
is the protection. What is **not** checked on Windows: inherited or explicit ACL
entries for other accounts.

**Not checked on any platform:** the file's owner (a `0600` file owned by another
account cannot be opened anyway, except by root), and the permissions of the
legacy `.env` files, whose handling is unchanged.

## Reporting: presence and source only

```
python3 services/doctor.py --json      # the check whose "category" is "keys"
python3 services/doctor.py             # the "keys" row
GET /health                            # extra.keys
```

Both carry, per key:

```json
{"VOYAGE_API_KEY": {"present": true, "source": "managed_env_file"}}
```

| `source` | Meaning |
|---|---|
| `managed_env_file` | the keys file (`~/.amauta/env` or `GSD_DOTENV_PATH`) |
| `repo_dotenv` | `<repo_root>/.env` |
| `deploy_dotenv` | `/srv/amauta/.env` |
| `process_env` | already set in the environment the process was started with |
| `absent` | not present (also: set but empty, or the keys file was refused) |

and one entry for the file itself:

```json
{"_managed_env_file": {"path": "/home/u/.amauta/env", "explicit": false,
                       "exists": true, "permissions": "owner_only"}}
```

`permissions` is `owner_only`, `refused_group_or_world_accessible`,
`not_checked_windows` or `file_absent`.

`doctor` answers for the install — what an entry point holds after its loader
has run. `/health` `extra.keys` is the daemon answering for its own process, and
is the one to read to confirm the running daemon has a key.

Keys never appear in a command line, so they are not visible in a process
listing: they travel in the file and in the process environment only.

## Not indexed, not shipped

A file named exactly `env` has no suffix, so the code index
(`services/rlm_ingestion.py`) does not index it; a test asserts that property.
The keys file is outside the repository, so it is not part of the shipped set.
