"""Hermetic connection guard for Python tests (Phase 88, plan 88-01).

Wraps ``socket.socket.connect`` and ``connect_ex`` so that a connection to one of
the operator's live service ports raises instead of opening a socket:

    18799 live Amauta daemon, 18798 live RLM, 6379 live Redis, 5433 live Postgres.

Environment:
    GSD_HERMETIC_GUARD=off              install() is a no-op
    GSD_HERMETIC_GUARD_ALLOW_PORTS=a,b  ports removed from the blocked set

Documented gap: C-extension clients and subprocesses such as ``psql`` bypass an
in-process patch. The guard is the alarm; the environment scrub and the fixture
daemon are the primary control.
"""
import os
import socket

DEFAULT_BLOCKED = (18799, 18798, 6379, 5433)


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


def _allowed_ports():
    """Parse GSD_HERMETIC_GUARD_ALLOW_PORTS into a set of ints."""
    out = set()
    for part in os.environ.get("GSD_HERMETIC_GUARD_ALLOW_PORTS", "").split(","):
        part = part.strip()
        if part.isdigit():
            out.add(int(part))
    return out


def install(blocked=DEFAULT_BLOCKED):
    """Install the guard on ``socket.socket.connect`` and ``connect_ex``.

    Idempotent: a second call returns without wrapping again.

    Args:
        blocked: iterable of ports that must not be connected to.

    Returns:
        True when the guard is installed (now or earlier), False when disabled
        through ``GSD_HERMETIC_GUARD=off``.

    Raises:
        Nothing at install time. The wrapped methods raise ``RuntimeError`` whose
        message starts with ``HERMETIC GUARD`` when a blocked port is targeted.

    Example:
        >>> install()
        True
    """
    if os.environ.get("GSD_HERMETIC_GUARD", "").strip().lower() == "off":
        return False
    if getattr(socket.socket.connect, "_gsd_hermetic", False):
        return True

    blocked_set = set(blocked) - _allowed_ports()
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def _check(address):
        port = _port_of(address)
        if port is not None and port in blocked_set:
            raise RuntimeError(
                "HERMETIC GUARD: test tried to connect to live service port %d; "
                "use the fixture daemon (tests/support/fixture-daemon.cjs)" % port
            )

    def connect(self, address):
        _check(address)
        return original_connect(self, address)

    def connect_ex(self, address):
        _check(address)
        return original_connect_ex(self, address)

    connect._gsd_hermetic = True
    connect_ex._gsd_hermetic = True
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    return True
