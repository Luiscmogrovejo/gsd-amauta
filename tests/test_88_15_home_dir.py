"""The HOME sites: a config path that silently resolved to nowhere.

Phase 88, plan 88-15 task 06.

``os.environ.get("HOME", "")`` is not a fallback, it is a silent failure. On
Windows cmd and PowerShell HOME is unset, so ``os.path.join("", ".claude", …)``
produces a RELATIVE path, the file is not found, and the evidence scrubber runs
with NO PATTERNS while still reporting success. The same shape loaded the tag
rules (``services/pg_store.py``) and the capability catalog
(``services/capability_schema.py``).

Everything here uses a temp home; nothing reads the operator's real
``~/.claude``.
"""

import importlib
import os
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "services"))
import _platform  # noqa: E402
sys.path.pop(0)


def _load(module_name):
    """Import a services module fresh, with services/ on sys.path."""
    sys.path.insert(0, str(_REPO / "services"))
    try:
        if module_name in sys.modules:
            del sys.modules[module_name]
        return importlib.import_module(module_name)
    finally:
        sys.path.pop(0)


def _set_home(monkeypatch, directory):
    """Redirect the home directory on every platform (the 88-14 home-env shape)."""
    monkeypatch.setenv("HOME", str(directory))
    monkeypatch.setenv("USERPROFILE", str(directory))
    drive, rest = os.path.splitdrive(str(directory))
    monkeypatch.setenv("HOMEDRIVE", drive)
    monkeypatch.setenv("HOMEPATH", rest)


def test_home_dir_is_absolute_and_never_empty():
    home = _platform.home_dir()
    assert home
    assert os.path.isabs(home), home


def test_home_dir_honours_an_overridden_home(tmp_path, monkeypatch):
    """MEASURED, not assumed: expanduser('~') reads HOME on POSIX and
    USERPROFILE on Windows, so a redirected home is still honoured."""
    target = tmp_path / "redirected"
    target.mkdir()
    _set_home(monkeypatch, target)
    got = _platform.home_dir()
    assert os.path.realpath(got) == os.path.realpath(str(target)), got


def test_home_dir_is_not_empty_with_HOME_deleted(tmp_path, monkeypatch):
    """PROOF (a), research 12's repro. With HOME gone the path must still be
    absolute -- the empty string is the actual defect, because
    os.path.join("", ".claude", ...) is RELATIVE to the current directory."""
    monkeypatch.delenv("HOME", raising=False)
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "profile"))
    got = _platform.home_dir()
    assert got != ""
    assert os.path.isabs(got), got


def test_evidence_scrub_candidate_paths_are_absolute_under_the_redirected_home(tmp_path, monkeypatch):
    target = tmp_path / "home"
    target.mkdir()
    _set_home(monkeypatch, target)
    monkeypatch.delenv("GSD_EVIDENCE_SCRUB_PATTERNS_PATH", raising=False)
    mod = _load("evidence_scrub")
    candidates = mod._candidate_paths()
    assert candidates, "there must be at least one candidate"
    for candidate in candidates:
        assert candidate, "an EMPTY candidate is the defect: it resolves relative to cwd"
        assert os.path.isabs(candidate), candidate
    assert any(os.path.realpath(str(target)) in os.path.realpath(c) for c in candidates), candidates


def test_the_scrubber_cannot_report_success_with_zero_patterns(tmp_path, monkeypatch):
    """A scrubber that loads no patterns must not look like a working one."""
    target = tmp_path / "home"
    target.mkdir()
    _set_home(monkeypatch, target)
    monkeypatch.delenv("GSD_EVIDENCE_SCRUB_PATTERNS_PATH", raising=False)
    mod = _load("evidence_scrub")
    patterns = mod.load_patterns(force_reload=True)
    assert patterns, "the repo-relative catalog must still load with a redirected home"
    assert len(patterns) > 0
    scrubbed = mod.scrub_text("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL")
    assert "AAAABBBB" not in scrubbed, "a loaded pattern set must actually scrub"


def test_capability_catalog_candidates_are_absolute_under_the_redirected_home(tmp_path, monkeypatch):
    target = tmp_path / "home"
    target.mkdir()
    _set_home(monkeypatch, target)
    monkeypatch.delenv("GSD_CAPABILITY_CATALOG_PATH", raising=False)
    mod = _load("capability_schema")
    catalog = mod.load_capability_catalog(force_reload=True)
    assert isinstance(catalog, dict)
    # The home branch is the fallback; assert the source carries no empty-home
    # join any more, which is what made it resolve relative to the cwd.
    src = (_REPO / "services" / "capability_schema.py").read_text(encoding="utf-8")
    assert 'os.environ.get("HOME", "")' not in src
    assert "home_dir()" in src


def test_pg_store_tag_rules_path_uses_the_shared_home(tmp_path, monkeypatch):
    src = (_REPO / "services" / "pg_store.py").read_text(encoding="utf-8")
    assert 'os.environ.get("HOME", "")' not in src
    assert "home_dir()" in src
