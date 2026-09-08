#!/usr/bin/env python3
"""
services/pg_dsn.py — the one place a PostgreSQL DSN is resolved.

WHY THIS MODULE EXISTS
──────────────────────
On 2026-09-07 a test run wrote 8 ``party_session`` rows to the shared
development PostgreSQL on 127.0.0.1:5433.  Nobody in that run typed a DSN and
no test file contained a connection primitive.  The reach was three call
frames deep::

    gsd-tools.cjs party create   (node)
      -> services/party_session_cli.py            (python, spawned)
        -> services/party_session.create()
          -> services/pg_store.PGStore()          -> psycopg2 pool -> LIVE DB

and the DSN came from ``pg_store.DEFAULT_PG_URL``, a module constant that
hardcoded the shared database as the fallback for an unset
``GSD_POSTGRES_URL``.  The lane had *unset* ``GSD_POSTGRES_URL`` on purpose, to
match CI.  Unsetting the override removed the only protection and handed the
connection straight to the hardcoded pointer.  The safety measure inverted
into the hazard.

THE RULE
────────
**An absent DSN fails closed.**  There is no default, and there must never be
one again.  A hardcoded default that points at something real is not a
convenience; it is a loaded gun aimed at whatever that host happens to be on
the day configuration goes missing.

Explicit configuration is always honoured — an operator who exports
``GSD_POSTGRES_URL`` is saying yes, and containment is about the *absent*
case, not about making local development harder.

For tests and CI, export :data:`CONTAINMENT_TEST_DSN`.  It is a Unix-domain
socket in a directory that does not exist, so libpq never opens a TCP socket
at all and it cannot reach *any* host, local or remote.  That is a stronger
property than a wrong TCP port, which is merely a refused connection to a
machine you did successfully reach.
"""

from __future__ import annotations

import os
from typing import Iterable, Optional

__all__ = [
    "CONTAINMENT_TEST_DSN",
    "UnconfiguredPostgresDSN",
    "require_dsn",
    "resolve_dsn",
]

# A DSN that is structurally unable to reach a shared host.
#
#   * ``host=`` begins with ``/`` so libpq treats it as a Unix-domain socket
#     directory and NEVER falls back to TCP.
#   * the directory does not exist, so the connect fails immediately with
#     ENOENT rather than hanging on a network timeout.
#   * it carries no password, so it is safe to print, log and commit.
CONTAINMENT_TEST_DSN = (
    "postgresql:///gsd_amauta_test?host=/nonexistent/gsd-amauta-containment"
)

# Environment variables consulted, in priority order, by default.
DEFAULT_ENV_NAMES = ("DATABASE_URL", "GSD_POSTGRES_URL")


class UnconfiguredPostgresDSN(RuntimeError):
    """Raised when no PostgreSQL DSN is configured.

    Deliberately a hard failure.  The predecessor of this exception was a
    string constant pointing at a live shared database.
    """


def _message(component: str, env_names: Iterable[str]) -> str:
    names = list(env_names)
    primary = names[-1] if names else "GSD_POSTGRES_URL"
    checked = ", ".join(names) if names else primary
    return (
        f"No PostgreSQL DSN configured, and {component} refuses to guess one.\n"
        f"  checked (in order): {checked}\n"
        "\n"
        "There is deliberately NO default DSN. Until 2026-09-07 this code fell\n"
        "back to a hardcoded DSN pointing at the shared development database on\n"
        "127.0.0.1:5433. On 2026-09-07 an unset variable -- unset on purpose, to\n"
        "match CI -- routed a test run through that fallback and wrote 8 rows to\n"
        "that shared database, three call frames below a test file that contained\n"
        "no database code at all. The fallback was deleted. Do not reintroduce it:\n"
        "the next person to unset the variable is the one who pays.\n"
        "\n"
        "Set exactly one of these instead.\n"
        "\n"
        "  Local development, against a database you own:\n"
        f"      export {primary}='postgresql://USER:PASSWORD@HOST:PORT/DBNAME'\n"
        "\n"
        "  Tests, CI, and anything that must not touch a shared service:\n"
        f"      export {primary}='{CONTAINMENT_TEST_DSN}'\n"
        "    That is a Unix-domain socket in a directory that does not exist, so\n"
        "    libpq never opens a TCP socket and it cannot reach any host, local or\n"
        "    remote. A wrong TCP port would not do -- that is a refused connection\n"
        "    to a machine you did reach, not containment."
    )


def resolve_dsn(
    explicit: Optional[str] = None,
    *,
    env_names: Iterable[str] = DEFAULT_ENV_NAMES,
    environ: Optional[dict] = None,
) -> Optional[str]:
    """Return the configured DSN, or ``None`` if nothing is configured.

    Never invents a value.  An empty or whitespace-only environment variable
    counts as unset -- ``FOO=`` is how a caller says "not configured", and
    treating it as a DSN would hand libpq an empty conninfo string, which
    resolves to the ambient PG* variables and the local socket.
    """
    if explicit is not None and str(explicit).strip():
        return str(explicit)
    env = os.environ if environ is None else environ
    for name in env_names:
        val = (env.get(name) or "").strip()
        if val:
            return val
    return None


def require_dsn(
    explicit: Optional[str] = None,
    *,
    component: str = "this PostgreSQL client",
    env_names: Iterable[str] = DEFAULT_ENV_NAMES,
    environ: Optional[dict] = None,
) -> str:
    """Return the configured DSN, or raise :class:`UnconfiguredPostgresDSN`.

    This function has no fallback branch, by design.  If you are reading it
    because a test failed, the fix is to export a DSN -- see the message -- not
    to add a default here.
    """
    dsn = resolve_dsn(explicit, env_names=env_names, environ=environ)
    if dsn is None:
        raise UnconfiguredPostgresDSN(_message(component, env_names))
    return dsn
