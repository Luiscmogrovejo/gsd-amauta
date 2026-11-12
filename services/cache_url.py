#!/usr/bin/env python3
"""services/cache_url.py — the ONE place a Redis/Valkey URL is resolved (plan 89-09).

WHY THIS MODULE EXISTS
──────────────────────
Measured on master ``7c93244``: **ten** sites read **five** different environment
names with **four** different defaults, and a value exported under the canonical
name reached only some of them::

    GSD_REDIS_URL=redis://127.0.0.1:7777/9 and nothing else      resolved to
    services/amauta-daemon.py:985                   yes   redis://127.0.0.1:7777/9
    services/doctor.py:760                          yes   redis://127.0.0.1:7777/9
    services/infra_detect.py:561                    yes   redis://127.0.0.1:7777/9
    get-shit-done/bin/gsd-tools.cjs:424, :475       yes   redis://127.0.0.1:7777/9
    services/rlm_graph.py:289-290                   NO    redis://127.0.0.1:6379/0
    services/rlm_reranker.py:209-210                NO    redis://127.0.0.1:6379/0
    services/agent_hydrator.py:268                  NO    redis://localhost:6379/0
    services/amauta-mcp.py:295                      NO    no client at all
    scripts/tool-integrity.cjs:49                   NO    redis://127.0.0.1:6379

Five of the ten sites ignored it, and three of those five fell back to 6379 —
which on the operator's machine is their OWN Redis server. And none of the ten
could say WHICH name supplied the value, so an operator with two of the five set
could not tell which one won.

THE RULE
────────
One precedence chain, one default, and the supplying name is always reportable::

    GSD_REDIS_URL  ->  AMAUTA_REDIS_URL  ->  VALKEY_URL  ->  REDIS_URL
                   ->  REDIS_HOST + REDIS_PORT
                   ->  redis://127.0.0.1:<GSD_REDIS_PORT or 6379>/0

``GSD_REDIS_URL`` is canonical. The other four are legacy and warn ONCE per
process, naming the legacy variable, the canonical one and the **masked** URL.

The default's port comes from :func:`services.pg_dsn.redis_port`
(``GSD_REDIS_PORT``, default 6379) because ``services/infra_detect.py:561`` already
built its default that way and docker/docker-compose.yml publishes the container on
that variable — a default that ignored it would move infra detection off the port
the container is actually on. With ``GSD_REDIS_PORT`` unset it is
``redis://127.0.0.1:6379/0``, which is what four of the ten sites used.

WHAT IS NOT IN THE CHAIN
────────────────────────
* ``GSD_TEST_VALKEY_URL`` — the test-side opt-in, exactly parallel to
  ``GSD_TEST_POSTGRES_URL`` (``tests/conftest.py:160``). CI hands the disposable
  Valkey over under that name and ``tests/conftest.py`` decides what to do with it.
  A resolver that read it would let a test's cache reach the product by accident.
* ``GSD_REDIS_ENABLED`` — whether the daemon manages a cache at all, not where it
  is.
* ``GSD_REDIS_PORT`` — the host-side port docker/docker-compose.yml publishes on,
  read through :func:`services.pg_dsn.redis_port` for the DEFAULT only.

This module resolves STRINGS. It constructs no client and opens no socket: the
local 6379 is the operator's own Redis server, not a container this project owns.

Example:
    >>> redis_url({"GSD_REDIS_URL": "redis://127.0.0.1:7000/0"})
    'redis://127.0.0.1:7000/0'
    >>> redis_url_source({"REDIS_HOST": "cache", "REDIS_PORT": "7001"})
    'REDIS_HOST+REDIS_PORT'
    >>> redis_url_source({})
    'default'
"""
import logging
import os

try:
    from services.pg_dsn import mask_dsn, redis_port
except ImportError:  # pragma: no cover - script-launched from services/
    from pg_dsn import mask_dsn, redis_port

log = logging.getLogger(__name__)

#: The canonical variable. Everything else is legacy.
CANONICAL = "GSD_REDIS_URL"

#: Full-URL names, in precedence order. The first non-blank one wins.
URL_NAMES = (CANONICAL, "AMAUTA_REDIS_URL", "VALKEY_URL", "REDIS_URL")

#: The host+port rung, below every URL name.
HOST_NAME = "REDIS_HOST"
PORT_NAME = "REDIS_PORT"

