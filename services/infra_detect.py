#!/usr/bin/env python3
"""
Infrastructure Detection for GSD-Amauta.

Detects available database backends in priority order:
1. Explicit DSN from services/pg_dsn.py (GSD_POSTGRES_URL / DATABASE_URL / ...)
2. Local PostgreSQL that PASSES the capability pre-check
3. Docker PostgreSQL (gsd-amauta container)
4. SQLite fallback (zero-config, always works)

Three behaviours changed here, all of them previously silent failures:

* **Capability pre-check.** Priority 2 used to accept the first PostgreSQL
  answering on 5432-5434 with any of three usernames, and CREATE DATABASE
  gsd_amauta on it if needed. A Homebrew ``postgresql@14`` with pgvector 0.1.x
  therefore outranked the Docker container, and migration 002 (HNSW) and 011
  (pgvector >= 0.8.0 assertion + ``CREATE EXTENSION pg_search``) then failed on
  it. A candidate server is now checked for server version, pgvector version
  and pg_search availability BEFORE it is accepted, and every rejection is
  recorded in ``result['rejected']`` with the reason.

* **Per-service start results.** ``docker compose up -d`` on the whole stack
  exited non-zero whenever the Valkey container could not bind 6379 (a
  Homebrew redis-server already had it), and the entire detection collapsed to
  "nothing started" -> SQLite fallback, even though Postgres was up. Only the
  ``postgres`` service is started now, and ``result['services']`` reports each
  service separately.

* **Redis reuse.** An already-running Redis/Valkey on the configured port is
  reused instead of treated as a conflict.
"""

import json
import os
import socket
import subprocess
import time

try:
    from services.pg_dsn import (
        dsn_parts, dsn_with_database, local_docker_dsn, mask_dsn, pg_port, redis_port, resolve_dsn,
    )
except ImportError:  # pragma: no cover - script-launched from services/
    from pg_dsn import (
        dsn_parts, dsn_with_database, local_docker_dsn, mask_dsn, pg_port, redis_port, resolve_dsn,
    )

# ── Capability floor ────────────────────────────────────────────────────────
# Derived from the migrations, not guessed:
#   002-embedding-index.sql  -> HNSW index        (pgvector >= 0.5.0)
#   011-paradedb-setup.sql   -> DO block RAISEs   (pgvector >= 0.8.0)
#   011-paradedb-setup.sql   -> CREATE EXTENSION pg_search
#   001-init.sql             -> gen_random_uuid() built in (PostgreSQL >= 13)
MIN_SERVER_MAJOR = 13
MIN_PGVECTOR = (0, 8, 0)
REQUIRED_EXTENSIONS = ("vector", "pg_search")

#: Ports scanned for a pre-existing local PostgreSQL.
LOCAL_PG_PORTS = (5432, 5433, 5434)

DOCKER_PG_CONTAINER = "gsd-postgres"
DOCKER_REDIS_CONTAINER = "gsd-redis"


#: Truthy spellings accepted for GSD_FORCE_SQLITE (matches amauta-daemon.py).
_TRUTHY = ("1", "true", "yes", "on")


def force_sqlite(env=None):
    """True when the operator pinned the backend to SQLite.

    ``GSD_FORCE_SQLITE=1`` or ``GSD_BACKEND=sqlite``. services/amauta-daemon.py
    already honours this; infra_detect has to honour it too, because it is the
    component that probes ports 5432-5434 and auto-STARTS a Docker PostgreSQL
    container. A test that imports this module, or `bin/init.cjs` on a machine
    that deliberately runs degraded, must not do either.
    """
    env = os.environ if env is None else env
    if (env.get("GSD_FORCE_SQLITE", "") or "").strip().lower() in _TRUTHY:
        return True
    return (env.get("GSD_BACKEND", "") or "").strip().lower() == "sqlite"


