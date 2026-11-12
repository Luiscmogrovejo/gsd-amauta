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
