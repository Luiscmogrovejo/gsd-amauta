"""pytest configuration: hermetic environment for every Python test (plan 88-01).

The session fixture below runs before any test and applies the same scrub as
scripts/run-tests.cjs: SQLite forced, test mode on, temporary data and config
directories, ports moved off the operator's live services, and the socket guard
installed. HOME is not modified (replacing it hides user-site packages).
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_REPO = _TESTS_DIR.parent
_SUPPORT = _TESTS_DIR / "support"
if str(_SUPPORT) not in sys.path:
    sys.path.insert(0, str(_SUPPORT))

import hermetic_guard  # noqa: E402

_DELETED_KEYS = (
    "GSD_POSTGRES_URL",
    "DATABASE_URL",
    "AMAUTA_MEMORY_DATABASE_URL",
    "VALKEY_URL",
    "REDIS_URL",
    "GSD_PG_PORT",
)
_LIVE_PORTS = {18799, 18798, 6379, 5433}

# ---------------------------------------------------------------------------
# Plan 88-16-03: the ONE disposable-Postgres opt-in, validated before anything
# can use it. psycopg2 is a C extension, so the in-process socket guard cannot
# see libpq's connect — this check is the control that DOES bind it, which is
# why it stops collection rather than warning. (Plan 88-18 hit exactly this:
# tests/test_85_memsafe_counter_proofs.py dialled the default 127.0.0.1:5433
# through psycopg2, past a guard that never saw it.)
# ---------------------------------------------------------------------------

#: The single reason a Postgres-dependent test carries when none is configured.
#: tests/support/pg-fixture.cjs carries the same sentence for the Node suite.
PG_SKIP_REASON = (
    "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test "
    "(CI provides one; the operator machine deliberately has none)"
)


def _port_of_dsn(dsn):
    """Return the TCP port named by a PostgreSQL DSN, or None.

    Args:
        dsn: a ``postgresql://user:pass@host:port/db`` URL.

    Returns:
        int | None: the port, or None when the DSN names none.
    """
    if not dsn:
        return None
    import urllib.parse

    try:
        port = urllib.parse.urlparse(dsn).port
    except ValueError:
        port = None
    if port is None:
        import re as _re

        m = _re.search(r":(\d{2,5})/", dsn)
        port = int(m.group(1)) if m else None
    return port


def assert_test_dsn_is_not_live(dsn, where="conftest"):
    """Refuse a test DSN that points at one of the operator's live services.

    Args:
        dsn: the DSN to check.
        where: a label used in the error message.

    Returns:
        str: the same DSN, when it is safe.

    Raises:
        RuntimeError: when the DSN's port is 18799, 18798, 6379 or 5433.

    Example:
        >>> assert_test_dsn_is_not_live("postgresql://u:p@127.0.0.1:5434/db")
        'postgresql://u:p@127.0.0.1:5434/db'
    """
    port = _port_of_dsn(dsn)
    if port is not None and port in _LIVE_PORTS:
        raise RuntimeError(
            "%s: refusing a test DSN on live service port %d. 18799 (daemon), 18798 "
            "(RLM), 6379 (Redis) and 5433 (the operator's PostgreSQL) are never test "
            "ports; give the disposable database a different port." % (where, port)
        )
    return dsn


# Validated at import, i.e. before a single test module is collected.
_TEST_PG_DSN = (os.environ.get("GSD_TEST_POSTGRES_URL") or "").strip()
if _TEST_PG_DSN:
    assert_test_dsn_is_not_live(_TEST_PG_DSN, where="conftest(GSD_TEST_POSTGRES_URL)")
    _TEST_PG_PORT = _port_of_dsn(_TEST_PG_DSN)
    if _TEST_PG_PORT is not None:
        _allow = [
            p.strip()
            for p in os.environ.get("GSD_HERMETIC_GUARD_ALLOW_PORTS", "").split(",")
            if p.strip()
        ]
        if str(_TEST_PG_PORT) not in _allow:
            _allow.append(str(_TEST_PG_PORT))
        os.environ["GSD_HERMETIC_GUARD_ALLOW_PORTS"] = ",".join(_allow)

    # Plan 88-16-09, and it happens HERE — at conftest import — because pytest
    # imports every test module during collection, which is before any fixture
    # runs, and roughly sixty tests construct a `PGStore()` at module import to
    # decide whether to skip.
    #
    # The session scrub deletes GSD_POSTGRES_URL and DATABASE_URL so that no
    # test can inherit the OPERATOR'S live DSN. When CI has supplied a
    # disposable one, the product's own clients must be able to reach it:
    # services/pg_store.py, services/complexity_scorer.py and the party modules
    # read those two names and nothing else. The guarantee is therefore
    # SHARPENED rather than dropped — a test may only ever see a DSN this file
    # has CHECKED against the live ports, and a DSN naming one has already
    # raised above. With no disposable database (the operator's machine,
    # always) both names stay deleted and every Postgres test skips with the
    # one standard reason.
    os.environ["GSD_POSTGRES_URL"] = _TEST_PG_DSN
    os.environ["DATABASE_URL"] = _TEST_PG_DSN

# The guard writes one line per refusal here. When the Node runner spawned this
# interpreter it has already named a file; a bare `pytest` run gets its own.
if not os.environ.get("GSD_HERMETIC_GUARD_LOG"):
    import tempfile as _tempfile

    os.environ["GSD_HERMETIC_GUARD_LOG"] = os.path.join(
        _tempfile.gettempdir(), "gsd-hermetic-refusals-%d.tsv" % os.getpid()
    )

# Install the socket guard at conftest import, which is BEFORE pytest collects
# any test module. A module-level probe (``_daemon_ready()`` in
# tests/test_capability_e2e.py used to GET the live daemon at import) runs during
# collection, i.e. before the session fixture below; with the guard installed
# only there, collection itself reached the operator's live daemon (88-08-03).
# install() is idempotent, so the session fixture's later call is a no-op.
hermetic_guard.install()


def _free_port(avoid=()):
    """Bind port 0 on 127.0.0.1 and return the port the OS chose.

    Args:
        avoid: ports that must not be returned.

    Returns:
        A free port that is not one of the live service ports.
    """
    for _ in range(10):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in _LIVE_PORTS and port not in avoid:
            return port
    raise RuntimeError("could not obtain a free port")


@pytest.fixture(autouse=True, scope="session")
def _gsd_hermetic_env(tmp_path_factory):
    """Scrub the environment and install the socket guard before any test runs."""
    for key in _DELETED_KEYS:
        # The VALIDATED disposable DSN survives the scrub (plan 88-16-09, set
        # at conftest import above); the operator's live one never enters the
        # environment at all. With no disposable database both names go.
        if _TEST_PG_DSN and key in ("GSD_POSTGRES_URL", "DATABASE_URL"):
            continue
        os.environ.pop(key, None)
    os.environ.update(
        {
            "GSD_FORCE_SQLITE": "1",
            "GSD_BACKEND": "sqlite",
            "GSD_TEST_MODE": "1",
            "GSD_REDIS_ENABLED": "false",
            "GSD_RLM_ENABLED": "false",
            "GSD_AMAUTA_NO_AUTO_START": "1",
            "GSD_INSTALL_FILES_ONLY": "1",
            "AMAUTA_AUTO_BACKUP": "off",
        }
    )
    root = tmp_path_factory.mktemp("gsd-hermetic")
    data_dir = root / "data"
    config_dir = root / ".claude"
    data_dir.mkdir()
    config_dir.mkdir()
    os.environ["AMAUTA_DATA_DIR"] = str(data_dir)
    os.environ["CLAUDE_CONFIG_DIR"] = str(config_dir)

    daemon_port = _free_port()
    rlm_port = _free_port(avoid=(daemon_port,))
    os.environ["GSD_AMAUTA_PORT"] = str(daemon_port)
    os.environ["GSD_DAEMON_PORT"] = str(daemon_port)
    os.environ["GSD_RLM_PORT"] = str(rlm_port)
    redis_port = _free_port(avoid=(daemon_port, rlm_port))
    os.environ["AMAUTA_PORT"] = str(daemon_port)
    os.environ["GSD_REDIS_PORT"] = str(redis_port)
    os.environ["GSD_REDIS_URL"] = "redis://127.0.0.1:%d/0" % redis_port

    pypath = str(_SUPPORT / "pythonpath")
    existing = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = pypath + (os.pathsep + existing if existing else "")

    hermetic_guard.install()
    yield


class FixtureDaemon:
    """Handle for a daemon started by the ``fixture_daemon`` fixture."""

    def __init__(self, port, data_dir, env, proc):
        self.port = port
        self.data_dir = data_dir
        self.env = env
        self.proc = proc


def _daemon_not_ready_report(proc, out_path, err_path, port, started, timeout):
    """Describe a fixture daemon that did not become ready, with enough to diagnose it.

    A bare "did not become ready" with an empty stderr (the macOS CI cell, 88-13) says
    nothing. This reports whether the process exited (and how), the port it announced, how
    long it ran, and both output tails. When the process is still alive on a POSIX system
    it is sent SIGABRT first: ``PYTHONFAULTHANDLER=1`` makes it print every thread's
    traceback to stderr, which names the line it is stuck on.

    Args:
        proc: the ``subprocess.Popen`` of the daemon.
        out_path: path of the file holding its stdout.
        err_path: path of the file holding its stderr.
        port: the announced port, or None.
        started: ``time.time()`` when it was spawned.
        timeout: the readiness budget in seconds.

    Returns:
        str: the multi-line report used as the RuntimeError message.
    """
    exit_code = proc.poll()
    still_alive = exit_code is None
    if still_alive and hasattr(signal, "SIGABRT") and sys.platform != "win32":
        try:
            proc.send_signal(signal.SIGABRT)
            proc.wait(timeout=5)
        except Exception:  # best effort: the teardown terminates it anyway
            pass
    out_tail = out_path.read_text(encoding="utf-8", errors="replace")[-2000:]
    err_tail = err_path.read_text(encoding="utf-8", errors="replace")[-4000:]
    return (
        "fixture daemon did not become ready: "
        "exit_code=%r still_alive_at_deadline=%r announced_port=%r elapsed=%.1fs budget=%.0fs\n"
        "--- stdout tail ---\n%s\n--- stderr tail ---\n%s"
        % (exit_code, still_alive, port, time.time() - started, timeout, out_tail, err_tail)
    )


@pytest.fixture
def fixture_daemon(tmp_path):
    """Start services/amauta-daemon.py on an ephemeral port with the SQLite backend.

    Same contract as tests/support/fixture-daemon.cjs: GSD_AMAUTA_PORT=0 makes the
    daemon bind an ephemeral port and print ``DAEMON_PORT=<n>``; readiness is polled
    on /health (never a fixed sleep). Yields an object with ``.port``, ``.data_dir``
    and ``.env``; terminates the process on teardown (terminate, then kill).

    Raises:
        RuntimeError: when the daemon does not become ready within 20 s; the
            message ends with the last 2000 characters of its stderr.
    """
    data_dir = tmp_path / "fixture-data"
    data_dir.mkdir()
    env = dict(os.environ)
    for key in ("GSD_POSTGRES_URL", "DATABASE_URL", "REDIS_URL", "GSD_SQLITE_PATH", "GSD_DATA_DIR"):
        env.pop(key, None)
    env.update(
        {
            "GSD_TEST_MODE": "1",
            "GSD_AMAUTA_PORT": "0",
            "GSD_DAEMON_PORT": "0",
            "GSD_FORCE_SQLITE": "1",
            "GSD_BACKEND": "sqlite",
            "AMAUTA_DATA_DIR": str(data_dir),
            "AMAUTA_AUTO_BACKUP": "off",
            "GSD_REDIS_ENABLED": "false",
            "GSD_RLM_ENABLED": "false",
        }
    )
    out_path = tmp_path / "fixture-daemon.out"
    err_path = tmp_path / "fixture-daemon.err"
    out_f = open(out_path, "w", encoding="utf-8")
    err_f = open(err_path, "w", encoding="utf-8")
    # PYTHONFAULTHANDLER lets the stuck-daemon diagnostic below (SIGABRT) print every
    # thread's traceback to the daemon's stderr instead of dying silently.
    env["PYTHONFAULTHANDLER"] = "1"
    started = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(_REPO / "services" / "amauta-daemon.py"), "run"],
        stdout=out_f,
        stderr=err_f,
        env=env,
    )
    try:
        port = None
        timeout = float(os.environ.get("GSD_FIXTURE_DAEMON_READY_TIMEOUT", "20"))
        deadline = started + timeout
        ready = False
        while time.time() < deadline and proc.poll() is None:
            if port is None:
                for line in out_path.read_text(encoding="utf-8", errors="replace").splitlines():
                    if line.startswith("DAEMON_PORT="):
                        port = int(line.split("=", 1)[1])
                        break
            if port is not None:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
                        if r.status == 200:
                            ready = True
                            break
                except Exception:
                    pass
            time.sleep(0.1)
        if not ready:
            raise RuntimeError(_daemon_not_ready_report(proc, out_path, err_path, port, started, timeout))
        yield FixtureDaemon(
            port,
            data_dir,
            {
                "GSD_AMAUTA_PORT": str(port),
                "GSD_DAEMON_PORT": str(port),
                "AMAUTA_DATA_DIR": str(data_dir),
                "GSD_TEST_MODE": "1",
                "GSD_FORCE_SQLITE": "1",
            },
            proc,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        out_f.close()
        err_f.close()


# ---------------------------------------------------------------------------
# Plan 88-08 shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def backend_selection_env(monkeypatch):
    """Clear the variables the hermetic scrub exports so a test can exercise backend selection.

    The session scrub sets ``GSD_FORCE_SQLITE=1``, ``GSD_BACKEND=sqlite`` and
    ``GSD_TEST_MODE=1``. The daemon's ``_force_sqlite()`` answers True for any of
    them, so a test that asks "does an unset or later-written variable count as an
    operator choice?" cannot see its own inputs. This fixture removes exactly those
    three names for one test (monkeypatch restores them afterwards). It does not
    touch the socket guard, the port scrub or the data-dir isolation, so the test
    still cannot reach a live service.

    Yields:
        None.
    """
    for key in ("GSD_FORCE_SQLITE", "GSD_BACKEND", "GSD_TEST_MODE"):
        monkeypatch.delenv(key, raising=False)
    yield


def _postgres_dsn_or_skip():
    """Return ``GSD_TEST_POSTGRES_URL`` or skip the calling test with a named reason.

    Kept as a plain function so a test can exercise the skip contract directly,
    and so the ``unittest.TestCase`` suites (``test_a2a_*``) can call it from
    ``setUpClass`` where a pytest fixture is not available.

    Returns:
        The DSN string.

    Raises:
        pytest.skip.Exception: when ``GSD_TEST_POSTGRES_URL`` is unset or empty.
        RuntimeError: when it names one of the operator's live service ports.
    """
    dsn = (os.environ.get("GSD_TEST_POSTGRES_URL") or "").strip()
    if not dsn:
        pytest.skip(PG_SKIP_REASON)
    return assert_test_dsn_is_not_live(dsn, where="postgres_dsn")


def postgres_dsn_or_none():
    """The validated test DSN, or None — for a module-level ``skipif`` condition.

    Returns:
        str | None: the DSN, or None when no disposable database was supplied.

    Raises:
        RuntimeError: when the supplied DSN names a live service port.
    """
    dsn = (os.environ.get("GSD_TEST_POSTGRES_URL") or "").strip()
    if not dsn:
        return None
    return assert_test_dsn_is_not_live(dsn, where="postgres_dsn_or_none")


@pytest.fixture(scope="session")
def postgres_dsn():
    """DSN of a disposable Postgres, or skip when none was provided.

    The opt-in variable is ``GSD_TEST_POSTGRES_URL``, deliberately not
    ``GSD_POSTGRES_URL``: the session scrub deletes the latter so that no test can
    inherit the operator's live DSN, and this helper must not reintroduce it.
    Never starts a container; CI supplies the service (plan 88-16-03/-04).

    Returns:
        The DSN string from ``GSD_TEST_POSTGRES_URL``.
    """
    return _postgres_dsn_or_skip()


class product_pg_dsn:  # noqa: N801 - used as a context manager, reads like one
    """Point the PRODUCT's PostgreSQL clients at the disposable database.

    The session scrub deletes ``GSD_POSTGRES_URL`` and ``DATABASE_URL`` from the
    environment so that no test can inherit the operator's live DSN. A test that
    drives ``services/pg_store.py`` or ``services/a2a_client.py`` against the
    disposable database therefore has to put one back — deliberately, for the
    duration of one block, and only after the DSN has been checked against the
    live ports.

    Usable as a context manager or, for ``unittest.TestCase`` classes where a
    pytest fixture is not available, entered in ``setUpClass`` and exited in
    ``tearDownClass``.

    Raises:
        pytest.skip.Exception: when no disposable database is configured.
        RuntimeError: when the configured DSN names a live service port.

    Example:
        with product_pg_dsn() as dsn:
            store = PGStore()
    """

    _KEYS = ("GSD_POSTGRES_URL", "DATABASE_URL")

    def __init__(self, dsn=None):
        self._dsn = dsn
        self._saved = {}

    def __enter__(self):
        dsn = self._dsn or _postgres_dsn_or_skip()
        self._saved = {k: os.environ.get(k) for k in self._KEYS}
        for key in self._KEYS:
            os.environ[key] = dsn
        return dsn

    def __exit__(self, *_exc):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return False


@pytest.fixture
def enforcing_guard(monkeypatch):
    """Pin the guard to ENFORCE for a test that asserts it refuses.

    Plan 88-16-03 rolls default-deny out in LOG-ONLY mode first
    (``GSD_HERMETIC_GUARD_MODE=log``) so one CI run can inventory what the
    suite really reaches before enforcement turns a surprise red. A test whose
    subject IS the refusal must not be at the mercy of that ambient setting:
    in log-only mode it would watch the guard wave the connection through and
    then fail — which is exactly what the first rollout run did, on ten Python
    cases and eight Node ones. Pinning the mode here makes the self-tests state
    their own premise instead of inheriting one.

    Yields:
        None.
    """
    monkeypatch.setenv("GSD_HERMETIC_GUARD_MODE", "enforce")
    yield


@pytest.fixture
def allow_host(monkeypatch):
    """Let ONE test reach ONE non-loopback host, and restore afterwards.

    The guards are default-deny for every non-loopback destination (plan
    88-16-03). This is the only sanctioned way through, and it is deliberately
    function-scoped: ``monkeypatch`` restores ``GSD_HERMETIC_GUARD_ALLOW_HOSTS``
    when the test ends, so the allowance cannot leak into the next one. Both
    guards read the variable at CHECK time, which is what makes setting it after
    the guard has armed work at all.

    Yields:
        Callable[[str], None]: call it with the host name to permit.

    Raises:
        RuntimeError: when asked for a loopback host — that would be a back
            door, not an allowance (loopback is already permitted and stays
            subject to the live-port block).

    Example:
        def test_calls_out(allow_host):
            allow_host("api.voyageai.com")
            ...
    """
    import hermetic_guard as _hg

    def _allow(host):
        if _hg.is_loopback_host(host):
            raise RuntimeError(
                "allow_host(%r): loopback is already permitted and allowing it by "
                "name would be a back door" % host
            )
        current = [
            h.strip()
            for h in os.environ.get("GSD_HERMETIC_GUARD_ALLOW_HOSTS", "").split(",")
            if h.strip()
        ]
        if host not in current:
            current.append(host)
        monkeypatch.setenv("GSD_HERMETIC_GUARD_ALLOW_HOSTS", ",".join(current))

    yield _allow


# ---------------------------------------------------------------------------
# Plan 88-16-05: a fixture RLM service, the Python counterpart of
# tests/support/fixture-rlm.cjs
# ---------------------------------------------------------------------------


class FixtureRlm:
    """Handle for an RLM service started by this module."""

    def __init__(self, port, data_dir, proc):
        self.port = port
        self.data_dir = data_dir
        self.proc = proc
        self.base_url = "http://127.0.0.1:%d" % port


def _start_rlm(data_dir, dsn=None, ready_timeout=60.0):
    """Start ``services/rlm-service.py`` on a port chosen here and wait for /health.

    The helper picks the port rather than passing 0 because the service reads
    ``GSD_RLM_PORT`` into a module constant and prints that value, so a 0 there
    would bind a port no caller could learn. ``_free_port()`` already excludes
    the live service ports, so 18798 — the operator's RLM — can never be chosen.

    Args:
        data_dir: the service's ``AMAUTA_DATA_DIR``; its pid file lands there,
            never beside the script where the live service keeps its own.
        dsn: a disposable PostgreSQL DSN to give the service, or None.
        ready_timeout: seconds to wait for a 200 from ``/health``.

    Returns:
        FixtureRlm

    Raises:
        RuntimeError: when the service does not answer in time; the message
            carries both output tails.
    """
    port = _free_port()
    env = dict(os.environ)
    for key in ("GSD_SQLITE_PATH", "GSD_DATA_DIR", "REDIS_URL"):
        env.pop(key, None)
    env.update(
        {
            "GSD_TEST_MODE": "1",
            "AMAUTA_DATA_DIR": str(data_dir),
            "GSD_RLM_ENABLED": "true",
            "GSD_RLM_PORT": str(port),
            "AMAUTA_AUTO_BACKUP": "off",
            "GSD_REDIS_ENABLED": "false",
        }
    )
    if dsn:
        env["GSD_POSTGRES_URL"] = assert_test_dsn_is_not_live(dsn, where="_start_rlm")
    else:
        env.pop("GSD_POSTGRES_URL", None)

    out_path = Path(data_dir) / "fixture-rlm.out"
    err_path = Path(data_dir) / "fixture-rlm.err"
    out_f = open(out_path, "w", encoding="utf-8")
    err_f = open(err_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, str(_REPO / "services" / "rlm-service.py"), "run"],
        stdout=out_f,
        stderr=err_f,
        env=env,
    )
    deadline = time.time() + ready_timeout
    ready = False
    while time.time() < deadline and proc.poll() is None:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
                if r.status == 200:
                    ready = True
                    break
        except Exception:
            pass
        time.sleep(0.1)
    out_f.close()
    err_f.close()
    if not ready:
        _stop_rlm(FixtureRlm(port, data_dir, proc))
        raise RuntimeError(
            "fixture RLM did not become ready on 127.0.0.1:%d (exit_code=%r)\n"
            "--- stdout ---\n%s\n--- stderr ---\n%s"
            % (
                port,
                proc.poll(),
                out_path.read_text(encoding="utf-8", errors="replace")[-2000:],
                err_path.read_text(encoding="utf-8", errors="replace")[-4000:],
            )
        )
    return FixtureRlm(port, data_dir, proc)


def _stop_rlm(handle):
    """Terminate the service BY PID, then kill it if it will not go.

    Args:
        handle: the FixtureRlm to stop.

    Returns:
        None.
    """
    if handle is None or handle.proc is None:
        return
    try:
        handle.proc.terminate()
        handle.proc.wait(timeout=5)
    except Exception:
        try:
            handle.proc.kill()
            handle.proc.wait(timeout=5)
        except Exception:
            pass


#: The session-wide fixture RLM, started by pytest_sessionstart when a
#: disposable PostgreSQL is configured. None otherwise.
_SESSION_RLM = {"handle": None, "tmpdir": None}


def pytest_sessionstart(session):
    """Start one fixture RLM for the session when CI gave us a database.

    Three test modules gate themselves at IMPORT time on an RLM answering
    ``/health`` (``test_65_retrieval_e2e``, ``test_69_ast_parity_e2e``,
    ``test_27_mrr_validation``), which is before any pytest fixture can run.
    Starting the service in ``pytest_sessionstart`` — the one hook that runs
    before collection — is what lets those modules be collected and RUN instead
    of reporting "collection skipped".

    It starts only when ``GSD_TEST_POSTGRES_URL`` is set, i.e. in CI: the RLM's
    search path needs a database, and on the operator's machine there is none
    and none may be started. ``GSD_RLM_AUTOSTART=0`` opts out.

    Args:
        session: the pytest session (unused).

    Returns:
        None. A failure to start is reported on stderr and left to the modules'
        own readiness gates; it never aborts collection.
    """
    import tempfile

    if os.environ.get("GSD_RLM_AUTOSTART", "").strip() == "0":
        return
    dsn = (os.environ.get("GSD_TEST_POSTGRES_URL") or "").strip()
    if not dsn:
        return
    tmpdir = tempfile.mkdtemp(prefix="gsd-session-rlm-")
    try:
        handle = _start_rlm(tmpdir, dsn=dsn)
    except Exception as exc:  # the modules' readiness gates report the skip
        shutil.rmtree(tmpdir, ignore_errors=True)
        print("\nconftest: the session fixture RLM did not start: %s" % exc)
        return
    _SESSION_RLM["handle"] = handle
    _SESSION_RLM["tmpdir"] = tmpdir
    os.environ["GSD_RLM_PORT"] = str(handle.port)
    print("\nconftest: session fixture RLM on 127.0.0.1:%d" % handle.port)


@pytest.fixture
def fixture_rlm(tmp_path):
    """An RLM service for one test, on a port the fixture chose itself.

    Reuses the session-wide service when ``pytest_sessionstart`` started one,
    so a CI run pays for exactly one process; otherwise it starts its own and
    stops it by pid in the teardown.

    Yields:
        FixtureRlm: with ``.port``, ``.base_url``, ``.data_dir`` and ``.proc``.

    Raises:
        RuntimeError: when the service does not answer ``/health`` in 60 s.

    Example:
        def test_health(fixture_rlm):
            with urllib.request.urlopen(fixture_rlm.base_url + "/health") as r:
                assert r.status == 200
    """
    if _SESSION_RLM["handle"] is not None:
        yield _SESSION_RLM["handle"]
        return
    data_dir = tmp_path / "fixture-rlm"
    data_dir.mkdir()
    handle = _start_rlm(data_dir, dsn=postgres_dsn_or_none())
    try:
        yield handle
    finally:
        _stop_rlm(handle)


def pytest_sessionfinish(session, exitstatus):
    """Print what the hermetic guard refused during this session.

    In log-only mode (``GSD_HERMETIC_GUARD_MODE=log``) this IS the
    network-reach inventory plan 88-16-03 builds its per-test host allowances
    from; in enforcing mode it is the diagnosis for a test that died on a
    refusal. Printing beats an artifact: it lands in the job log, which is
    where a reader of a red cell already is.

    Args:
        session: the pytest session (unused).
        exitstatus: the session's exit status (unused).

    Returns:
        None.
    """
    if _SESSION_RLM["handle"] is not None:
        _stop_rlm(_SESSION_RLM["handle"])
        shutil.rmtree(_SESSION_RLM["tmpdir"], ignore_errors=True)
        _SESSION_RLM["handle"] = None

    path = os.environ.get("GSD_HERMETIC_GUARD_LOG")
    if not path or not os.path.exists(path):
        print("\nhermetic guard: no refusals")
        return
    try:
        with open(path, encoding="utf-8") as fh:
            body = fh.read().strip()
    except OSError as exc:
        print("\nhermetic guard: could not read %s (%s)" % (path, exc))
        return
    if not body:
        print("\nhermetic guard: no refusals")
        return
    print("\n--- hermetic guard refusals (time pid mode runtime host port reason argv) ---")
    print(body)
    print("--- end hermetic guard refusals (%d line(s)) ---" % len(body.splitlines()))


def have_tool(name):
    """True when an executable called ``name`` is on PATH.

    Use it to skip, by name, a test that needs a tool CI cannot have.

    Args:
        name: executable name, for example ``"claude"`` or ``"gitleaks"``.

    Returns:
        bool: whether ``shutil.which(name)`` finds it.

    Example:
        @pytest.mark.skipif(not have_tool("claude"), reason="the claude CLI is not available in this environment")
    """
    return shutil.which(name) is not None
