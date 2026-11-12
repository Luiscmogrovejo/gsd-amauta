"""Plan 88-13 task 07 (extended to the tests by plan 88-18 task 03): every text-mode file call names its encoding.

``setup_stdio()`` fixes the console, not file I/O: on a legacy locale ``open(path)`` and
``Path.read_text()`` default to the ANSI code page, so a UTF-8 file with a non-ASCII character is
decoded wrongly or raises. ``test_no_text_io_without_encoding`` is the ratchet over the three call
forms (``open``, ``read_text``, ``write_text``; ``Path.open`` is the ``open`` attribute form) over the
product AND over every ``tests/**/*.py`` file. For the tests the ratchet also covers the three forms
88-13 noted it missed: ``tempfile.NamedTemporaryFile``/``TemporaryFile`` with a text ``mode=`` and
``os.fdopen``, ``gzip.open`` with a text mode (``"rt"``), and ``subprocess`` calls that decode a pipe with
``text=True`` and no ``encoding=``. Product ``NamedTemporaryFile`` calls
(amauta.py, ASCII-only JSON payloads) are recorded for plan 88-15, not enforced here.
``test_roundtrip_under_a_legacy_locale`` forces a locale where the default encoding really is not
UTF-8 and proves a non-ASCII title survives ``import`` and ``export``.

Children are ``subprocess.run([sys.executable, ...], env=env)`` with a pinned environment (every
local service port, both DSNs, a temp data directory); no ``env`` binary; nothing names a live port.
"""
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEXT_FORMS = ("open", "read_text", "write_text")
# Test files additionally cover these: they take a text mode, and a text mode needs an encoding.
TEST_ONLY_FORMS = ("NamedTemporaryFile", "TemporaryFile", "fdopen")
# Module-level ``open`` look-alikes that are not text-mode file opens by default.
NON_TEXT_OPEN_OWNERS = ("os", "webbrowser", "tarfile", "zipfile", "sqlite3", "shelve", "dbm", "wave")
# The ratchet's roots: product files (AST-checked) and every test file under these directories.
TEST_ROOTS = ("tests",)
# A call that legitimately cannot name an encoding goes here with a one-line reason. There are none.
ALLOWED = ()


def _files():
    listed = [p.relative_to(ROOT).as_posix() for sub in ("services", "scripts") for p in sorted((ROOT / sub).glob("*.py"))]
    return ["amauta.py"] + listed


def _test_files():
    """Every ``*.py`` under the test roots, as repo-relative posix paths (``__pycache__`` excluded)."""
    found = []
    for sub in TEST_ROOTS:
        for p in sorted((ROOT / sub).rglob("*.py")):
            if "__pycache__" not in p.parts:
                found.append(p.relative_to(ROOT).as_posix())
    return found


def _call_name(n):
    """Return ``(name, owner)`` for a call node: the called name and, for ``a.b(...)``, the text of ``a``."""
    func = n.func
    if isinstance(func, ast.Name):
        return func.id, ""
    if isinstance(func, ast.Attribute):
        return func.attr, ast.unparse(func.value)
    return "", ""


def _mode_of(n, name, owner):
    """Return the literal mode string of an open-like call, ``None`` when it is not a constant.

    The default differs by form: ``open``/``fdopen``/``gzip.open`` read text or bytes by default
    (``open``/``fdopen`` ``"r"``, ``gzip.open`` ``"rb"``), the temporary-file forms default to ``"w+b"``.
    """
    pos = 1 if name in ("open", "fdopen") else 0
    if name == "open" and owner and owner.split(".")[-1] not in ("io", "codecs"):
        # ``Path.open(mode)`` takes the mode first; ``gzip.open(file, mode)`` takes it second.
        pos = 1 if owner.split(".")[-1] in ("gzip", "bz2", "lzma") else 0
    default = "rb" if owner.split(".")[-1] in ("gzip", "bz2", "lzma") else ("w+b" if name in TEST_ONLY_FORMS and name != "fdopen" else "r")
    for k in n.keywords:
        if k.arg == "mode":
            return k.value.value if isinstance(k.value, ast.Constant) else None
    if len(n.args) > pos:
        arg = n.args[pos]
        return arg.value if isinstance(arg, ast.Constant) else None
    return default


def _scan(rel, forms):
    """Return (file, line, form) for each text-mode call of ``forms`` in ``rel`` without ``encoding=``."""
    found = []
    tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        name, owner = _call_name(n)
        if name not in forms or any(k.arg == "encoding" for k in n.keywords):
            continue
        if name == "open" and owner.split(".")[-1] in NON_TEXT_OPEN_OWNERS:
            continue
        mode = "r"
        if name not in ("read_text", "write_text"):
            mode = _mode_of(n, name, owner)
            if mode is not None and ("b" in str(mode) and "t" not in str(mode)):
                continue
        if (rel, n.lineno, name) in ALLOWED:
            continue
        found.append((rel, n.lineno, name))
    return found


SUBPROCESS_CALLS = ("run", "Popen", "check_output", "call", "check_call")
SUBPROCESS_OWNERS = ("subprocess", "sp", "_sp", "_subprocess")


