"""Plan 88-13 task 07: every product text-mode file call names its encoding.

``setup_stdio()`` fixes the console, not file I/O: on a legacy locale ``open(path)`` and
``Path.read_text()`` default to the ANSI code page, so a UTF-8 file with a non-ASCII character is
decoded wrongly or raises. ``test_no_text_io_without_encoding`` is the ratchet over the three call
forms (``open``, ``read_text``, ``write_text``; ``Path.open`` is the ``open`` attribute form).
``test_roundtrip_under_a_legacy_locale`` forces a locale where the default encoding really is not
UTF-8 and proves a non-ASCII title survives ``import`` and ``export``.

Children are ``subprocess.run([sys.executable, ...], env=env)`` with a pinned environment (every
local service port, both DSNs, a temp data directory); no ``env`` binary; nothing names a live port.
"""
import ast
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEXT_FORMS = ("open", "read_text", "write_text")
# A call that legitimately cannot name an encoding goes here with a one-line reason. There are none.
ALLOWED = ()


def _files():
    listed = [p.relative_to(ROOT).as_posix() for sub in ("services", "scripts") for p in sorted((ROOT / sub).glob("*.py"))]
    return ["amauta.py"] + listed


def unencoded_text_io():
    """Return (file, line, form) for every text-mode open/read_text/write_text without ``encoding=``."""
    found = []
    for rel in _files():
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call):
                continue
            name = getattr(n.func, "id", "") or getattr(n.func, "attr", "")
            if name not in TEXT_FORMS or any(k.arg == "encoding" for k in n.keywords):
                continue
            mode = "r"
            if name == "open":
                if len(n.args) > 1 and isinstance(n.args[1], ast.Constant):
                    mode = n.args[1].value
                for k in n.keywords:
                    if k.arg == "mode" and isinstance(k.value, ast.Constant):
                        mode = k.value.value
            if "b" in str(mode):
                continue
            if (rel, n.lineno, name) in ALLOWED:
                continue
            found.append((rel, n.lineno, name))
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
