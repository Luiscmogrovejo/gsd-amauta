"""The managed keys file ``~/.amauta/env`` (Phase 89, plan 89-10, decision 11).

One owner-only file gives the daemon and the CLIs their keys, and everything
that reports on a key reports presence and source only.

SECRETS RULE OF THIS FILE
─────────────────────────
Every key here is :data:`FAKE_KEY`, an obviously fake literal, written into a
temporary home directory. No case reads, copies or names a real ``.env``, a real
``~/.amauta/env`` or a real key. Every child process runs under a temporary
``HOME``/``USERPROFILE``. A child reports the SHA-256 of what it loaded, never
the value, so EVERYTHING a child prints can be searched for the fake literal —
and is, in every case (:func:`_assert_no_secret`).

    python3 -m pytest tests/test_89_10_managed_env.py -q -rs -p no:cacheprovider
"""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "support"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dotenv_probe  # noqa: E402
from conftest import (  # noqa: E402
    PG_SKIP_REASON,
    assert_test_dsn_is_not_live,
    postgres_dsn_or_none,
)

REPO = dotenv_probe.REPO
LOADER = REPO / "services" / "_dotenv.py"
DAEMON = REPO / "services" / "amauta-daemon.py"
DOCTOR = REPO / "services" / "doctor.py"
SUPPORT = REPO / "tests" / "support"

#: The only "key" this file ever handles. Not a key.
FAKE_KEY = "pa-test-not-a-real-key-89-10-FAKEFAKEFAKE"
FAKE_SHA = hashlib.sha256(FAKE_KEY.encode("utf-8")).hexdigest()

#: A second fake, for the cases where two files define the same name.
OTHER_FAKE = "pa-test-other-not-a-real-key-89-10"
OTHER_SHA = hashlib.sha256(OTHER_FAKE.encode("utf-8")).hexdigest()

MARKER = "GSD_8910_JSON "
KEY_NAMES = ("VOYAGE_API_KEY", "PERPLEXITY_API_KEY", "OPENAI_API_KEY")
READY_TIMEOUT = float(os.environ.get("GSD_FIXTURE_DAEMON_READY_TIMEOUT", "40"))

requires_pg = pytest.mark.skipif(postgres_dsn_or_none() is None, reason=PG_SKIP_REASON)

#: The child every loader case runs. It loads services/_dotenv.py BY PATH, the
#: way the four entry points do, and prints digests — never a value.
CHILD = r'''
import hashlib, importlib.util, json, logging, os, sys
logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)
loader_path, root, mode = sys.argv[1:4]
names = sys.argv[4:]
spec = importlib.util.spec_from_file_location("gsd_dotenv", loader_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = {}
if mode == "presence":
    out["before_load"] = mod.key_presence(names, root)
out["read"] = mod.load_dotenv(root)
out["sha"] = {
    n: (hashlib.sha256(os.environ[n].encode("utf-8")).hexdigest() if n in os.environ else None)
    for n in names
}
if mode == "presence":
    out["after_load"] = mod.key_presence(names, root)
print("GSD_8910_JSON " + json.dumps(out))
'''


def _load_module():
    """services/_dotenv.py as a fresh module object."""
    spec = importlib.util.spec_from_file_location("gsd_dotenv_8910", str(LOADER))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _assert_no_secret(*texts):
    """Fail when a fake key literal appears in any captured text."""
    for text in texts:
        blob = text if isinstance(text, str) else json.dumps(text)
        for literal in (FAKE_KEY, OTHER_FAKE):
            assert literal not in blob, "a key VALUE was emitted:\n%s" % blob[-2000:]


def _tree(tmp_path, repo_env=None):
    """A fake repository root, optionally with a ``.env``."""
    root = tmp_path / "root"
    root.mkdir(exist_ok=True)
    if repo_env is not None:
        (root / ".env").write_text(repo_env, encoding="utf-8")
    return root