def _version_tuple(text):
    """'0.8.2' -> (0, 8, 2). Non-numeric trailers are dropped."""
    parts = []
    for chunk in str(text or "").split("."):
        digits = ""
        for ch in chunk:
            if ch.isdigit():
                digits += ch
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def check_pg_capabilities(url, min_pgvector=MIN_PGVECTOR,
                          required_extensions=REQUIRED_EXTENSIONS,
                          min_server_major=MIN_SERVER_MAJOR):
    """Decide whether a reachable PostgreSQL can actually run our migrations.

    Returns ``(ok, report)``. ``report`` always carries a human-readable
    ``reason`` when ``ok`` is False, plus whatever was discovered.
    """
    report = {
        "url": mask_dsn(url),
        "reachable": False,
        "server_major": None,
        "pgvector_version": None,
        "extensions_available": [],
        "extensions_missing": [],
        "reason": None,
    }
    try:
        import psycopg2
    except ImportError:
        report["reason"] = "psycopg2 not installed"
        return False, report

    conn = None
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        report["reachable"] = True
        with conn.cursor() as cur:
            cur.execute("SHOW server_version_num")
            report["server_major"] = int(cur.fetchone()[0]) // 10000

            # pg_available_extensions covers both installed and installable.
            cur.execute(
                "SELECT name, COALESCE(installed_version, default_version) "
                "FROM pg_available_extensions WHERE name = ANY(%s)",
                (list(required_extensions),),
            )
            found = {row[0]: row[1] for row in cur.fetchall()}
        report["extensions_available"] = sorted(found)
        report["extensions_missing"] = sorted(
            set(required_extensions) - set(found)
        )
        if "vector" in found:
            report["pgvector_version"] = found["vector"]
    except Exception as exc:  # noqa: BLE001 - any failure means "not usable"
        report["reason"] = f"connection/inspection failed: {exc}"
        return False, report
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    if report["server_major"] is not None and report["server_major"] < min_server_major:
        report["reason"] = (
            f"PostgreSQL {report['server_major']} < required {min_server_major} "
            f"(001-init.sql needs built-in gen_random_uuid())"
        )
        return False, report

    if report["extensions_missing"]:
        report["reason"] = (
            "missing extension(s): " + ", ".join(report["extensions_missing"])
            + " (011-paradedb-setup.sql installs pg_search; 002 needs pgvector)"
        )
        return False, report

    have = _version_tuple(report["pgvector_version"])
    if have < tuple(min_pgvector):
        report["reason"] = (
            f"pgvector {report['pgvector_version']} < required "
            f"{'.'.join(str(n) for n in min_pgvector)} "
            f"(011-paradedb-setup.sql raises below that)"
        )
        return False, report

    return True, report