#: What :func:`redis_url_source` returns for the host+port rung.
HOST_PORT_SOURCE = "%s+%s" % (HOST_NAME, PORT_NAME)

#: What :func:`redis_url_source` returns when nothing at all is configured.
DEFAULT_SOURCE = "default"

#: Every name this module reads, for the lint and the scrub lists.
LEGACY_NAMES = ("AMAUTA_REDIS_URL", "VALKEY_URL", "REDIS_URL", HOST_NAME, PORT_NAME)

#: Process-global: the legacy names already warned about.
_WARNED = set()


def _env(env):
    """``os.environ`` unless a mapping was given (so tests pass a dict)."""
    return os.environ if env is None else env


def default_url(env=None):
    """The URL used when nothing is configured.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        str: ``redis://127.0.0.1:<GSD_REDIS_PORT or 6379>/0``.
    """
    return "redis://127.0.0.1:%s/0" % redis_port(_env(env))


def resolve(env=None):
    """Resolve the cache URL AND the name that supplied it, in one pass.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        tuple: ``(url, source)``. ``source`` is one of :data:`URL_NAMES`,
        :data:`HOST_PORT_SOURCE` or :data:`DEFAULT_SOURCE`.

    Example:
        >>> resolve({"VALKEY_URL": "redis://h:1/0"})
        ('redis://h:1/0', 'VALKEY_URL')
    """
    environ = _env(env)
    for name in URL_NAMES:
        value = (environ.get(name) or "").strip()
        if value:
            return value, name
    host = (environ.get(HOST_NAME) or "").strip()
    port = (environ.get(PORT_NAME) or "").strip()
    if host or port:
        return (
            "redis://%s:%s/0" % (host or "127.0.0.1", port or redis_port(environ)),
            HOST_PORT_SOURCE,
        )
    return default_url(environ), DEFAULT_SOURCE


def _warn_once(url, source):
    """Warn ONCE per process that a legacy name supplied the cache URL.

    Args:
        url: the resolved URL; only its MASKED form is ever logged.
        source: the name that supplied it.

    Returns:
        bool: True when this call emitted the warning.
    """
    if source == CANONICAL or source == DEFAULT_SOURCE or source in _WARNED:
        return False
    _WARNED.add(source)
    log.warning(
        "cache URL came from %s, which is deprecated: export %s instead (resolved: %s)",
        source, CANONICAL, mask_dsn(url),
    )
    return True


def redis_url(env=None):
    """The resolved cache URL, warning once per process on a legacy name.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        str: a ``redis://`` URL. Never None: the caller that needs to know
        whether anything was CONFIGURED asks :func:`redis_url_source` and
        compares with :data:`DEFAULT_SOURCE` — ``services/amauta-mcp.py`` does
        exactly that, so an unconfigured MCP server still opens no socket.

    Example:
        >>> redis_url({"GSD_REDIS_URL": "redis://127.0.0.1:7000/0"})
        'redis://127.0.0.1:7000/0'
    """
    url, source = resolve(env)
    _warn_once(url, source)
    return url


def redis_url_source(env=None):
    """Which environment name supplied the cache URL.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        str: one of :data:`URL_NAMES`, :data:`HOST_PORT_SOURCE`, or
        :data:`DEFAULT_SOURCE` when nothing is configured.

    Example:
        >>> redis_url_source({})
        'default'
    """
    return resolve(env)[1]


def masked_redis_url(env=None):
    """The resolved URL with any password masked, for reporting.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        str: :func:`services.pg_dsn.mask_dsn` of :func:`redis_url`.

    Example:
        >>> masked_redis_url({"REDIS_URL": "redis://u:secret@h:6379/0"})
        'redis://u:***@h:6379/0'
    """
    return mask_dsn(resolve(env)[0])


def report(env=None):
    """The reporting fragment ``doctor`` and ``/health`` both publish.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{"cache_url_source", "cache_url_masked", "cache_url_canonical"}``.
        The URL is masked, always: a cache DSN can carry a password.

    Example:
        >>> report({"VALKEY_URL": "redis://u:p@h:1/0"})["cache_url_source"]
        'VALKEY_URL'
    """
    url, source = resolve(env)
    return {
        "cache_url_source": source,
        "cache_url_masked": mask_dsn(url),
        "cache_url_canonical": CANONICAL,
    }