def _home(tmp_path, managed=None):
    """A temporary home; ``managed`` is the body of ``.amauta/env`` (mode 0600)."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    if managed is not None:
        dotenv_probe.write_owner_only(home / ".amauta" / "env", managed)
    return home


def _run_child(tmp_path, root, home, names, mode="load", **env_overrides):
    """Run :data:`CHILD`; return ``(report or None, completed process)``."""
    script = tmp_path / "loader_child.py"
    script.write_text(CHILD, encoding="utf-8")
    env = dotenv_probe.child_env(**dotenv_probe.home_env(home))
    for name in KEY_NAMES + tuple(names):
        env.pop(name, None)
    for key, value in env_overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    proc = subprocess.run(
        # -I, as tests/support/dotenv_probe.py does: PYTHONPATH is ignored, so
        # tests/support/pythonpath/sitecustomize.py cannot arm GSD_TEST_MODE in
        # a child whose case is about the loader OUTSIDE test mode.
        [sys.executable, "-I", str(script), str(LOADER), str(root), mode, *names],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, env=env,
    )
    _assert_no_secret(proc.stdout, proc.stderr)
    report = None
    for line in proc.stdout.splitlines():
        if line.startswith(MARKER):
            report = json.loads(line[len(MARKER):])
    return report, proc


# ═══════════════════════════════════════════════════════════════════════════
# The candidate order
# ═══════════════════════════════════════════════════════════════════════════


def test_the_managed_file_is_read_first_and_wins_over_the_repo_env(tmp_path):
    """``<home>/.amauta/env`` is the first candidate, and the repo ``.env`` is
    still read behind it — creating the managed file switches nothing off."""
    root = _tree(tmp_path, "VOYAGE_API_KEY=%s\nGSD_8910_ONLY_REPO=repo-value\n" % OTHER_FAKE)
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    report, proc = _run_child(tmp_path, root, home, ["VOYAGE_API_KEY", "GSD_8910_ONLY_REPO"])
    assert proc.returncode == 0, proc.stderr
    assert report["read"] == str(home / ".amauta" / "env")
    assert report["sha"]["VOYAGE_API_KEY"] == FAKE_SHA, "the managed file must win"
    assert report["sha"]["GSD_8910_ONLY_REPO"] == hashlib.sha256(b"repo-value").hexdigest(), (
        "the repo .env stopped being read once the managed file existed")


@pytest.mark.parametrize("rel", dotenv_probe.ENTRY_POINTS)
def test_every_entry_point_reads_the_managed_file(tmp_path, rel):
    """All four entry points get it, through the one loader they share."""
    target = dotenv_probe.build_tree(tmp_path, rel)
    home = _home(tmp_path, "GSD_8910_MANAGED=from-the-managed-file\n")
    env = dotenv_probe.child_env(**dotenv_probe.home_env(home))
    env.pop("GSD_8910_MANAGED", None)
    got = dotenv_probe.probe(target, keys=("GSD_8910_MANAGED", "GSD_DOTENV_SENTINEL"), env=env)
    assert got == {
        "GSD_8910_MANAGED": "from-the-managed-file",
        "GSD_DOTENV_SENTINEL": "leaked-from-dotenv",
    }


def test_an_already_set_variable_still_wins_over_the_managed_file(tmp_path):
    """Unchanged behaviour: the process environment beats every file."""
    root = _tree(tmp_path)
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    report, proc = _run_child(tmp_path, root, home, ["VOYAGE_API_KEY"],
                              VOYAGE_API_KEY=OTHER_FAKE)
    assert proc.returncode == 0, proc.stderr
    assert report["sha"]["VOYAGE_API_KEY"] == OTHER_SHA


@pytest.mark.parametrize("suppressed", (True, False), ids=("suppressed", "not-suppressed"))
def test_the_explicit_path_wins_in_both_branches(tmp_path, suppressed):
    """``GSD_DOTENV_PATH`` names the keys file in test mode AND outside it.

    It REPLACES the default: a ``<home>/.amauta/env`` beside it is not read.
    """
    root = _tree(tmp_path)
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\nGSD_8910_DEFAULT_ONLY=default\n" % OTHER_FAKE)
    explicit = dotenv_probe.write_owner_only(
        tmp_path / "elsewhere" / "keys", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    overrides = {"GSD_DOTENV_PATH": explicit}
    if suppressed:
        overrides["GSD_TEST_MODE"] = "1"
    report, proc = _run_child(
        tmp_path, root, home, ["VOYAGE_API_KEY", "GSD_8910_DEFAULT_ONLY"], **overrides)
    assert proc.returncode == 0, proc.stderr
    assert report["read"] == str(explicit)
    assert report["sha"] == {"VOYAGE_API_KEY": FAKE_SHA, "GSD_8910_DEFAULT_ONLY": None}


@pytest.mark.parametrize("marker", (
    {"GSD_TEST_MODE": "1"},
    {"PYTEST_CURRENT_TEST": "tests/test_x.py::test_y (call)"},
), ids=("GSD_TEST_MODE", "PYTEST_CURRENT_TEST"))
def test_in_test_mode_with_no_explicit_path_nothing_is_read(tmp_path, marker):
    """The Phase 88 guard (PR #37) is intact: neither the managed file under
    the home directory nor the repo ``.env`` is read."""
    root = _tree(tmp_path, "GSD_8910_ONLY_REPO=repo-value\n")
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    report, proc = _run_child(
        tmp_path, root, home, ["VOYAGE_API_KEY", "GSD_8910_ONLY_REPO"], **marker)
    assert proc.returncode == 0, proc.stderr
    assert report["read"] is None
    assert report["sha"] == {"VOYAGE_API_KEY": None, "GSD_8910_ONLY_REPO": None}


def test_the_loader_creates_nothing(tmp_path):
    """No file, no directory: a missing managed file is simply not read."""
    root = _tree(tmp_path)
    home = _home(tmp_path)
    missing = tmp_path / "nowhere" / "keys"
    for overrides in ({}, {"GSD_DOTENV_PATH": missing}, {"GSD_TEST_MODE": "1"}):
        report, proc = _run_child(tmp_path, root, home, ["VOYAGE_API_KEY"], **overrides)
        assert proc.returncode == 0, proc.stderr
        assert report["read"] is None
    assert not (home / ".amauta").exists(), "the loader created the managed directory"
    assert not missing.exists() and not missing.parent.exists()
    assert sorted(p.name for p in root.iterdir()) == []


# ═══════════════════════════════════════════════════════════════════════════
# Owner-only, or refused
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("mode", (0o644, 0o640, 0o604, 0o660, 0o620))
def test_a_group_or_world_accessible_managed_file_is_refused(tmp_path, mode):
    """A typed error naming the file and ``chmod 600``; nothing is loaded.

    On Windows there are no POSIX mode bits: the same file is READ, and
    ``permission_state`` says the check was not made. Both branches assert.
    """
    root = _tree(tmp_path)
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    managed = home / ".amauta" / "env"
    os.chmod(str(managed), mode)
    mod = _load_module()
    report, proc = _run_child(tmp_path, root, home, ["VOYAGE_API_KEY"])

    if os.name != "posix":
        assert proc.returncode == 0, proc.stderr
        assert report["sha"]["VOYAGE_API_KEY"] == FAKE_SHA
        assert mod.permission_state(str(managed)) == mod.PERMISSION_NOT_CHECKED_WINDOWS
        return

    assert proc.returncode != 0, "a %04o keys file was accepted" % mode
    assert report is None, "the child went on after the refusal"
    assert "ManagedEnvPermissionError" in proc.stderr
    assert "chmod 600 %s" % managed in proc.stderr
    assert "%04o" % mode in proc.stderr
    assert mod.permission_state(str(managed)) == mod.PERMISSION_REFUSED

    with pytest.raises(mod.ManagedEnvPermissionError) as caught:
        mod.read_env_file(str(managed), managed=True)
    assert isinstance(caught.value, PermissionError)
    structured = caught.value.as_dict()
    assert structured["code"] == "MANAGED_ENV_TOO_OPEN"
    assert structured["details"] == {
        "path": str(managed), "mode": "%04o" % mode, "fix": "chmod 600 %s" % managed}
    _assert_no_secret(str(caught.value), structured)


def test_an_owner_only_managed_file_is_accepted(tmp_path):
    """``0600`` and the read-only ``0400`` both pass."""
    mod = _load_module()
    for mode in (0o600, 0o400):
        managed = dotenv_probe.write_owner_only(
            tmp_path / ("m%o" % mode) / "env", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
        os.chmod(str(managed), mode)
        assert mod.read_env_file(str(managed), managed=True) == [("VOYAGE_API_KEY", FAKE_KEY)]
        expected = (mod.PERMISSION_OWNER_ONLY if os.name == "posix"
                    else mod.PERMISSION_NOT_CHECKED_WINDOWS)
        assert mod.permission_state(str(managed)) == expected
        os.chmod(str(managed), 0o600)


def test_the_refusal_also_applies_to_the_explicit_path_in_test_mode(tmp_path):
    """The file the launchd plist names is the keys file: same rule."""
    root = _tree(tmp_path)
    explicit = dotenv_probe.write_owner_only(
        tmp_path / "elsewhere" / "keys", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    os.chmod(str(explicit), 0o644)
    report, proc = _run_child(tmp_path, root, _home(tmp_path), ["VOYAGE_API_KEY"],
                              GSD_TEST_MODE="1", GSD_DOTENV_PATH=explicit)
    if os.name != "posix":
        assert proc.returncode == 0, proc.stderr
        return
    assert proc.returncode != 0
    assert "chmod 600 %s" % explicit in proc.stderr


# ═══════════════════════════════════════════════════════════════════════════
# Presence and source — never a value, a prefix or a length
# ═══════════════════════════════════════════════════════════════════════════


def test_presence_names_each_source_and_nothing_else(tmp_path):
    """managed file, repo ``.env``, process environment, absent — before the
    loader ran (``doctor``) and after it (the daemon): the same answer."""
    root = _tree(tmp_path, "PERPLEXITY_API_KEY=%s\nVOYAGE_API_KEY=shadowed\n" % OTHER_FAKE)
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    names = ["VOYAGE_API_KEY", "PERPLEXITY_API_KEY", "OPENAI_API_KEY", "GSD_8910_FROM_SHELL"]
    report, proc = _run_child(tmp_path, root, home, names, mode="presence",
                              GSD_8910_FROM_SHELL="set-in-the-parent")
    assert proc.returncode == 0, proc.stderr
    expected = {
        "VOYAGE_API_KEY": {"present": True, "source": "managed_env_file"},
        "PERPLEXITY_API_KEY": {"present": True, "source": "repo_dotenv"},
        "OPENAI_API_KEY": {"present": False, "source": "absent"},
        "GSD_8910_FROM_SHELL": {"present": True, "source": "process_env"},
    }
    assert report["before_load"] == expected
    assert report["after_load"] == expected


def test_a_refused_file_supplies_nothing_and_the_report_says_why(tmp_path):
    """Reporting never raises: the key is absent and the row names the fix."""
    from services import _89_10_reporting as reporting

    managed = dotenv_probe.write_owner_only(tmp_path / "keys", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    os.chmod(str(managed), 0o644)
    env = {"GSD_DOTENV_PATH": str(managed)}
    fragment = reporting.health_fragment(env)
    rows = reporting.doctor_rows(env)
    _assert_no_secret(fragment, rows)
    if os.name != "posix":
        assert fragment["_managed_env_file"]["permissions"] == "not_checked_windows"
        assert rows[0][0] == reporting.STATUS_OK
        assert "NOT checked on Windows" in rows[0][2]
        return
    assert fragment["VOYAGE_API_KEY"] == {"present": False, "source": "absent"}
    assert fragment["_managed_env_file"] == {
        "path": str(managed), "explicit": True, "exists": True,
        "permissions": "refused_group_or_world_accessible"}
    assert rows[0][0] == reporting.STATUS_WARN
    assert "chmod 600 %s" % managed in rows[0][2]


def test_the_health_fragment_and_doctor_row_carry_presence_and_source_only(tmp_path):
    """The exact shape, so a ``length`` or ``prefix`` field cannot arrive quietly."""
    from services import _89_10_reporting as reporting
    from services import report_hooks

    managed = dotenv_probe.write_owner_only(tmp_path / "keys", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    env = {"GSD_DOTENV_PATH": str(managed), "PERPLEXITY_API_KEY": OTHER_FAKE}
    fragment = reporting.health_fragment(env)
    assert set(fragment) == set(reporting.REPORTED_KEYS) | {"_managed_env_file"}
    for name in reporting.REPORTED_KEYS:
        assert set(fragment[name]) == {"present", "source"}, fragment[name]
        assert isinstance(fragment[name]["present"], bool)
    assert fragment["VOYAGE_API_KEY"] == {"present": True, "source": "managed_env_file"}
    assert fragment["PERPLEXITY_API_KEY"] == {"present": True, "source": "process_env"}
    assert fragment["OPENAI_API_KEY"] == {"present": False, "source": "absent"}
    assert set(fragment["_managed_env_file"]) == {"path", "explicit", "exists", "permissions"}

    (status, category, detail, data), = reporting.doctor_rows(env)
    assert (status, category) == (reporting.STATUS_OK, "keys")
    assert "VOYAGE_API_KEY present (managed_env_file)" in detail
    assert "OPENAI_API_KEY absent" in detail
    assert data == fragment

    # and it arrives through plan 89-09's hooks, under a name with no plan number
    assert "_89_10_reporting" in report_hooks.PROVIDER_MODULES
    assert reporting.HEALTH_KEY == "keys"
    assert report_hooks.extra_health_rows(env)["keys"] == fragment
    assert [r for r in report_hooks.extra_doctor_rows(env) if r[1] == "keys"] == [
        (status, category, detail, data)]
    assert report_hooks.DEGRADED_KEY not in report_hooks.extra_health_rows(env)
    _assert_no_secret(fragment, detail, data, report_hooks.extra_health_rows(env))
    # no fingerprint: nothing numeric that could be a length, no fragment of the value
    blob = json.dumps([fragment, detail])
    for piece in (FAKE_KEY[:4], FAKE_KEY[-4:], str(len(FAKE_KEY)), OTHER_FAKE[-6:]):
        assert piece not in blob.replace(str(managed), ""), piece


def test_inside_a_test_session_a_bare_mapping_does_not_open_the_home_directory():
    """The guard is about the PROCESS. A reporter handed ``{}`` under pytest must
    not conclude it is in production and go looking for ``~/.amauta/env``."""
    from services import _89_10_reporting as reporting

    mod = _load_module()
    assert mod.dotenv_suppressed(env={}) is True
    assert mod.managed_env_path(env={}) == (None, False)
    assert mod.planned_files(str(REPO), env={}) == []
    state = reporting.managed_file_state({})
    assert state == {"path": None, "explicit": False, "exists": False,
                     "permissions": "file_absent"}


def _doctor(tmp_path, managed_body, mode=0o600):
    """Run ``services/doctor.py --json`` under a temporary home."""
    home = tmp_path / "doctor-home"
    home.mkdir()
    managed = dotenv_probe.write_owner_only(home / ".amauta" / "env", managed_body)
    os.chmod(str(managed), mode)
    env = dict(os.environ)
    env.update(dotenv_probe.home_env(home))
    for name in KEY_NAMES + ("ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"):
        env.pop(name, None)
    env.update({
        "GSD_TEST_MODE": "1", "GSD_DOTENV_PATH": str(managed),
        "GSD_AMAUTA_PORT": "18991", "GSD_RLM_PORT": "18992",
        "GSD_POSTGRES_URL": "", "AMAUTA_MEMORY_DATABASE_URL": "",
        "AMAUTA_DATA_DIR": str(tmp_path / "doctor-data"),
    })
    proc = subprocess.run(
        [sys.executable, str(DOCTOR), "--json"], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=90, env=env, cwd=str(REPO),
    )
    _assert_no_secret(proc.stdout, proc.stderr)
    checks = {c["category"]: c for c in json.loads(proc.stdout)["checks"]}
    return checks, managed, proc


def test_doctor_reports_presence_and_never_the_value(tmp_path):
    """The command that reports presence: ``doctor --json``, category ``keys``."""
    checks, managed, _proc = _doctor(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    row = checks["keys"]
    assert row["status"] == "OK"
    assert row["data"]["VOYAGE_API_KEY"] == {"present": True, "source": "managed_env_file"}
    assert row["data"]["PERPLEXITY_API_KEY"] == {"present": False, "source": "absent"}
    assert row["data"]["_managed_env_file"]["path"] == str(managed)
    expected = "owner_only" if os.name == "posix" else "not_checked_windows"
    assert row["data"]["_managed_env_file"]["permissions"] == expected
    if os.name != "posix":
        assert "NOT checked on Windows" in row["detail"]
    # the pre-existing api_keys row agrees with it instead of saying "off"
    assert "embeddings on" in checks["api_keys"]["detail"]
    assert "research-chain web leg off" in checks["api_keys"]["detail"]


def test_doctor_warns_with_the_fix_when_the_file_is_too_open(tmp_path):
    """POSIX: WARN naming ``chmod 600``. Windows: stated as not checked."""
    checks, managed, _proc = _doctor(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY, mode=0o644)
    row = checks["keys"]
    if os.name != "posix":
        assert row["status"] == "OK" and "NOT checked on Windows" in row["detail"]
        return
    assert row["status"] == "WARN"
    assert "chmod 600 %s" % managed in row["detail"]
    assert row["data"]["VOYAGE_API_KEY"] == {"present": False, "source": "absent"}
    assert "embeddings off" in checks["api_keys"]["detail"]


# ═══════════════════════════════════════════════════════════════════════════
# One loader, and the file is neither indexed nor a fifth copy
# ═══════════════════════════════════════════════════════════════════════════


def test_the_backfill_script_no_longer_carries_its_own_copy():
    """``scripts/backfill-project-id.py`` used a fifth copy of the suppression
    predicate and its own line parser; it calls the one loader now."""
    source = (REPO / "scripts" / "backfill-project-id.py").read_text(encoding="utf-8")
    assert "def _dotenv_suppressed(" not in source
    assert "PYTEST_CURRENT_TEST" not in source
    assert "_dotenv.dotenv_suppressed()" in source
    assert "_dotenv.read_env_file(" in source
    loader = LOADER.read_text(encoding="utf-8")
    assert loader.count("def dotenv_suppressed(") == 1
    assert loader.count("def load_dotenv(") == 1


class _UntouchableConnection:
    """A connection double that fails the test the moment anything uses it."""

    def __getattr__(self, name):
        raise AssertionError("ingest_file reached the database (%s) for a file "
                             "it must not index" % name)


def test_a_file_named_exactly_env_is_not_indexed(tmp_path):
    """``ingest_file`` indexes nothing for a file literally named ``env``.

    The reason is the file's SUFFIX, not a skip list: ``Path("env").suffix`` is
    ``""``, which is in neither ``AST_EXTENSIONS`` nor ``LEGACY_EXTENSIONS``
    (services/rlm_ingestion.py), so the function returns before it touches the
    connection. This asserts the property; it does not patch the module.
    """
    from services import rlm_ingestion

    managed = dotenv_probe.write_owner_only(
        tmp_path / ".amauta" / "env", "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    assert Path(str(managed)).suffix == ""
    assert "" not in rlm_ingestion.AST_EXTENSIONS
    assert "" not in rlm_ingestion.LEGACY_EXTENSIONS
    result = rlm_ingestion.ingest_file(str(managed), _UntouchableConnection())
    assert result["status"] == "skipped"
    assert result["chunks_inserted"] == 0
    assert result["error"] is None


# ═══════════════════════════════════════════════════════════════════════════
# Through a daemon whose parent environment has no key
# ═══════════════════════════════════════════════════════════════════════════

#: Starts the daemon with the NETWORK leg of the memory embedding replaced by
#: the deterministic stand-in. Everything above that leg is the product's own:
#: the loader, the route's key gate, ``_detect_embedding_provider`` (which reads
#: the key from the daemon's environment) and the INSERT. With no key in the
#: daemon's environment the stand-in returns None exactly as the real call does,
#: so an embedded row proves the key reached THIS process. The fake key never
#: leaves the machine: no request is made.
LAUNCHER = r'''
import os, runpy, sys
daemon, support = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(os.path.abspath(daemon)))
sys.path.insert(0, support)
import pg_store
import stub_embeddings

def _stand_in(text, model=None, input_type=None):
    _name, cfg = pg_store.PGStore._detect_embedding_provider()
    if cfg is None or not os.environ.get(cfg["env_key"]):
        return None
    return stub_embeddings.deterministic_embedding(text, input_type=input_type or "document")

pg_store.PGStore.generate_embedding = staticmethod(_stand_in)
sys.argv = [daemon] + sys.argv[3:]
runpy.run_path(daemon, run_name="__main__")
'''


def _http(port, method, path, body=None):
    """One request to a fixture daemon on 127.0.0.1; ``(status, raw, decoded)``."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw, status = response.read().decode("utf-8"), response.status
    except urllib.error.HTTPError as err:
        raw, status = err.read().decode("utf-8"), err.code
    try:
        return status, raw, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw, None


class _Daemon:
    """A fixture daemon, its transcripts kept so they can be searched."""

    def __init__(self, tmp_path, tag, env, launcher=False):
        self.out_path = tmp_path / ("%s.out" % tag)
        self.err_path = tmp_path / ("%s.err" % tag)
        self.out_f = open(self.out_path, "w", encoding="utf-8")
        self.err_f = open(self.err_path, "w", encoding="utf-8")
        argv = [sys.executable, str(DAEMON), "run"]
        if launcher:
            script = tmp_path / "daemon_launcher.py"
            script.write_text(LAUNCHER, encoding="utf-8")
            argv = [sys.executable, str(script), str(DAEMON), str(SUPPORT), "run"]
        self.proc = subprocess.Popen(argv, stdout=self.out_f, stderr=self.err_f, env=env)
        self.port = None
        deadline = time.time() + READY_TIMEOUT
        while time.time() < deadline and self.proc.poll() is None:
            if self.port is None:
                for line in self.out_path.read_text(encoding="utf-8", errors="replace").splitlines():
                    if line.startswith("DAEMON_PORT="):
                        self.port = int(line.split("=", 1)[1])
                        break
            if self.port is not None:
                try:
                    if _http(self.port, "GET", "/health")[0] == 200:
                        return
                except Exception:  # noqa: BLE001 - not listening yet
                    pass
            time.sleep(0.1)
        code = self.proc.poll()
        self.stop()
        raise RuntimeError("fixture daemon (%s) not ready: exit_code=%r port=%r\n--- stdout ---\n%s\n"
                           "--- stderr ---\n%s" % (tag, code, self.port, self.transcripts()[0][-3000:],
                                                   self.transcripts()[1][-5000:]))

    def stop(self):
        """Terminate exactly the process this object started."""
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - slow shutdown
                self.proc.kill()
                self.proc.wait()
        self.out_f.close()
        self.err_f.close()

    def transcripts(self):
        """``(stdout, stderr)`` as written so far."""
        return (self.out_path.read_text(encoding="utf-8", errors="replace"),
                self.err_path.read_text(encoding="utf-8", errors="replace"))


def _daemon_env(tmp_path, tag, home, dotenv_path):
    """The pinned child environment: a temporary home, no key, no live port."""
    data_dir = tmp_path / ("%s-data" % tag)
    data_dir.mkdir()
    env = dict(os.environ)
    for key in KEY_NAMES + ("GSD_POSTGRES_URL", "DATABASE_URL", "REDIS_URL", "GSD_DATA_DIR",
                            "GSD_EMBEDDING_PROVIDER"):
        env.pop(key, None)
    env.update(dotenv_probe.home_env(home))
    env.update({
        "GSD_AMAUTA_PORT": "0", "GSD_DAEMON_PORT": "0", "GSD_RLM_PORT": "0",
        "GSD_RLM_ENABLED": "false", "GSD_REDIS_ENABLED": "false",
        "AMAUTA_DATA_DIR": str(data_dir), "AMAUTA_AUTO_BACKUP": "off",
        "AMAUTA_MEMORY_DATABASE_URL": "", "GSD_AMAUTA_NO_AUTO_START": "1",
        "PYTHONFAULTHANDLER": "1", "GSD_SQLITE_PATH": str(data_dir / "gsd_amauta.db"),
        "GSD_DOTENV_PATH": str(dotenv_path),
    })
    # THE POINT OF THE TEST: the daemon's parent hands it no key at all.
    for name in KEY_NAMES:
        assert name not in env, "%s is in the fixture daemon's parent environment" % name
    return env


def test_health_reports_presence_from_the_managed_file_and_never_the_value(tmp_path):
    """A daemon started with NO key in its environment reports the key present,
    source ``managed_env_file`` — and nothing it prints or serves has the value.

    SQLite backend, test mode: the loader is inert there unless
    ``GSD_DOTENV_PATH`` is set, and this sets it. Runs on every cell and locally.
    """
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    managed = home / ".amauta" / "env"
    env = _daemon_env(tmp_path, "sqlite", home, managed)
    env.update({"GSD_TEST_MODE": "1", "GSD_FORCE_SQLITE": "1", "GSD_BACKEND": "sqlite"})
    daemon = _Daemon(tmp_path, "sqlite", env)
    try:
        status, raw, health = _http(daemon.port, "GET", "/health")
        assert status == 200
        keys = health["extra"]["keys"]
        assert keys["VOYAGE_API_KEY"] == {"present": True, "source": "managed_env_file"}
        assert keys["PERPLEXITY_API_KEY"] == {"present": False, "source": "absent"}
        assert keys["_managed_env_file"]["path"] == str(managed)
        assert keys["_managed_env_file"]["explicit"] is True
        assert "_degraded" not in health["extra"], health["extra"]
        _assert_no_secret(raw)
    finally:
        daemon.stop()
    _assert_no_secret(*daemon.transcripts())

    # the mutation: no file, same start -> absent, with a named source
    managed.unlink()
    daemon = _Daemon(tmp_path, "sqlite-nofile", _daemon_env(tmp_path, "sqlite-nofile", home, managed)
                     | {"GSD_TEST_MODE": "1", "GSD_FORCE_SQLITE": "1", "GSD_BACKEND": "sqlite"})
    try:
        _status, raw, health = _http(daemon.port, "GET", "/health")
        assert health["extra"]["keys"]["VOYAGE_API_KEY"] == {"present": False, "source": "absent"}
        assert health["extra"]["keys"]["_managed_env_file"]["exists"] is False
    finally:
        daemon.stop()
    assert not managed.exists(), "the daemon created the keys file"


def _scratch_database():
    """A scratch database on the disposable server; ``(dsn, drop)``."""
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    from services import migrate_runner, pg_dsn

    test_dsn = assert_test_dsn_is_not_live(postgres_dsn_or_none(), where="test_89_10_managed_env")
    name = "gsd_8910_" + uuid.uuid4().hex[:12]
    admin = pg_dsn.dsn_with_database(test_dsn, "postgres")
    conn = psycopg2.connect(admin, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with conn.cursor() as cur:
        cur.execute('CREATE DATABASE "%s"' % name)
    conn.close()
    dsn = pg_dsn.dsn_with_database(test_dsn, name)
    migrate_runner.apply_migrations(dsn=dsn, log=lambda *_: None)

    def drop():
        c = psycopg2.connect(admin, connect_timeout=10)
        c.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        with c.cursor() as cur2:
            cur2.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                         "WHERE datname = %s AND pid <> pg_backend_pid()", (name,))
            cur2.execute('DROP DATABASE IF EXISTS "%s"' % name)
        c.close()

    return dsn, drop


def _stored_row(dsn, text):
    """``(found, has_embedding, dimensions)`` of the memory row holding ``text``."""
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT embedding IS NOT NULL, vector_dims(embedding) "
                        "FROM gsd_memory WHERE text = %s", (text,))
            rows = cur.fetchall()
    finally:
        conn.close()
    assert len(rows) == 1, "expected one row for %r, found %d" % (text, len(rows))
    return rows[0]