def detect_infrastructure(auto_start=True):
    """Returns dict with detected infrastructure and connection details.

    Args:
        auto_start: If True (default), attempt to auto-start the Docker
                    Postgres service when no usable PG is found. Set False to
                    detect without side effects.

    Returns:
        dict with keys: backend, connection_url, features, message,
        redis_available, redis_url, services, rejected.

        ``services`` maps each stack service to a per-service outcome, so a
        partial start is reported as a partial start:
            {"postgres": {"status": "running"|"started"|"failed"|"skipped",
                          "detail": "..."},
             "redis":    {"status": "reused"|"running"|"absent"|..., ...}}
        ``rejected`` lists candidate servers that failed the capability
        pre-check, each with the reason.
    """
    result = {
        "backend": None,
        "connection_url": None,
        "features": [],
        "message": "",
        "services": {},
        "rejected": [],
    }

    def finish(backend, url, features, message):
        result["backend"] = backend
        result["connection_url"] = url
        result["features"] = features
        result["message"] = message
        redis_status = _detect_redis()
        result["redis_available"] = redis_status["available"]
        result["redis_url"] = redis_status["url"]
        result["services"]["redis"] = redis_status["service"]
        result["services"].setdefault(
            "postgres",
            {"status": "running" if backend == "postgresql" else "absent",
             "detail": mask_dsn(url) if backend == "postgresql" else "not used"},
        )
        return result

    pg_features = ["memory", "tasks", "skb", "validation", "embeddings", "fts"]

    # Priority 0: the operator selected SQLite. Same flag the daemon reads
    # (GSD_FORCE_SQLITE / GSD_BACKEND=sqlite). Detection is skipped ENTIRELY:
    # no port probes, no `docker ps`, and above all no container auto-start.
    # A test run that merely imports this module must never be able to bring
    # up the real gsd-postgres container.
    if force_sqlite():
        sqlite_path = _get_sqlite_path()
        result["services"]["postgres"] = {
            "status": "skipped",
            "detail": "SQLite selected by GSD_FORCE_SQLITE/GSD_BACKEND",
        }
        return finish(
            "sqlite",
            f"sqlite:///{sqlite_path}",
            ["memory", "tasks", "skb", "validation", "fts"],
            "SQLite forced by GSD_FORCE_SQLITE",
        )

    # Priority 1: explicit DSN (GSD_POSTGRES_URL / DATABASE_URL / ...).
    # An explicitly configured server is the operator's decision: it is used if
    # it connects, but the capability report is attached so a later migration
    # failure is not a surprise.
    explicit_url = _explicit_dsn()
    if explicit_url:
        ok, report = check_pg_capabilities(explicit_url)
        if report["reachable"]:
            if not ok:
                result["rejected"].append(
                    {**report, "accepted_anyway": True,
                     "note": "explicitly configured — honoured despite the warning"}
                )
            result["services"]["postgres"] = {
                "status": "running",
                "detail": f"explicit DSN ({mask_dsn(explicit_url)})",
                "capabilities": report,
            }
            return finish("postgresql", explicit_url, pg_features,
                          f"Using configured PostgreSQL: {mask_dsn(explicit_url)}")
        result["rejected"].append(report)

    # Priority 2: a local PostgreSQL that passes the capability pre-check.
    local_pg, local_report = _detect_local_postgresql(result["rejected"])
    if local_pg:
        result["services"]["postgres"] = {
            "status": "running",
            "detail": f"local server ({mask_dsn(local_pg)})",
            "capabilities": local_report,
        }
        return finish("postgresql", local_pg, pg_features,
                      f"Using local PostgreSQL: {mask_dsn(local_pg)}")

    # Priority 3: the Docker container, already running.
    docker_pg = _detect_docker_postgresql(result["rejected"])
    if docker_pg:
        result["services"]["postgres"] = {
            "status": "running",
            "detail": f"docker container {DOCKER_PG_CONTAINER}",
        }
        return finish("postgresql", docker_pg, pg_features,
                      f"Using Docker PostgreSQL: {mask_dsn(docker_pg)}")

    # Priority 3b: start the Docker Postgres service (postgres ONLY).
    if auto_start:
        auto_pg, start_report = _auto_start_docker_postgresql()
        result["services"]["postgres"] = start_report
        if auto_pg:
            return finish("postgresql", auto_pg, pg_features,
                          f"Auto-started Docker PostgreSQL: {mask_dsn(auto_pg)}")
    else:
        result["services"]["postgres"] = {
            "status": "skipped", "detail": "auto_start disabled"
        }

    # Priority 4: SQLite fallback.
    sqlite_path = _get_sqlite_path()
    return finish(
        "sqlite",
        f"sqlite:///{sqlite_path}",
        ["memory", "tasks", "skb", "validation", "fts"],
        f"Using SQLite fallback: {sqlite_path}",
    )


def _explicit_dsn():
    """The DSN an environment variable configures, or None when none does."""
    return resolve_dsn()


def _local_dsn():
    """DSN to probe for a local PostgreSQL.

    Detection is the one place where reaching this project's own Docker
    PostgreSQL without an exported DSN is the stated intent; see
    pg_dsn.local_docker_dsn(). An explicitly configured DSN still wins.
    """
    return resolve_dsn() or local_docker_dsn()


