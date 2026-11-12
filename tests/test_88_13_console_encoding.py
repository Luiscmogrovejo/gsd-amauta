"""Plan 88-13 (G1): UTF-8 stdio for the Python entry points, with POSIX output pinned first.

``amauta.py`` prints glyphs such as U+25CB. On Windows a piped stdout uses the ANSI code page
(cp1252), so ``print`` raised ``UnicodeEncodeError`` and every ``execFileSync('python3', [amauta.py])``
from Node failed. ``services/_platform.py:setup_stdio`` makes the streams UTF-8 only when they are
not already, so POSIX output must not change by one byte: ``test_posix_stdout_bytes_unchanged``
pins it.

Every child runs ``subprocess.run([sys.executable, ...], env=env)`` with an environment built from
``os.environ`` that pins EVERY port and database variable the task CLI reads: the two daemon port
variables, ``GSD_RLM_PORT`` (the RLM service), both DSNs, and a temp data directory.
No child shells out to the ``env`` binary. Nothing here names a live port.
"""
import hashlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services"))

from _platform import setup_stdio  # noqa: E402

FIXTURE_TITLE = "Fixture task 88-13"
TASK_ID = "TK-0001"


def pinned_env(data_dir, extra=None):
    """Build a child environment that cannot reach any live service.

    Starts from ``os.environ`` (a bare dict loses PATH and HOME), then overrides the data
    directory, test mode, SQLite, all three local service ports, both DSNs and auto backup.

    Args:
        data_dir: Temp directory for tasks.json and memory.jsonl.
        extra: Optional additional overrides.

    Returns:
        dict: The environment for ``subprocess.run(..., env=...)``.
    """
    env = {
        **os.environ,
        "AMAUTA_DATA_DIR": str(data_dir),
        "GSD_TEST_MODE": "1",
        "GSD_FORCE_SQLITE": "1",
        "GSD_AMAUTA_PORT": "0",
        "GSD_DAEMON_PORT": "0",
        "GSD_RLM_PORT": "0",
        "AMAUTA_MEMORY_DATABASE_URL": "",
        "GSD_POSTGRES_URL": "",
        "AMAUTA_AUTO_BACKUP": "off",
    }
    if extra:
        env.update(extra)
    return env


def run_cli(args, env):
    """Run ``amauta.py`` with the interpreter running the tests; return the CompletedProcess."""
    return subprocess.run([sys.executable, "amauta.py", *args], cwd=ROOT, env=env, capture_output=True)


def seed(env):
    """Seed one pending task (id TK-0001) into the store named by ``env``."""
    r = run_cli(["add", "task", FIXTURE_TITLE, "-d", "desc"], env)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")


# (name, commands to run unhashed first, the hashed command). Each runs on its OWN freshly seeded store.
# `status <id> in-progress` runs standalone: in-progress -> in-progress is not an allowed transition.
# `validate` needs a claim by a different agent first, and --force-reason converts the
# RPETD_COMPLETE gate failure of a fresh task into a warning.
GOLDEN = [
    ("list", [], ["list"]),
    ("board", [], ["board"]),
    ("claim", [], ["claim", TASK_ID, "--agent", "a1"]),
    ("status", [], ["status", TASK_ID, "in-progress"]),
    (
        "validate",
        [["claim", TASK_ID, "--agent", "a1"]],
        ["validate", TASK_ID, "--pass", "--validator", "gsd-validator", "--force-reason", "88-13 fixture", "--notes", "x"],
    ),
]

# SHA-256 of stdout after newline normalisation (b"\r\n" -> b"\n", so the same values hold on
# Windows) and with the temp data-dir path replaced by <DATA_DIR>. Captured 2026-11-11 on macOS,
# Python 3.14.3, with test mode on (so `claim` carries no RLM enrichment block). Two consecutive
# runs gave identical values. The ubuntu Python 3.12 job must reproduce them.
GOLDEN_SHA256 = {
    "list": "584b6066bbdf1dfbcbb18e63b39140bb64890b103209f53de4476ccc9d7025f0",
    "board": "0c9167d3c26b77ff44c3ebf6b2e313e79823ffe02c180a9636dccd3048eec768",
    "claim": "302fffac299633bc6eb42dba8e78b0c6bd8d34684d66cfcbe8baabd11757807a",
    "status": "e6677771d66917091ba0ac08b320b41995853e68bb42b9c942bf6964cb22dd0f",
    "validate": "a7459e97d564da4478811562ec907a2d7e6da2de5472c1d00d081df0516eee2d",
}


