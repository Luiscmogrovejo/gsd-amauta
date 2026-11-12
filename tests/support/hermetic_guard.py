"""Hermetic connection guard for Python tests (Phase 88, plans 88-01 and 88-16-03).

What changed in 88-16-03, and why
---------------------------------

Until this plan the guard was a **deny-list of four ports** wrapped around
``socket.socket.connect``/``connect_ex``. It never looked at the host, it wrote
no log at all, and it read ``GSD_HERMETIC_GUARD_ALLOW_PORTS`` once at install
time, so a fixture that set an allow-list afterwards changed nothing.

It is now **default-deny for every non-loopback destination**:

* **Loopback is permitted**, defined before anything is denied: ``localhost``,
  anything in ``127.0.0.0/8``, ``::1``, a ``None`` or ``''`` host, and any
  AF_UNIX connection (the address is a path, not a tuple). Five ``.py`` tests
  connect to ``localhost`` and the fixture daemon binds an ephemeral loopback
  port, so getting this wrong breaks the harness, not a test.
* **Loopback is still subject to the live-port block.** Allowing a port never
  unblocks 18799, 18798, 6379 or 5433; asking for one makes ``install()``
  REFUSE TO ARM. An allowed *host* of ``localhost``/``127.0.0.1`` is refused
  for the same reason.
* **A raw non-loopback IP is denied inside ``connect`` itself**, not only at
  name resolution: wrapping ``getaddrinfo`` alone leaves
  ``sock.connect(("93.184.216.34", 443))`` straight through.
* **``socket.create_connection`` and ``socket.getaddrinfo`` are wrapped too**,
  so the host is resolved — and refused — BEFORE the connection. ``getaddrinfo``
  is only refused when a port was supplied, i.e. when the lookup is for an
  outbound connection; a bare name lookup (``socket.getfqdn`` during a server
  bind) is left alone.
* **Every refusal appends one line** to ``GSD_HERMETIC_GUARD_LOG``. The guard
  had no log at all before, so plan 88-17's "the API host was never contacted,
  asserted on the guard log" would have passed vacuously.
* **The allow-lists are read at CHECK time**, so a per-test fixture works.

Environment
-----------
    GSD_HERMETIC_GUARD=off                install() is a no-op
    GSD_HERMETIC_GUARD_MODE=log           record refusals, do not raise
    GSD_HERMETIC_GUARD_ALLOW_PORTS=a,b    loopback ports exempted from an extra
                                          block; never a live port
    GSD_HERMETIC_GUARD_ALLOW_HOSTS=h1,h2  non-loopback hosts this test may reach
    GSD_HERMETIC_GUARD_LOG=<file>         append one line per refusal

Documented gap: C-extension clients (libpq) and subprocesses such as ``psql``
bypass an in-process patch. The guard is the alarm; the environment scrub and
the fixture services are the control. ``tests/support/pg-fixture.cjs`` and
``tests/conftest.py`` additionally refuse a DSN whose port is a live port, which
is the control libpq DOES obey.
"""
import datetime
import os
import re
import socket

DEFAULT_BLOCKED = (18799, 18798, 6379, 5433)
LIVE_PORTS = frozenset(DEFAULT_BLOCKED)