def _detect_local_postgresql(rejected):
    """Find a local PostgreSQL that can actually run our migrations.

    Every candidate that answers but fails the capability pre-check is appended
    to *rejected* with the reason, so `infra_detect.py --json` explains why a
    perfectly healthy Homebrew postgresql@14 was passed over.
    """
    configured_port = pg_port()
    ports = []
    for port in (configured_port, *LOCAL_PG_PORTS):
        port = int(port)
        if port not in ports:
            ports.append(port)

    default_parts = dsn_parts(_local_dsn())
    users = []
    for user in (default_parts["user"], os.environ.get("USER"), "postgres", "gsd"):
        if user and user not in users:
            users.append(user)
    password = default_parts["password"]
    db = default_parts["database"]

    for port in ports:
        if not _port_open("127.0.0.1", port):
            continue
        for user in users:
            auth = user if not password else f"{user}:{password}"
            url = f"postgresql://{auth}@127.0.0.1:{port}/{db}"
            ok, report = check_pg_capabilities(url)
            if ok:
                return url, report
            if report["reachable"]:
                rejected.append(report)
                # The server answered and is not good enough — do NOT try to
                # CREATE DATABASE on it, and do not try other usernames on the
                # same port: the capability verdict is per-server, not per-user.
                break

            # Could not open `db` — maybe it just does not exist yet. Check the
            # server's capabilities through the `postgres` database first and
            # only create the database on a server that passes.
            base_url = dsn_with_database(url, "postgres")
            base_ok, base_report = check_pg_capabilities(base_url)
            if not base_ok:
                if base_report["reachable"]:
                    rejected.append(base_report)
                    break
                continue
            _create_database(base_url, db)
            ok, report = check_pg_capabilities(url)
            if ok:
                return url, report
            if report["reachable"]:
                rejected.append(report)
                break
    return None, None


def _detect_docker_postgresql(rejected=None):
    """Check if the Docker GSD PostgreSQL container is running and usable."""
    port = pg_port()
    try:
        proc = subprocess.run(
            ["docker", "ps", "--filter", f"name={DOCKER_PG_CONTAINER}",
             "--format", "{{.Ports}}"],
            capture_output=True, text=True, timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if f":{port}->" not in proc.stdout and port not in proc.stdout:
        return None
    url = _local_dsn()
    ok, report = check_pg_capabilities(url)
    if ok:
        return url
    if rejected is not None and report["reachable"]:
        rejected.append(report)
    return None


def _compose_file():
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "docker", "docker-compose.yml",
    )
    return path if os.path.isfile(path) else None


def _auto_start_docker_postgresql():
    """Start ONLY the `postgres` compose service.

    Returns ``(url_or_None, service_report)``. The old version ran
    ``docker compose up -d`` for the whole stack; when Valkey could not bind
    the Redis port the command exited non-zero and the caller concluded that
    nothing had started — then fell back to SQLite with a healthy Postgres
    running. Starting one service means one service's exit code.
    """
    report = {"status": "failed", "detail": ""}
    try:
        proc = subprocess.run(["docker", "info"], capture_output=True,
                              text=True, timeout=10)
        if proc.returncode != 0:
            report["detail"] = "docker daemon not available"
            return None, report
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        report["detail"] = f"docker not usable: {exc}"
        return None, report

    started = False
    try:
        proc = subprocess.run(
            ["docker", "ps", "-a", "--filter", f"name={DOCKER_PG_CONTAINER}",
             "--format", "{{.Status}}"],
            capture_output=True, text=True, timeout=5,
        )
        if proc.stdout.strip():
            start = subprocess.run(
                ["docker", "start", DOCKER_PG_CONTAINER],
                capture_output=True, text=True, timeout=60,
            )
            started = start.returncode == 0
            report["detail"] = (
                f"docker start {DOCKER_PG_CONTAINER}"
                if started else
                f"docker start {DOCKER_PG_CONTAINER} failed: "
                f"{(start.stderr or '').strip()[:300]}"
            )
        else:
            compose_file = _compose_file()
            if compose_file is None:
                report["detail"] = "docker/docker-compose.yml not found"
                return None, report
            last_error = "no compose command found"
            for cmd in (
                ["docker", "compose", "-f", compose_file, "up", "-d", "postgres"],
                ["docker-compose", "-f", compose_file, "up", "-d", "postgres"],
            ):
                try:
                    run = subprocess.run(cmd, capture_output=True, text=True,
                                         timeout=180)
                except FileNotFoundError:
                    continue
                if run.returncode == 0:
                    started = True
                    report["detail"] = " ".join(cmd[:2]) + " up -d postgres"
                    break
                last_error = (run.stderr or run.stdout or "").strip()[:300]
            if not started:
                report["detail"] = f"compose up postgres failed: {last_error}"
    except (subprocess.TimeoutExpired, OSError) as exc:
        report["detail"] = f"start failed: {exc}"
        return None, report

    if not started:
        return None, report

    url = _local_dsn()
    deadline = time.time() + 60
    last_reason = "timed out waiting for readiness"
    while time.time() < deadline:
        time.sleep(1)
        ok, capability = check_pg_capabilities(url)
        if ok:
            report["status"] = "started"
            report["capabilities"] = capability
            return url, report
        if capability["reachable"]:
            last_reason = capability["reason"] or "capability check failed"
            break
    report["status"] = "failed"
    report["detail"] = f"{report['detail']}; {last_reason}"
    return None, report


