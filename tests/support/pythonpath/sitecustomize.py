"""Chaining sitecustomize that installs the hermetic socket guard (plan 88-01).

The Node runner puts this directory on PYTHONPATH so Python subprocesses spawned by
Node tests (amauta.py, services/amauta-daemon.py) are guarded too.

It MUST run the interpreter's own ``sitecustomize`` first: Homebrew Python uses one
to add its site-packages, and shadowing it makes pytest/numpy disappear.

Fail-loud (plan 88-18): arming the guard used to end in ``except Exception: pass``, so
a child whose guard failed to arm said nothing and ran unguarded. When
``GSD_HERMETIC_GUARD_REQUIRED=1`` is set (``scripts/run-tests.cjs`` sets it for every
Node-spawned child) a guard that did not arm now prints one line to stderr and ends the
interpreter with a non-zero status. Without that variable the behaviour is unchanged,
so no existing caller breaks. ``GSD_HERMETIC_GUARD=off`` is the explicit operator
opt-out and still wins: it is a choice, not a failure to arm.
"""
import importlib
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REQUIRED_EXIT = 70


def _required():
    """True when a guard that did not arm must end the interpreter."""
    return os.environ.get("GSD_HERMETIC_GUARD_REQUIRED", "").strip() == "1"


def _opted_out():
    """True when the operator switched the guard off on purpose."""
    return os.environ.get("GSD_HERMETIC_GUARD", "").strip().lower() == "off"


def _arm_guard():
    """Load ``tests/support/hermetic_guard.py`` by absolute path and install it.

    Returns:
        A pair ``(armed, reason)``: ``armed`` is True when ``socket.socket.connect``
        carries the guard marker afterwards; ``reason`` names the failure otherwise.
    """
    try:
        import socket

        path = os.path.normpath(os.path.join(_HERE, "..", "hermetic_guard.py"))
        spec = importlib.util.spec_from_file_location("hermetic_guard", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.install()
        if getattr(socket.socket.connect, "_gsd_hermetic", False):
            return True, ""
        return False, "install() returned without marking socket.socket.connect"
    except Exception as exc:  # reported below: loud when required, recorded otherwise
        return False, "%s: %s" % (type(exc).__name__, exc)


def _chain_and_guard():
    # 1. Chain to the interpreter's own sitecustomize (we are shadowing it).
    removed = [p for p in sys.path if os.path.abspath(p or os.getcwd()) == _HERE]
    for p in removed:
        sys.path.remove(p)
    saved = sys.modules.pop("sitecustomize", None)
    try:
        try:
            importlib.import_module("sitecustomize")
        except ImportError:
            pass
    finally:
        # Restore our own module entry and the path entries.
        if saved is not None:
            sys.modules["sitecustomize"] = saved
        for p in reversed(removed):
            sys.path.insert(0, p)

    # 2. Install the guard, resolved by absolute path.
    armed, reason = _arm_guard()
    if not armed and _required() and not _opted_out():
        sys.stderr.write(
            "HERMETIC GUARD NOT ARMED: GSD_HERMETIC_GUARD_REQUIRED=1 and the Python "
            "socket guard could not be installed (%s). Refusing to run this "
            "interpreter unguarded.\n" % reason
        )
        sys.stderr.flush()
        os._exit(_REQUIRED_EXIT)


_chain_and_guard()
