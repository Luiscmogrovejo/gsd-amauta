"""Chaining sitecustomize that installs the hermetic socket guard (plan 88-01).

The Node runner puts this directory on PYTHONPATH so Python subprocesses spawned by
Node tests (amauta.py, services/amauta-daemon.py) are guarded too.

It MUST run the interpreter's own ``sitecustomize`` first: Homebrew Python uses one
to add its site-packages, and shadowing it makes pytest/numpy disappear.
"""
import importlib
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


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
    try:
        path = os.path.normpath(os.path.join(_HERE, "..", "hermetic_guard.py"))
        spec = importlib.util.spec_from_file_location("hermetic_guard", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.install()
    except Exception:
        pass


_chain_and_guard()