def _port_open(host, port):
    """Check if a TCP port is open."""
    try:
        with socket.create_connection((host, int(port)), timeout=2):
            return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def _test_pg_connection(url):
    """Test if a PostgreSQL connection works (kept for callers/tests)."""
    try:
        import psycopg2

        conn = psycopg2.connect(url, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


def _check_pgvector(url):
    """Check if pgvector extension is available."""
    _ok, report = check_pg_capabilities(url, required_extensions=("vector",),
                                        min_pgvector=(0, 0, 0))
    return "vector" in report["extensions_available"]


def _create_database(base_url, db_name):
    """Create a database if it doesn't exist."""
    try:
        import psycopg2
        from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

        conn = psycopg2.connect(base_url, connect_timeout=3)
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
        if not cur.fetchone():
            cur.execute(f'CREATE DATABASE "{db_name}"')
        conn.close()
    except Exception:
        pass


def _get_sqlite_path():
    """Get the SQLite database file path."""
    data_dir = os.environ.get(
        "GSD_DATA_DIR", os.path.expanduser("~/.amauta/data")
    )
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "gsd_amauta.db")


def _mask_url(url):
    """Mask password in URL for display (kept for existing callers)."""
    return mask_dsn(url)


def _redis_url():
    configured = (os.environ.get("GSD_REDIS_URL") or "").strip()
    if configured:
        return configured
    return f"redis://127.0.0.1:{redis_port()}/0"


def _detect_redis():
    """Reuse whatever Redis/Valkey is already listening on the configured port.

    The Valkey container is optional (compose profile ``cache``). A Homebrew
    ``redis-server`` on the same port is a perfectly good cache, so it is
    reused rather than treated as a port conflict that fails the stack.
    """
    url = _redis_url()
    status = {"available": False, "url": url,
              "service": {"status": "absent", "detail": "no server on the port"}}
    port = redis_port()
    if not _port_open("127.0.0.1", port):
        status["service"]["detail"] = f"nothing listening on 127.0.0.1:{port}"
        return status
    try:
        import redis as _redis_mod
        client = _redis_mod.from_url(url, socket_timeout=2,
                                     socket_connect_timeout=2)
        client.ping()
        try:
            server = client.info("server")
        except Exception:
            server = {}
        client.close()
        status["available"] = True
        flavour = "valkey" if server.get("valkey_version") else "redis"
        version = server.get("valkey_version") or server.get("redis_version", "?")
        in_container = _container_running(DOCKER_REDIS_CONTAINER)
        status["service"] = {
            "status": "running" if in_container else "reused",
            "detail": f"{flavour} {version} on 127.0.0.1:{port}"
                      + ("" if in_container
                         else " (pre-existing server — gsd-redis container not needed)"),
        }
    except ImportError:
        status["service"] = {
            "status": "unknown",
            "detail": f"port 127.0.0.1:{port} is open but the `redis` "
                      f"python package is not installed",
        }
    except Exception as exc:  # noqa: BLE001
        status["service"] = {
            "status": "failed",
            "detail": f"port open but PING failed: {exc}",
        }
    return status


def _container_running(name):
    try:
        proc = subprocess.run(
            ["docker", "ps", "--filter", f"name={name}", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=5,
        )
        return name in proc.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


if __name__ == "__main__":
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    import sys as _sys

    # --auto-start / --no-auto-start flags control Docker auto-start behavior
    # Default: auto_start=True (the init flow wants auto-start by default)
    auto_start = "--no-auto-start" not in _sys.argv
    if "--auto-start" in _sys.argv:
        auto_start = True

    print(json.dumps(detect_infrastructure(auto_start=auto_start),
                     indent=2, default=str))