def _scan_subprocess_text(rel):
    """Return (file, line, form) for each ``subprocess`` call that decodes a pipe as text without ``encoding=``.

    ``text=True`` (or ``universal_newlines=True``) decodes the child's output with the locale code page;
    on Windows that is cp1252, where a UTF-8 byte such as 0x90 is undefined (plan 88-13 found the daemon
    returning an empty body because of it). Tests that read child output name the encoding too.
    """
    found = []
    tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        name, owner = _call_name(n)
        if name not in SUBPROCESS_CALLS or owner not in SUBPROCESS_OWNERS:
            continue
        kws = {k.arg: k.value for k in n.keywords}
        text = any(isinstance(kws.get(k), ast.Constant) and kws[k].value is True for k in ("text", "universal_newlines"))
        if text and "encoding" not in kws and (rel, n.lineno, "subprocess." + name) not in ALLOWED:
            found.append((rel, n.lineno, "subprocess." + name))
    return found


def unencoded_text_io():
    """Return (file, line, form) for every text-mode call without ``encoding=``, product and tests."""
    found = []
    for rel in _files():
        found.extend(_scan(rel, TEXT_FORMS))
    for rel in _test_files():
        found.extend(_scan(rel, TEXT_FORMS + TEST_ONLY_FORMS))
        found.extend(_scan_subprocess_text(rel))
    return found


def test_no_text_io_without_encoding():
    assert unencoded_text_io() == []


def legacy_env(data_dir):
    """A child environment whose default file encoding is NOT UTF-8 (built in Python, no ``env`` binary).

    LC_ALL=C with the UTF-8 mode and locale coercion switched off makes ``open()`` default to ASCII on
    POSIX. PYTHONIOENCODING=utf-8 stays so the child can still print its own diagnostics. On Windows the
    default is the ANSI code page regardless.
    """
    return {
        **os.environ,
        "LC_ALL": "C",
        "LANG": "C",
        "PYTHONUTF8": "0",
        "PYTHONCOERCECLOCALE": "0",
        "PYTHONIOENCODING": "utf-8",
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


def _cli(args, env):
    return subprocess.run([sys.executable, "amauta.py", *args], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8")


def test_roundtrip_under_a_legacy_locale():
    title = "niño → café"  # n-tilde, right arrow, e-acute
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        env = legacy_env(tmp / "data")
        (tmp / "data").mkdir()

        probe = subprocess.run(
            [sys.executable, "-c", "import locale; print(locale.getpreferredencoding(False))"],
            env=env, capture_output=True, text=True,
            encoding="utf-8",
        )
        preferred = probe.stdout.strip()
        assert preferred.lower().replace("-", "").replace("_", "") != "utf8", (
            "the legacy-locale repro could not be established: child reports %r" % preferred
        )

        r = _cli(["add", "task", "ascii seed title", "-d", "desc"], env)
        assert r.returncode == 0, r.stderr
        r = _cli(["export", "-o", str(tmp / "seed.json")], env)
        assert r.returncode == 0, r.stderr
        data = json.loads((tmp / "seed.json").read_text(encoding="utf-8"))
        data["items"][0]["title"] = title
        # Raw UTF-8 bytes on disk: the case a legacy default encoding decodes wrongly or rejects.
        (tmp / "incoming.json").write_bytes(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))

        r = _cli(["import", str(tmp / "incoming.json"), "--replace"], env)
        assert r.returncode == 0, "import failed under the legacy locale (%s): %s" % (preferred, r.stderr[-600:])
        r = _cli(["export", "-o", str(tmp / "out.json")], env)
        assert r.returncode == 0, r.stderr[-600:]
        out = json.loads((tmp / "out.json").read_text(encoding="utf-8"))
        assert out["items"][0]["title"] == title


def test_daemon_decodes_the_cli_output_as_utf8():
    """amauta.py (and handoff.cjs) write UTF-8. The daemon reads them through ``subprocess.run(text=True)``,
    which decodes with the locale default; under cp1252 a byte such as 0x90 (inside U+25D0) raised, the
    daemon returned an empty body, and ``show`` through the daemon printed nothing on Windows.
    Every text-mode subprocess.run in a daemon function that runs ``AMAUTA_PY`` (or in the handoff call)
    must name an encoding."""
    src = (ROOT / "services" / "amauta-daemon.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def enclosing_source(n):
        while n in parents:
            n = parents[n]
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return ast.get_source_segment(src, n) or ""
        return ""

    checked = 0
    for n in ast.walk(tree):
        if not (isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "run"
                and getattr(n.func.value, "id", "") in ("subprocess", "_sp")):
            continue
        kw = {k.arg for k in n.keywords}
        seg = ast.get_source_segment(src, n) or ""
        if "text" in kw and ("handoff" in seg or "AMAUTA_PY" in enclosing_source(n)):
            checked += 1
            assert "encoding" in kw, "subprocess.run at line %d reads CLI output without encoding=" % n.lineno
    assert checked == 3, "expected the three CLI-output readers, found %d" % checked