def _postgres_daemon(tmp_path, tag, home, managed, dsn):
    """A PostgreSQL-backed daemon whose only source of a key is ``managed``."""
    env = _daemon_env(tmp_path, tag, home, managed)
    # EMPTY, not absent: see tests/test_89_05_inbox_round_trip.py — test mode
    # would serve SQLite. The loader is still inert apart from GSD_DOTENV_PATH,
    # because PYTEST_CURRENT_TEST is inherited.
    for key in ("GSD_TEST_MODE", "GSD_FORCE_SQLITE", "GSD_BACKEND"):
        env[key] = ""
    assert env.get("PYTEST_CURRENT_TEST"), "the child would read ambient .env files"
    env["GSD_POSTGRES_URL"] = dsn
    return _Daemon(tmp_path, tag, env, launcher=True)


@requires_pg
def test_a_memory_stored_through_the_daemon_comes_back_embedded(tmp_path):
    """FND-02's acceptance: the key reaches the DAEMON process from the file.

    The daemon's parent environment has no key (asserted in ``_daemon_env``).
    With the managed file the stored row has an embedding; with the file
    removed and the daemon restarted the row has none and ``/health`` says the
    key is absent.
    """
    dsn, drop = _scratch_database()
    home = _home(tmp_path, "VOYAGE_API_KEY=%s\n" % FAKE_KEY)
    managed = home / ".amauta" / "env"
    try:
        daemon = _postgres_daemon(tmp_path, "pg-with-file", home, managed, dsn)
        try:
            _status, raw, health = _http(daemon.port, "GET", "/health")
            assert health.get("backend") == "postgresql" and health.get("degraded") is False, health
            assert health["extra"]["keys"]["VOYAGE_API_KEY"] == {
                "present": True, "source": "managed_env_file"}
            _assert_no_secret(raw)
            text = "plan 89-10 managed keys file acceptance " + uuid.uuid4().hex
            status, raw, _body = _http(daemon.port, "POST", "/api/memory/store",
                                       {"text": text, "source": "test-89-10"})
            assert status == 200, raw
            _assert_no_secret(raw)
            assert _stored_row(dsn, text) == (True, 1024)
        finally:
            daemon.stop()
        _assert_no_secret(*daemon.transcripts())

        managed.unlink()
        daemon = _postgres_daemon(tmp_path, "pg-no-file", home, managed, dsn)
        try:
            _status, _raw, health = _http(daemon.port, "GET", "/health")
            assert health.get("backend") == "postgresql", health
            assert health["extra"]["keys"]["VOYAGE_API_KEY"] == {
                "present": False, "source": "absent"}
            text = "plan 89-10 managed keys file mutation " + uuid.uuid4().hex
            status, raw, _body = _http(daemon.port, "POST", "/api/memory/store",
                                       {"text": text, "source": "test-89-10"})
            assert status == 200, raw
            assert _stored_row(dsn, text) == (False, None)
        finally:
            daemon.stop()
        _assert_no_secret(*daemon.transcripts())
        assert not managed.exists()
    finally:
        drop()
