#!/usr/bin/env python3
"""services/report_hooks.py — the two reporting extension points (plan 89-09 task 05).

WHY THIS MODULE EXISTS
──────────────────────
Phase 89's first draft had **five** plans editing ``services/amauta-daemon.py`` and
**four** editing ``services/doctor.py``, every one of them only to add ONE reporting
row. Two files shared by nine plans is what forces a ten-wave layout in which
nothing runs in parallel. Both files now carry one extension point instead, and a
later plan contributes its row from its OWN module.

WHY THE REGISTRY IS HERE AND NOT IN THE DAEMON
──────────────────────────────────────────────
A registry *inside* ``services/amauta-daemon.py`` would still have to import the
provider modules, so every later plan would still edit the daemon — which is the
collision this task exists to remove. The registry, the provider list and the
error handling therefore live in this file, and the daemon and ``doctor`` each
call it once:

    services/amauta-daemon.py   health["extra"] = report_hooks.extra_health_rows()
    services/doctor.py          for r in report_hooks.extra_doctor_rows(): row(*r)

THE CONTRACT FOR LATER PLANS — read this before editing the daemon or doctor
───────────────────────────────────────────────────────────────────────────
Add a module with ``health_fragment()`` and/or ``doctor_rows()``, name it in
:data:`PROVIDER_MODULES`, and **do not touch** ``services/amauta-daemon.py`` or
``services/doctor.py``:

* **plan 89-06** — the lexical-engine row: which engine answers the lexical leg
  (``pg_search`` or the plain-PostgreSQL full-text fallback, decision D3).
* **plan 89-08** — the embedding-catalogue row: the active embedding and rerank
  models and the vector count behind them.
* **plan 89-10** — the key-presence rows: which API keys are PRESENT (never a
  value, never a prefix — decision 11 of 89-CONTEXT.md).

A provider that raises is caught and reported as a named degraded entry. It can
never take ``/health`` or ``doctor`` down: an endpoint that fails because a
REPORTER failed is worse than one missing a row.

Example:
    >>> rows = extra_doctor_rows({"GSD_REDIS_URL": "redis://127.0.0.1:6379/0"})
    >>> rows[0][1]
    'cache'
"""
import logging

try:
    from services import cache_url
except ImportError:  # pragma: no cover - script-launched from services/
    import cache_url

log = logging.getLogger(__name__)

#: ``doctor``'s own status strings. Asserted against services/doctor.py's in
#: tests/test_89_09_extension_hooks.py, so the renderer stays untouched.
STATUS_OK = "OK  "
STATUS_WARN = "WARN"
STATUS_FAIL = "FAIL"

#: The key the daemon publishes this section under, and the key a failed provider
#: is named in.
HEALTH_SECTION = "extra"
DEGRADED_KEY = "_degraded"

#: Provider modules, imported best-effort at call time. A module that is absent
#: from an install is simply not a provider — never an error, because `doctor`
#: must still run on a partial install. Plans 89-06, 89-08 and 89-10 add their
#: module name HERE, not to the daemon or to doctor.
#: plan 89-06 registered `_89_06_reporting` here (the lexical-engine row,
#: decision D3) -- one line, in the file the contract above names, and NOT in
#: services/doctor.py or services/amauta-daemon.py.
PROVIDER_MODULES = ("_89_06_reporting",)


def _import_providers():
    """Import every module named in :data:`PROVIDER_MODULES`.

    Returns:
        list: ``(name, module)`` pairs for the modules that imported.
    """
    found = []
    for name in PROVIDER_MODULES:
        try:
            try:
                module = __import__("services.%s" % name, fromlist=[name])
            except ImportError:
                module = __import__(name)
        except Exception as exc:  # noqa: BLE001 - reported, never hidden
            log.warning("report_hooks_provider_import_failed name=%s error=%s", name, exc)
            continue
        found.append((name, module))
    return found


def _cache_health_fragment(env=None):
    """This plan's own row: which environment name supplied the cache URL.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``services/cache_url.py`` ``report()``, whose URL is always MASKED.
    """
    return cache_url.report(env)


def _cache_doctor_rows(env=None):
    """The same fact as a ``doctor`` row.

    The status is always OK: the row is informational, and a WARN would move
    ``doctor``'s exit code to 1 for every install that still uses a legacy name.
    The deprecation itself is warned once per process by the resolver.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        list: one ``(status, category, detail, data)`` tuple.
    """
    data = cache_url.report(env)
    detail = "%s from %s (%s)" % (
        data["cache_url_masked"], data["cache_url_source"],
        "canonical" if data["cache_url_source"] == data["cache_url_canonical"]
        else "canonical name is %s" % data["cache_url_canonical"],
    )
    return [(STATUS_OK, "cache", detail, data)]


#: This plan's own provider, the hook's FIRST consumer — so it ships proven rather
#: than speculative. Named here rather than in PROVIDER_MODULES because
#: services/cache_url.py must stay a pure resolver and cannot import this module
#: without a cycle.
_BUILTIN_PROVIDERS = (("cache", _cache_health_fragment, _cache_doctor_rows),)


def _providers():
    """Every provider: the built-in one, then the modules of :data:`PROVIDER_MODULES`.

    Returns:
        list: ``(name, health_fragment or None, doctor_rows or None)`` triples.
    """
    out = list(_BUILTIN_PROVIDERS)
    for name, module in _import_providers():
        out.append((name, getattr(module, "health_fragment", None), getattr(module, "doctor_rows", None)))
    return out


def extra_health_rows(env=None):
    """The ``/health`` section every provider contributes to (plan 89-09 task 05).

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{provider_name: fragment}``, plus ``"_degraded"`` naming any
        provider that raised. Never raises: a reporter that fails must not take
        ``/health`` down.

    Example:
        >>> "cache" in extra_health_rows({})
        True
    """
    section = {}
    degraded = []
    for name, health_fragment, _doctor_rows in _providers():
        if health_fragment is None:
            continue
        try:
            fragment = health_fragment(env)
            if fragment is None:
                continue
            if not isinstance(fragment, dict):
                raise TypeError("health_fragment must return a dict, got %s" % type(fragment).__name__)
            section[name] = fragment
        except Exception as exc:  # noqa: BLE001 - named, never hidden
            log.warning("health_provider_failed name=%s error=%s", name, exc)
            degraded.append("%s: %s" % (name, exc))
    if degraded:
        section[DEGRADED_KEY] = degraded
    return section


def extra_doctor_rows(env=None):
    """The ``doctor`` rows every provider contributes (plan 89-09 task 05).

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        list: ``(status, category, detail, data)`` tuples in ``doctor``'s own
        vocabulary, so the renderer is untouched. A provider that raises becomes
        one WARN row naming it, never an exception.

    Example:
        >>> [r[1] for r in extra_doctor_rows({})]
        ['cache']
    """
    rows = []
    for name, _health_fragment, doctor_rows in _providers():
        if doctor_rows is None:
            continue
        try:
            produced = doctor_rows(env) or []
            for entry in produced:
                status, category, detail, data = entry
                rows.append((status, category, detail, data or {}))
        except Exception as exc:  # noqa: BLE001 - named, never hidden
            log.warning("doctor_provider_failed name=%s error=%s", name, exc)
            rows.append((STATUS_WARN, name, "reporter failed: %s" % exc, {}))
    return rows
