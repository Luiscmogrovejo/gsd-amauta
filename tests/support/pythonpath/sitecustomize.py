"""Chaining sitecustomize that arms test mode and the hermetic socket guard (plan 88-01).

The Node runner puts this directory on PYTHONPATH so Python subprocesses spawned by
Node tests (amauta.py, services/amauta-daemon.py) are guarded too.

It MUST run the interpreter's own ``sitecustomize`` first: Homebrew Python uses one
to add its site-packages, and shadowing it makes pytest/numpy disappear.

Fail-loud (plan 88-18): arming the guard used to end in a catch-all that passed silently, so
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


def _arm_test_mode():
    """Put ``GSD_TEST_MODE=1`` in a child's environment when it carries no answer.

    Plan 88-11 task 04. The four Python entry points load ``<repo>/.env`` at
    import time and decide whether to by reading this name, so a child that
    reached the product without it read the operator's live file. Every caller
    that matters already sets it (``scripts/run-tests.cjs`` for Node-spawned
    children, ``tests/conftest.py`` at import for pytest); this is the floor
    under both, in the same place the socket guard is armed.

    ``setdefault`` on purpose: a test that hands a child ``GSD_TEST_MODE=''``
    to exercise a non-test-mode path keeps its empty value.
    """
    os.environ.setdefault("GSD_TEST_MODE", "1")


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


_SERVICES = {"amauta-daemon.py": "daemon", "rlm-service.py": "rlm"}


def _register_service():
    """Write this process into the run's process registry when it IS a service.

    Plan 89-15. A fixture registers the daemon it spawns, but a daemon can also be
    started through a PRODUCT path (a CLI that auto-starts one, the installer's
    daemon step, the daemon's own ``start`` verb) and then no fixture knows it
    exists: left alive, it was invisible to the runner's stray-process check.
    Here the service speaks for itself. ``GSD_PROCESS_LEDGER`` in its environment
    is the proof that it belongs to this run, which is why the line is written
    only when that variable is set and why nothing is inferred from a command
    line anywhere else.

    Only the long-running ``run`` verb registers; ``start``, ``stop`` and
    ``status`` are controllers that exit by themselves. One ``self`` line is
    appended to ``<registry>.self``, never a closing one:
    ``tests/support/process-registry.cjs`` merges it into the fixture's entry
    when a fixture registered the same pid.

    Never raises: a registry that cannot be written must not stop a service.
    """
    try:
        ledger = os.environ.get("GSD_PROCESS_LEDGER", "").strip()
        argv = getattr(sys, "argv", None) or []
        if not ledger or len(argv) < 2 or argv[1] != "run":
            return
        kind = _SERVICES.get(os.path.basename(argv[0]))
        if kind is None:
            return
        import json
        import time

        line = {
            "event": "self",
            "kind": kind,
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "at": int(time.time() * 1000),
            "owner": os.environ.get("GSD_TEST_OWNER") or None,
            "dataDir": os.environ.get("AMAUTA_DATA_DIR") or None,
        }
        # Beside the registry, in a file of its own (process-registry.cjs
        # `selfRegistryPath`): the fixtures' started/stopped pairs stay pairs.
        with open(ledger + ".self", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(line) + "\n")
    except Exception:  # noqa: BLE001 - see the docstring: never stop a service
        pass


def _chain_and_guard():
    # 0. Test mode, before anything this interpreter goes on to import.
    _arm_test_mode()

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

    # 3. A daemon or RLM service puts itself in the run's process registry.
    _register_service()


_chain_and_guard()
