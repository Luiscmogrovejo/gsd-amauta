#!/usr/bin/env python3
"""services/_89_06_reporting.py — which engine answers the lexical leg.

Phase 89 / decision D3, plan 89-06. ``pg_search`` is OPTIONAL as of this phase,
so a database can serve the lexical leg with ParadeDB BM25 or with plain
PostgreSQL full-text — and the two do not rank a corpus alike. D3's honesty
requirement is that the product SAY WHICH, in both places an operator looks:

    doctor     a row:       WARN  lexical  lexical search: plain PostgreSQL
                                           full-text (pg_search not installed)
                                           — ranking differs from the ParadeDB
                                           BM25 leg
    /health    a fragment:  {"extra": {"lexical": {"lexical_engine": "...",
                                                   "reason": "..."}}}

WHY THIS FILE AND NOT ``services/doctor.py`` / ``services/amauta-daemon.py``
───────────────────────────────────────────────────────────────────────────
Plan 89-09 built ``services/report_hooks.py`` precisely so that a later plan
contributes a row from its own module: five Phase 89 plans editing the daemon
and four editing ``doctor`` is what forced a ten-wave layout. This plan edits
NEITHER of those two files. It adds this module and names it in
``report_hooks.PROVIDER_MODULES`` — read that module's docstring for the
contract, including the guarantee that a provider which raises becomes a named
degraded entry and can never take ``/health`` or ``doctor`` down.

WARN, NOT FAIL
──────────────
The fallback engine is a working product, not a broken one: every query is
answered, the vector leg and the RRF fusion are untouched, and only the lexical
ranking differs. FAIL would say "fix this", and on Windows — where ``pg_search``
has no build at all — there is nothing to fix. WARN says "know this".

``infra_detect.LEXICAL_UNKNOWN`` is a WARN too, with its own sentence: a probe
that could not read the catalogue has not established that the extension is
absent, and saying ``postgres_fts`` there would report a measurement nobody
made.

ONE ANSWER, THREE READERS
─────────────────────────
The engine is computed in exactly one place, ``services/infra_detect.py``
:func:`lexical_engine`, which is also what the capability pre-check and
``services/rlm_search.py``'s ``_has_pg_search`` probe read. This module adds no
second opinion: it resolves a DSN, asks that function, and formats.
"""
import logging
import os

try:
    from services import infra_detect, pg_dsn, report_hooks
except ImportError:  # pragma: no cover - script-launched from services/
    import infra_detect
    import pg_dsn
    import report_hooks

log = logging.getLogger(__name__)

#: The ``/health`` key this row lands under, inside ``report_hooks``' ``extra``
#: section — so the full path is ``health["extra"]["lexical"]``, which Phase
#: 92/96's console reads without shelling out to ``doctor``. ``report_hooks``
#: publishes a provider's fragment under its MODULE name unless the module
#: declares this; `_89_06_reporting` would have put a plan number into a public
#: payload. Same word as :data:`DOCTOR_CATEGORY`, so the two readers agree.
HEALTH_KEY = "lexical"

#: ``doctor``'s category column for this row.
DOCTOR_CATEGORY = "lexical"

#: Process-lifetime memo, keyed by the MASKED dsn (never the dsn itself, so a
#: password cannot reach a traceback through this dict). An extension is not
#: installed and uninstalled under a running daemon, and ``/health`` is polled:
#: one connection per process per database, not one per poll.
_MEMO = {}


def _env(env=None):
    return os.environ if env is None else env


def reset_cache():
    """Forget the memoised answer. For tests, and for a backend switch."""
    _MEMO.clear()
    infra_detect.reset_lexical_engine_cache()


def resolve(env=None):
    """The engine answer for this environment, or None when there is no answer.

    Returns None — not a guess — when the backend is pinned to SQLite, when no
    DSN is configured, or when the server cannot be reached. "I could not tell"
    is not an engine name, and a reporting row that invents one is worse than a
    missing row.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{"lexical_engine": ..., "reason": ...}`` or None.
    """
    env = _env(env)
    if infra_detect.force_sqlite(env):
        return None
    try:
        dsn = pg_dsn.resolve_dsn(env=env)
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        log.debug("lexical_engine_dsn_unresolved error=%s", exc)
        return None
    if not dsn:
        return None
    key = pg_dsn.mask_dsn(dsn)
    if key in _MEMO:
        return dict(_MEMO[key]) if _MEMO[key] is not None else None
    answer = infra_detect.lexical_engine_for_dsn(dsn)
    _MEMO[key] = dict(answer) if answer is not None else None
    return dict(answer) if answer is not None else None


def health_fragment(env=None):
    """The ``/health`` fragment under :data:`HEALTH_KEY`.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{"lexical_engine": "pg_search_bm25"|"postgres_fts",
        "reason": "<sentence>", "degraded": bool}``, or None when there is no
        PostgreSQL to ask (``report_hooks`` drops a None fragment).

    Example:
        >>> health_fragment({"GSD_FORCE_SQLITE": "1"}) is None
        True
    """
    answer = resolve(env)
    if answer is None:
        return None
    return {
        "lexical_engine": answer["lexical_engine"],
        "reason": answer["reason"],
        "degraded": answer["lexical_engine"] != infra_detect.LEXICAL_PG_SEARCH,
    }


def doctor_rows(env=None):
    """The same fact as one ``doctor`` row.

    OK where ParadeDB BM25 answers, WARN where the plain-PostgreSQL leg does —
    see this module's docstring for why WARN and not FAIL.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        list: one ``(status, category, detail, data)`` tuple in ``doctor``'s own
        vocabulary, or None when there is no PostgreSQL to ask.

    Example:
        >>> doctor_rows({"GSD_FORCE_SQLITE": "1"}) is None
        True
    """
    answer = resolve(env)
    if answer is None:
        return None
    is_bm25 = answer["lexical_engine"] == infra_detect.LEXICAL_PG_SEARCH
    status = report_hooks.STATUS_OK if is_bm25 else report_hooks.STATUS_WARN
    return [(status, DOCTOR_CATEGORY, answer["reason"],
             {"lexical_engine": answer["lexical_engine"]})]
