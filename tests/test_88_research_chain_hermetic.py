"""Plan 88-12 task 07: the research chain never leaves the test environment.

``_research_chain_query`` shells out to ``node gsd-research.cjs`` (Perplexity and the web)
with ``subprocess.run``, which the in-process socket guard cannot see. It used to resolve
the operator's installed copy under ``~/.claude``. Under test mode it now returns ``[]``
without constructing a subprocess, and outside test mode it prefers the copy in this
repository.
"""
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import amauta  # noqa: E402


def _boom(*args, **kwargs):
    raise AssertionError("subprocess spawned")


def test_research_chain_spawns_nothing_in_test_mode(monkeypatch):
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    with mock.patch("subprocess.run", side_effect=_boom) as run, \
            mock.patch("subprocess.Popen", side_effect=_boom) as popen:
        assert amauta._research_chain_query("anything") == []
    run.assert_not_called()
    popen.assert_not_called()


def test_research_chain_spawns_nothing_under_pytest_alone(monkeypatch):
    """PYTEST_CURRENT_TEST alone (no GSD_TEST_MODE) is also test mode."""
    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "tests/x.py::t (call)")
    with mock.patch("subprocess.run", side_effect=_boom) as run:
        assert amauta._research_chain_query("anything") == []
        assert amauta._research_script_path() is None
    run.assert_not_called()


def test_rpetd_enrich_r_phase_spawns_nothing(monkeypatch):
    """The R phase calls the research chain when memory finds fewer than two results."""
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    item = {
        "id": "TK-HERMETIC",
        "title": "Unfamiliar domain widget gateway",
        "description": "nothing in memory about this",
        "success_criteria": ["works"],
        "status": "in-progress",
    }
    reached = []
    real = amauta._research_chain_query

    def spy(*args, **kwargs):
        reached.append(args)
        return real(*args, **kwargs)

    with mock.patch("subprocess.run", side_effect=_boom) as run, \
            mock.patch("subprocess.Popen", side_effect=_boom), \
            mock.patch("amauta._last_enrichment_ts", return_value=None), \
            mock.patch("amauta._pick_domain_doc", return_value=""), \
            mock.patch("amauta._rlm_query", return_value=""), \
            mock.patch("amauta._mem_semantic_search", return_value=[]), \
            mock.patch("amauta._skb_search", return_value=[]), \
            mock.patch("amauta._research_chain_query", side_effect=spy):
        amauta._rpetd_phase_enrich("R", item, "research content long enough to matter")
    assert reached, "the R phase never reached _research_chain_query: the test does not test what it claims"
    run.assert_not_called()


def test_script_resolution_prefers_the_repo_outside_test_mode(tmp_path, monkeypatch):
    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    repo = tmp_path / "repo"
    script = repo / "get-shit-done" / "bin" / "gsd-research.cjs"
    script.parent.mkdir(parents=True)
    script.write_text("// stub\n", encoding="utf-8")
    monkeypatch.setattr(amauta, "__file__", str(repo / "amauta.py"))
    resolved = amauta._research_script_path()
    assert resolved == str(script)
    assert str(fake_home) not in resolved


def test_script_resolution_falls_back_to_the_installed_copy(tmp_path, monkeypatch):
    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    # os.path.expanduser reads HOME on POSIX but USERPROFILE on Windows (it ignores HOME there),
    # so pin both or this test resolves the runner's real home directory on Windows.
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setattr(amauta, "__file__", str(tmp_path / "empty-repo" / "amauta.py"))
    resolved = amauta._research_script_path()
    expected = fake_home / ".claude" / "get-shit-done" / "bin" / "gsd-research.cjs"
    # The product joins with "/" after the home directory; compare as paths, not as strings.
    assert os.path.normpath(resolved) == os.path.normpath(str(expected))
