"""Plan 88-08-06: a missing external tool is reported as unavailable, never as success.

Always runs. The Python suite has no test today that needs the ``claude`` CLI, a
downloaded binary or the network (the TOOL bucket measured 0 rows), so this file
carries the two things that bucket owes:

1. the shared ``have_tool`` helper (tests/conftest.py) behaves, so a future
   ``@pytest.mark.skipif(not have_tool("claude"), reason="the claude CLI is not
   available in this environment")`` is trustworthy;
2. the research-chain wrapper in amauta.py, which shells out to ``node``, reports
   "unavailable" (an empty list) when ``node`` is absent instead of fabricating
   results. A missing tool that reads as success is a silent-green failure mode.
"""
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

import fake_exe

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import amauta  # noqa: E402


def _conftest():
    """Return the loaded tests/conftest.py module object."""
    for name in ("conftest", "tests.conftest"):
        if name in sys.modules:
            return sys.modules[name]
    pytest.fail("tests/conftest.py is not loaded")


def test_have_tool_is_false_for_a_binary_that_does_not_exist():
    assert _conftest().have_tool("definitely-not-a-real-binary-88-08") is False


def test_have_tool_finds_an_executable_on_path(tmp_path, monkeypatch):
    # fake_exe writes an executable launcher: a mode-0o755 shell script on POSIX, a .cmd shim on
    # Windows (where shutil.which applies PATHEXT but an extensionless shebang file is not executable).
    fake_exe.write_fake_exe(tmp_path, "fake-tool-88-08", "")
    monkeypatch.setenv("PATH", fake_exe.prepend_path([tmp_path]))
    assert _conftest().have_tool("fake-tool-88-08") is True


def test_research_chain_reports_unavailable_when_node_is_missing():
    """No node binary: the chain returns [] (unavailable), it does not invent context."""
    # Plan 88-12: test mode short-circuits to [] before the node lookup; opt out so this
    # still exercises the missing-node branch.
    with mock.patch("amauta._research_chain_blocked", return_value=False), \
            mock.patch("shutil.which", return_value=None):
        result = amauta._research_chain_query("any topic")
    assert result == [], "research chain unavailable must be an empty result, got %r" % (result,)


def test_research_chain_reports_unavailable_when_the_script_is_missing(tmp_path, monkeypatch):
    """node present but gsd-research.cjs absent (repo copy and ~/.claude copy): still []."""
    monkeypatch.setenv("HOME", str(tmp_path))
    # expanduser reads USERPROFILE, not HOME, on Windows: pin both so the real home is never consulted.
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    # Plan 88-12: the repository copy is preferred when it exists, so point the module at an
    # empty tree to make "script missing" true again, and opt out of the test-mode early return.
    monkeypatch.setattr(amauta, "__file__", str(tmp_path / "amauta.py"))
    with mock.patch("amauta._research_chain_blocked", return_value=False), \
            mock.patch("shutil.which", return_value=sys.executable):
        with mock.patch("subprocess.run") as run:
            result = amauta._research_chain_query("any topic")
    assert result == [], "research chain unavailable must be an empty result, got %r" % (result,)
    run.assert_not_called()
