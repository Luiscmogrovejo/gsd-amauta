"""Golden POSIX pin for amauta.py's cross-process file lock.

Phase 88, plan 88-15 task 01: written and green BEFORE the Windows branch was
added, against the unmodified code at origin/master ``f114bf0``.

``amauta.py`` imports ``fcntl`` in a ``try`` and sets it to ``None`` on
ImportError, then guards every lock call with ``if fcntl:``.  The comment says
it plainly: "file locking will be skipped".  On POSIX the lock is real, and
that is what this file pins: two processes doing a read-modify-write on
``tasks.json`` serialise and neither loses an update.  Task 88-15-03 moves the
implementation into ``services/_platform.file_lock`` and must not change this
behaviour; the contention assertion below may not be weakened.

Everything runs under a temp ``AMAUTA_DATA_DIR``.  The operator's live store is
never opened: no test here resolves ``~/.amauta`` or the checkout's ``data/``.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_AMAUTA = _REPO / "amauta.py"

# Each worker does ITERATIONS locked read-modify-write cycles with a deliberate
# window between the read and the write.  Without a cross-process lock the two
# workers interleave inside that window and updates are lost; with the lock
# every one of the 2 * ITERATIONS appends survives.
ITERATIONS = 25

_WORKER = '''
import importlib.util, json, os, sys, time

tag = sys.argv[1]
iterations = int(sys.argv[2])
amauta_path = sys.argv[3]

spec = importlib.util.spec_from_file_location("amauta_under_test", amauta_path)
amauta = importlib.util.module_from_spec(spec)
sys.modules["amauta_under_test"] = amauta
spec.loader.exec_module(amauta)

for i in range(iterations):
    with amauta._file_lock():
        data = amauta.load()
        time.sleep(0.003)            # widen the read-modify-write window
        data["items"].append({"id": "%s-%03d" % (tag, i), "title": "contention"})
        amauta.save(data)
print("done", flush=True)
'''


def _child_env(data_dir):
    """The pinned hermetic environment for a product child process."""
    env = dict(os.environ)
    env.update(
        {
            "AMAUTA_DATA_DIR": str(data_dir),
            "GSD_TEST_MODE": "1",
            "GSD_FORCE_SQLITE": "1",
            "GSD_AMAUTA_PORT": "0",
            "GSD_DAEMON_PORT": "0",
            "GSD_RLM_PORT": "0",
            "AMAUTA_MEMORY_DATABASE_URL": "",
            "GSD_POSTGRES_URL": "",
            "AMAUTA_AUTO_BACKUP": "off",
            "AMAUTA_LOG_FILE": "off",
            "GSD_AMAUTA_NO_AUTO_START": "1",
        }
    )
    return env


def _seed_store(data_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    tasks = data_dir / "tasks.json"
    tasks.write_text(
        json.dumps(
            {
                "items": [],
                "sprints": [],
                "metadata": {"created": "2026-11-11T00:00:00Z", "version": "2.0",
                             "updated": "2026-11-11T00:00:00Z"},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return tasks


def test_golden_two_processes_contending_lose_no_update(tmp_path):
    """POSIX contention pin: 2 * ITERATIONS appends, none lost."""
    data_dir = tmp_path / "data"
    tasks = _seed_store(data_dir)
    worker = tmp_path / "worker.py"
    worker.write_text(_WORKER, encoding="utf-8")
    env = _child_env(data_dir)

    children = []
    try:
        for tag in ("alpha", "beta"):
            children.append(
                subprocess.Popen(
                    [sys.executable, str(worker), tag, str(ITERATIONS), str(_AMAUTA)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    env=env,
                )
            )
        outs = [c.communicate(timeout=180) for c in children]
    finally:
        for c in children:
            if c.poll() is None:
                c.kill()
                c.wait(timeout=30)

    for child, (out, err) in zip(children, outs):
        assert child.returncode == 0, "worker failed: %s\n%s" % (out, err)

    data = json.loads(tasks.read_text(encoding="utf-8"))
    ids = sorted(item["id"] for item in data["items"])
    expected = sorted(
        ["%s-%03d" % (tag, i) for tag in ("alpha", "beta") for i in range(ITERATIONS)]
    )
    assert len(ids) == 2 * ITERATIONS, (
        "lost update: %d of %d appends survived (the lock is not serialising)"
        % (len(ids), 2 * ITERATIONS)
    )
    assert ids == expected


def test_golden_file_lock_is_reentrant_within_one_thread(tmp_path):
    """save() takes the lock itself; a caller holding it must not deadlock."""
    data_dir = tmp_path / "data"
    _seed_store(data_dir)
    worker = tmp_path / "reentrant.py"
    worker.write_text(
        'import importlib.util, sys\n'
        'spec = importlib.util.spec_from_file_location("amauta_under_test", sys.argv[1])\n'
        'amauta = importlib.util.module_from_spec(spec)\n'
        'sys.modules["amauta_under_test"] = amauta\n'
        'spec.loader.exec_module(amauta)\n'
        'with amauta._file_lock():\n'
        '    data = amauta.load()\n'
        '    data["items"].append({"id": "nested", "title": "t"})\n'
        '    amauta.save(data)          # takes the lock again, reentrantly\n'
        'print("ok", flush=True)\n',
        encoding="utf-8",
    )
    r = subprocess.run(
        [sys.executable, str(worker), str(_AMAUTA)],
        capture_output=True, text=True, encoding="utf-8",
        env=_child_env(data_dir), timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert "ok" in r.stdout
    data = json.loads((data_dir / "tasks.json").read_text(encoding="utf-8"))
    assert [i["id"] for i in data["items"]] == ["nested"]


def test_golden_lock_file_lives_under_the_data_dir(tmp_path):
    """The lock file is AMAUTA_DATA_DIR/.amauta.lock -- never the live store."""
    data_dir = tmp_path / "data"
    _seed_store(data_dir)
    worker = tmp_path / "where.py"
    worker.write_text(
        'import importlib.util, sys\n'
        'spec = importlib.util.spec_from_file_location("amauta_under_test", sys.argv[1])\n'
        'amauta = importlib.util.module_from_spec(spec)\n'
        'sys.modules["amauta_under_test"] = amauta\n'
        'spec.loader.exec_module(amauta)\n'
        'print(str(amauta._LOCK_FILE), flush=True)\n',
        encoding="utf-8",
    )
    r = subprocess.run(
        [sys.executable, str(worker), str(_AMAUTA)],
        capture_output=True, text=True, encoding="utf-8",
        env=_child_env(data_dir), timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == str(data_dir / ".amauta.lock")


# ══════════════════════════════════════════════════════════════════════════
# Task 88-15-03: the helper itself.
#   The silent no-op is the defect. file_lock must lock on both platforms and
#   RAISE where it cannot -- never yield having done nothing.
# ══════════════════════════════════════════════════════════════════════════

sys.path.insert(0, str(_REPO / "services"))
import _platform  # noqa: E402
sys.path.pop(0)


def test_file_lock_raises_when_no_primitive_is_available(tmp_path, monkeypatch):
    """With neither fcntl nor msvcrt importable, the lock RAISES, never yields."""
    monkeypatch.setattr(_platform, "_load_fcntl", lambda: None)
    monkeypatch.setattr(_platform, "_load_msvcrt", lambda: None)
    target = tmp_path / "lock"
    entered = []
    with pytest.raises(RuntimeError) as exc:
        with _platform.file_lock(target):
            entered.append(True)
    assert entered == [], "a lock with no primitive must not yield"
    assert "no cross-process file lock" in str(exc.value)
    assert sys.platform in str(exc.value) or "win32" in str(exc.value)

    # The same on the Windows branch.
    with pytest.raises(RuntimeError) as exc_win:
        with _platform.file_lock(target, platform="win32"):
            entered.append(True)
    assert entered == []
    assert "msvcrt" in str(exc_win.value)


class _StubMsvcrt:
    """Records msvcrt.locking calls; the real thing cannot run on macOS."""

    LK_LOCK = 1
    LK_UNLCK = 0

    def __init__(self, fail_times=0):
        self.calls = []
        self._fail_times = fail_times

    def locking(self, fd, mode, nbytes):
        self.calls.append((mode, nbytes))
        if mode == self.LK_LOCK and self._fail_times > 0:
            self._fail_times -= 1
            raise OSError(36, "Resource deadlock avoided")


def test_injected_win32_file_lock_uses_lk_lock_and_unlocks_the_same_range(tmp_path, monkeypatch):
    stub = _StubMsvcrt()
    monkeypatch.setattr(_platform, "_load_msvcrt", lambda: stub)
    monkeypatch.setattr(_platform, "_load_fcntl", lambda: None)  # must not be reached
    target = tmp_path / "lock"
    with _platform.file_lock(target, platform="win32") as handle:
        assert handle.tell() == 0, "msvcrt locks from the current position"
    assert stub.calls == [(_StubMsvcrt.LK_LOCK, 1), (_StubMsvcrt.LK_UNLCK, 1)], stub.calls


def test_injected_win32_file_lock_retries_a_busy_lock_then_succeeds(tmp_path, monkeypatch):
    """LK_LOCK gives up after ~10s; a legitimate long hold must not read as failure."""
    stub = _StubMsvcrt(fail_times=2)
    monkeypatch.setattr(_platform, "_load_msvcrt", lambda: stub)
    with _platform.file_lock(tmp_path / "lock", platform="win32", timeout_s=30):
        pass
    modes = [m for m, _n in stub.calls]
    assert modes == [_StubMsvcrt.LK_LOCK, _StubMsvcrt.LK_LOCK, _StubMsvcrt.LK_LOCK,
                     _StubMsvcrt.LK_UNLCK], stub.calls


def test_injected_win32_file_lock_gives_up_when_the_budget_is_spent(tmp_path, monkeypatch):
    stub = _StubMsvcrt(fail_times=10**6)
    monkeypatch.setattr(_platform, "_load_msvcrt", lambda: stub)
    with pytest.raises(OSError):
        with _platform.file_lock(tmp_path / "lock", platform="win32", timeout_s=0.01):
            pass


def test_file_lock_accepts_an_already_open_handle_and_leaves_it_open(tmp_path):
    """amauta.py owns the lock-file handle; the helper must not close it."""
    target = tmp_path / "lock"
    handle = open(target, "w", encoding="utf-8")
    try:
        with _platform.file_lock(handle) as got:
            assert got is handle
        assert not handle.closed, "the caller's handle stays open"
    finally:
        handle.close()


def test_amauta_file_lock_no_longer_guards_on_a_possibly_none_module():
    src = (_REPO / "amauta.py").read_text(encoding="utf-8")
    assert "if fcntl:" not in src
    assert "import fcntl" not in src
    assert "_platform.file_lock" in src