@pytest.mark.parametrize("name,pre,cmd", GOLDEN, ids=[g[0] for g in GOLDEN])
def test_posix_stdout_bytes_unchanged(name, pre, cmd):
    with tempfile.TemporaryDirectory() as tmp:
        env = pinned_env(tmp)
        seed(env)
        for p in pre:
            r = run_cli(p, env)
            assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
        r = run_cli(cmd, env)
        assert r.returncode == 0, "%s exited %d: %s" % (name, r.returncode, r.stderr.decode("utf-8", "replace"))
        out = r.stdout.replace(b"\r\n", b"\n").replace(str(tmp).encode("utf-8"), b"<DATA_DIR>")
        # A glyph on a BLOCKED, exit-1 path is not a detector, so exit 0 is asserted above.
        assert any(b > 127 for b in out), "%s printed no non-ASCII byte: the golden would be vacuous" % name
        assert b"AUTO-ENRICHED" not in out, "test mode must not run claim-time RLM enrichment"
        assert str(ROOT).encode("utf-8") not in out, "stdout contains the absolute checkout path"
        assert hashlib.sha256(out).hexdigest() == GOLDEN_SHA256[name]


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="launchd/POSIX no-locale case; on Windows a piped stdout is cp1252 and setup_stdio correctly returns True",
)
def test_setup_stdio_is_a_noop_with_no_locale_variables():
    """The LaunchAgent plist sets no locale variables; the rule must be a no-op there."""
    code = "import sys; sys.path.insert(0, 'services'); import _platform; print(_platform.setup_stdio())"
    r = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env={"PATH": os.environ["PATH"]},  # no LANG, no LC_*, no PYTHON* variables
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False"


def _wrapper(encoding):
    return io.TextIOWrapper(io.BytesIO(), encoding=encoding, write_through=True)


def test_setup_stdio_is_a_noop_on_utf8():
    for name in ("utf-8", "UTF-8", "utf_8", "UTF8"):
        w = _wrapper(name)
        enc = w.encoding
        assert setup_stdio(streams=[w]) is False
        assert w.encoding == enc


def test_setup_stdio_reconfigures_cp1252():
    """Exercises the Windows branch on any platform by injecting the condition, not the platform."""
    w = _wrapper("cp1252")
    assert setup_stdio(streams=[w]) is True
    assert w.encoding == "utf-8"
    w.write("○")  # would raise UnicodeEncodeError under cp1252
    w.flush()
    assert w.buffer.getvalue() == "○".encode("utf-8")


def test_setup_stdio_survives_a_closed_stream():
    w = _wrapper("cp1252")
    w.close()
    assert setup_stdio(streams=[w]) is False


def test_setup_stdio_survives_capsys(capsys):
    assert setup_stdio() in (True, False)  # replaced sys.stdout / sys.stderr must not raise
    print("still prints")
    assert "still prints" in capsys.readouterr().out


# --------------------------------------------------------------------------------------------
# Task 88-13-06: every Python entry point calls setup_stdio() first thing in its __main__ block.
# --------------------------------------------------------------------------------------------
import ast  # noqa: E402


def _entry_points():
    """Every file with a module-level ``if __name__ == "__main__":`` block (amauta.py, services/, scripts/)."""
    found = []
    listed = [p.relative_to(ROOT).as_posix() for sub in ("services", "scripts") for p in sorted((ROOT / sub).glob("*.py"))]
    for rel in ["amauta.py"] + listed:
        if rel.endswith("_platform.py"):
            continue
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
        node = _main_block(tree)
        if node is not None:
            found.append((rel, node))
    return found