_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_LOOPBACK_V4 = re.compile(r"^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
_MAPPED_V4 = re.compile(r"^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


class GuardArmRefused(RuntimeError):
    """Raised by install() when the allow-lists ask for something never allowable."""


def _port_of(address):
    """Return the port of an AF_INET/AF_INET6 address tuple, or None.

    Args:
        address: the argument handed to ``socket.connect``.

    Returns:
        The port as an int, or None when the address is not a (host, port) tuple.
    """
    if isinstance(address, tuple) and len(address) >= 2:
        try:
            return int(address[1])
        except (TypeError, ValueError):
            return None
    return None


def _host_of(address):
    """Return the host of an AF_INET/AF_INET6 address tuple, or None."""
    if isinstance(address, tuple) and len(address) >= 1:
        return address[0]
    return None


def is_loopback_host(host):
    """Is this host the local machine?

    Written down before anything is denied. ``None`` and ``''`` count as
    loopback: ``socket.create_connection((None, port))`` means localhost.

    Args:
        host: a host name or address, or None.

    Returns:
        bool

    Example:
        >>> is_loopback_host("127.0.0.1"), is_loopback_host("::1"), is_loopback_host(None)
        (True, True, True)
        >>> is_loopback_host("api.voyageai.com")
        False
    """
    if host is None:
        return True
    h = str(host).strip().lower()
    if h == "":
        return True
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h in ("localhost", "localhost.", "localhost.localdomain"):
        return True
    if h in ("::1", "0:0:0:0:0:0:0:1"):
        return True
    return bool(_LOOPBACK_V4.match(h) or _MAPPED_V4.match(h))


def is_ip_literal(host):
    """True when ``host`` looks like a literal address rather than a name."""
    h = str(host or "").strip().strip("[]")
    if _IPV4.match(h):
        return True
    return ":" in h and bool(re.match(r"^[0-9a-fA-F:.]+$", h))


def _allowed_ports(env=None):
    """Parse GSD_HERMETIC_GUARD_ALLOW_PORTS into a set of ints. Read at check time."""
    env = os.environ if env is None else env
    out = set()
    for part in env.get("GSD_HERMETIC_GUARD_ALLOW_PORTS", "").split(","):
        part = part.strip()
        if part.isdigit():
            out.add(int(part))
    return out


def _allowed_hosts(env=None):
    """Parse GSD_HERMETIC_GUARD_ALLOW_HOSTS into a set of names. Read at check time."""
    env = os.environ if env is None else env
    return {
        p.strip().lower()
        for p in env.get("GSD_HERMETIC_GUARD_ALLOW_HOSTS", "").split(",")
        if p.strip()
    }


def arm_refusal(env=None):
    """Why the guard must not arm with this environment, or None when it may.

    Args:
        env: mapping to read (defaults to ``os.environ``).

    Returns:
        str | None: the loud message, or None.
    """
    env = os.environ if env is None else env
    asked = sorted(p for p in _allowed_ports(env) if p in LIVE_PORTS)
    if asked:
        return (
            "HERMETIC GUARD REFUSES TO ARM: GSD_HERMETIC_GUARD_ALLOW_PORTS asks for live "
            "service port(s) %s. 18799 (daemon), 18798 (RLM), 6379 (Redis) and 5433 (the "
            "operator's PostgreSQL) can never be allowed."
            % ",".join(str(p) for p in asked)
        )
    hosts = sorted(h for h in _allowed_hosts(env) if is_loopback_host(h))
    if hosts:
        return (
            "HERMETIC GUARD REFUSES TO ARM: GSD_HERMETIC_GUARD_ALLOW_HOSTS asks for loopback "
            "host(s) %s. Loopback is already permitted and stays subject to the live-port "
            "block; allowing it by name would be a back door." % ",".join(hosts)
        )
    return None


def decide(host, port, *, is_unix=False, extra_blocked=(), env=None):
    """Decide whether one destination may be reached. Read at CHECK time.

    Args:
        host: the destination host (None/'' means loopback).
        port: the destination port, or None.
        is_unix: True for an AF_UNIX address.
        extra_blocked: ports blocked in addition to the live ones.
        env: mapping to read (defaults to ``os.environ``).

    Returns:
        tuple[bool, str]: ``(allowed, reason)``.
    """
    env = os.environ if env is None else env
    if is_unix:
        return True, "af-unix"

    blocked = set(LIVE_PORTS) | set(extra_blocked)
    for p in _allowed_ports(env):
        if p not in LIVE_PORTS:
            blocked.discard(p)

    if port is not None and port in blocked:
        return False, "live-port"
    if is_loopback_host(host):
        return True, "loopback"
    if str(host).strip().lower() in _allowed_hosts(env):
        return True, "allow-host"
    return False, "non-loopback-ip" if is_ip_literal(host) else "non-loopback-host"


def _mode(env=None):
    """'log' during the rollout inventory, 'enforce' otherwise."""
    env = os.environ if env is None else env
    return "log" if env.get("GSD_HERMETIC_GUARD_MODE", "").strip().lower() == "log" else "enforce"


def log_refusal(host, port, reason, env=None):
    """Append one TSV line to ``GSD_HERMETIC_GUARD_LOG``. Best effort.

    Args:
        host: the refused host.
        port: the refused port, or None.
        reason: the machine-readable reason.
        env: mapping to read (defaults to ``os.environ``).

    Returns:
        None.
    """
    env = os.environ if env is None else env
    path = env.get("GSD_HERMETIC_GUARD_LOG")
    if not path:
        return
    try:
        import sys as _sys

        line = "\t".join(
            [
                datetime.datetime.now(datetime.timezone.utc).isoformat(),
                str(os.getpid()),
                _mode(env),
                "python",
                str(host) if host not in (None, "") else "(none)",
                "(none)" if port is None else str(port),
                reason,
                " ".join(_sys.argv[:4]),
            ]
        )
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:  # best effort: the raise below is the real signal
        pass


def _message(host, port, reason):
    """The RuntimeError text a refusal carries."""
    where = "%s:%s" % (host if host not in (None, "") else "(no host)", "?" if port is None else port)
    if reason == "live-port":
        return (
            "HERMETIC GUARD: test tried to connect to live service port %s (%s); use the "
            "fixture daemon (tests/conftest.py::fixture_daemon), the fixture RLM "
            "(tests/conftest.py::fixture_rlm) or the disposable Postgres DSN "
            "(tests/conftest.py::postgres_dsn)" % (port, where)
        )
    return (
        "HERMETIC GUARD: test tried to reach the network at %s. Tests are default-deny for "
        "every non-loopback destination. If this one legitimately must call out, allow "
        "exactly that host for exactly that test with the `allow_host` fixture "
        "(tests/conftest.py), never session-wide." % where
    )


def _enforce(host, port, is_unix, blocked, env=None):
    """Raise or record, according to the verdict and the mode."""
    allowed, reason = decide(host, port, is_unix=is_unix, extra_blocked=blocked, env=env)
    if allowed:
        return
    log_refusal(host, port, reason, env=env)
    if _mode(env) == "enforce":
        raise RuntimeError(_message(host, port, reason))


def install(blocked=DEFAULT_BLOCKED):
    """Install the guard on the socket and name-resolution entry points.

    Idempotent: a second call returns without wrapping again.

    Args:
        blocked: iterable of ports that must not be connected to (the live four
            are always blocked; this adds to them).

    Returns:
        True when the guard is installed (now or earlier), False when disabled
        through ``GSD_HERMETIC_GUARD=off``.

    Raises:
        GuardArmRefused: when the allow-lists ask for a live port or for
            loopback by name. Refusing loudly is deliberate: an allow-list that
            quietly drops its dangerous entries leaves a test proving something
            nobody asked for.

    Example:
        >>> install()
        True
    """
    if os.environ.get("GSD_HERMETIC_GUARD", "").strip().lower() == "off":
        return False

    refusal = arm_refusal()
    if refusal:
        raise GuardArmRefused(refusal)

    if getattr(socket.socket.connect, "_gsd_hermetic", False):
        return True

    extra = tuple(p for p in blocked if p not in LIVE_PORTS)
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_create_connection = socket.create_connection
    original_getaddrinfo = socket.getaddrinfo

    def _check_address(address):
        is_unix = isinstance(address, (str, bytes))
        _enforce(_host_of(address), _port_of(address), is_unix, extra)

    def connect(self, address):
        _check_address(address)
        return original_connect(self, address)

    def connect_ex(self, address):
        _check_address(address)
        return original_connect_ex(self, address)

    def create_connection(address, *args, **kwargs):
        _enforce(_host_of(address), _port_of(address), False, extra)
        return original_create_connection(address, *args, **kwargs)

    def getaddrinfo(host, port, *args, **kwargs):
        # Only an outbound lookup is refused. A bare name lookup with no port
        # (socket.getfqdn during a server bind) is left alone on purpose.
        if port not in (None, 0, ""):
            try:
                numeric_port = int(port)
            except (TypeError, ValueError):
                numeric_port = None
            _enforce(host, numeric_port, False, extra)
        return original_getaddrinfo(host, port, *args, **kwargs)

    def getfqdn(name=""):
        """A reverse lookup is a network call; a hermetic test must not make one.

        ``http.server.HTTPServer.server_bind`` calls ``socket.getfqdn(host)``
        for the sole purpose of filling ``server_name``, which nothing reads.
        On the GitHub macOS runner that resolver call takes longer than any
        sane test budget: plan 88-18 measured the daemon stalling past 20 s on
        exactly this line and fixed it by overriding ``server_bind``.
        ``services/amauta-mcp.py`` has the identical stall at its
        ``_ThreadedServer``, it is a canary-pinned file, and its SSE path is
        SEC-06 / Phase 90 work — so the fix belongs here, in the harness, where
        it is also the correct policy: default-deny already forbids resolving a
        non-loopback name, and this is the same prohibition applied to the
        reverse direction.

        Args:
            name: the host to canonicalise.

        Returns:
            str: the name unchanged (``localhost`` for the empty default).
        """
        return name or "localhost"

    connect._gsd_hermetic = True
    connect_ex._gsd_hermetic = True
    create_connection._gsd_hermetic = True
    getaddrinfo._gsd_hermetic = True
    getfqdn._gsd_hermetic = True
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.create_connection = create_connection
    socket.getaddrinfo = getaddrinfo
    socket.getfqdn = getfqdn
    return True