def _main_block(tree):
    for node in tree.body:
        if (
            isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name)
            and node.test.left.id == "__name__"
            and len(node.test.comparators) == 1
            and isinstance(node.test.comparators[0], ast.Constant)
            and node.test.comparators[0].value == "__main__"
        ):
            return node
    return None


def _is_setup_call(stmt):
    return (
        isinstance(stmt, ast.Expr)
        and isinstance(stmt.value, ast.Call)
        and getattr(stmt.value.func, "id", "") == "setup_stdio"
    )


def test_every_entry_point_sets_up_stdio():
    entries = _entry_points()
    assert len(entries) == 17, "expected 17 entry points, found %d: %s" % (len(entries), [e[0] for e in entries])
    for rel, node in entries:
        idx = [i for i, st in enumerate(node.body) if _is_setup_call(st)]
        assert idx, "%s: no setup_stdio() call directly in the __main__ block" % rel
        for st in node.body[: idx[0]]:  # nothing before it may print or touch sys.stdout
            for n in ast.walk(st):
                is_print = isinstance(n, ast.Call) and getattr(n.func, "id", "") == "print"
                is_stdout = isinstance(n, ast.Attribute) and n.attr in ("stdout", "stderr")
                assert not (is_print or is_stdout), "%s: output used before setup_stdio()" % rel
    # No entry point calls it at import time (module level), only inside __main__.
    for rel, _ in entries:
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
        assert not [n for n in tree.body if _is_setup_call(n)], "%s calls setup_stdio() at import time" % rel


def _path_expression(rel, node):
    """The expression the entry point appends to sys.path, taken from its own source."""
    for st in node.body:
        if (
            isinstance(st, ast.Expr)
            and isinstance(st.value, ast.Call)
            and isinstance(st.value.func, ast.Attribute)
            and st.value.func.attr == "append"
            and isinstance(st.value.func.value, ast.Attribute)
            and st.value.func.value.attr == "path"
        ):
            return ast.Expression(st.value.args[0])
    raise AssertionError("%s: no sys.path.append(...) in the __main__ block" % rel)


@pytest.mark.parametrize("rel", [e[0] for e in _entry_points()])
def test_platform_is_importable_from_each_entry_point_directory(rel):
    """The sys.path preparation each file really does must resolve _platform to services/_platform.py,
    not fall into the ImportError stub (which would turn this whole task into a no-op)."""
    node = dict(_entry_points())[rel]
    expr = ast.fix_missing_locations(_path_expression(rel, node))
    services_dir = eval(compile(expr, rel, "eval"), {"_os": os, "__file__": str(ROOT / rel)})
    code = (
        "import sys; sys.path.append(%r); import _platform; print(_platform.__file__)" % services_dir
    )
    r = subprocess.run(
        [sys.executable, "-I", "-c", code],
        cwd=str((ROOT / rel).parent),
        env={"PATH": os.environ["PATH"], **({"SYSTEMROOT": os.environ["SYSTEMROOT"]} if "SYSTEMROOT" in os.environ else {})},
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert r.returncode == 0, r.stderr
    assert Path(r.stdout.strip()).resolve() == (ROOT / "services" / "_platform.py").resolve()


@pytest.mark.parametrize("name,pre,cmd", GOLDEN, ids=[g[0] for g in GOLDEN])
def test_cp1252_stdout_does_not_crash(name, pre, cmd):
    """Proof (a) for G1: force a cp1252 stdout, the Windows piped-console condition, on any platform."""
    with tempfile.TemporaryDirectory() as tmp:
        env = pinned_env(tmp, {"PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"})
        seed(env)
        for p in pre:
            r = run_cli(p, env)
            assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
        r = run_cli(cmd, env)
        err = r.stderr.decode("utf-8", "replace")
        assert "UnicodeEncodeError" not in err, err
        assert r.returncode == 0, "%s exited %d: %s" % (name, r.returncode, err)
        # BLOCKED / INVALID TRANSITION messages are non-ASCII too, hence the exit-0 clause above.
        assert any(b > 127 for b in r.stdout), "%s printed no non-ASCII byte" % name
