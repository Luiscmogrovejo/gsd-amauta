#!/usr/bin/env python3
"""
Infrastructure Detection for GSD-Amauta
Detects available database backends in priority order:
1. Explicit GSD_POSTGRES_URL env var (always wins)
2. Local PostgreSQL (Homebrew, system PG, etc.)
3. Docker PostgreSQL (gsd-amauta container)
4. SQLite fallback (zero-config, always works)
"""

import os
import re
import socket
import subprocess
import time


def detect_infrastructure(auto_start=True):
    """Returns dict with detected infrastructure and connection details.

    Priority order:
        1. GSD_POSTGRES_URL env var (explicit config always wins)
        2. Local PostgreSQL on ports 5432-5434
        3. Docker GSD PostgreSQL container (port 5433)
        3b. Auto-start Docker PostgreSQL if Docker available (when auto_start=True)
        4. SQLite fallback (~/.amauta/data/gsd_amauta.db)

    Args:
        auto_start: If True (default), attempt to auto-start Docker PG when
                    no running PG is found. Set False to detect without side effects.

    Returns:
        dict with keys: backend, connection_url, features, message
    """
    result = {
        "backend": None,
        "connection_url": None,
        "features": [],
        "message": "",
    }

    # Priority 1: Check for GSD_POSTGRES_URL env var (explicit config always wins)
    explicit_url = os.environ.get("GSD_POSTGRES_URL")
    if explicit_url:
        if _test_pg_connection(explicit_url):
            result["backend"] = "postgresql"
            result["connection_url"] = explicit_url
            result["features"] = ["memory", "tasks", "skb", "validation", "embeddings", "fts"]
            result["message"] = f"Using configured PostgreSQL: {_mask_url(explicit_url)}"
            return result

    # Priority 2: Check for local PostgreSQL (Homebrew, system, etc.)
    local_pg = _detect_local_postgresql()
    if local_pg:
        result["backend"] = "postgresql"
        result["connection_url"] = local_pg
        result["features"] = ["memory", "tasks", "skb", "validation", "fts"]
        # Check for pgvector
        if _check_pgvector(local_pg):
            result["features"].append("embeddings")
        result["message"] = f"Using local PostgreSQL: {_mask_url(local_pg)}"
        return result

    # Priority 3: Check for Docker PostgreSQL (already running)
    docker_pg = _detect_docker_postgresql()
    if docker_pg:
        result["backend"] = "postgresql"
        result["connection_url"] = docker_pg
        result["features"] = ["memory", "tasks", "skb", "validation", "embeddings", "fts"]
        result["message"] = f"Using Docker PostgreSQL: {_mask_url(docker_pg)}"
        return result

    # Priority 3b: Try auto-starting Docker PostgreSQL
    if auto_start:
        auto_pg = _auto_start_docker_postgresql()
        if auto_pg:
            result["backend"] = "postgresql"
            result["connection_url"] = auto_pg
            result["features"] = ["memory", "tasks", "skb", "validation", "embeddings", "fts"]
            result["message"] = f"Auto-started Docker PostgreSQL: {_mask_url(auto_pg)}"
            return result

    # Priority 4: SQLite fallback
    sqlite_path = _get_sqlite_path()
    result["backend"] = "sqlite"
    result["connection_url"] = f"sqlite:///{sqlite_path}"
    result["features"] = ["memory", "tasks", "skb", "validation", "fts"]
    result["message"] = f"Using SQLite fallback: {sqlite_path}"
    return result


def _detect_local_postgresql():
    """Check if a local PostgreSQL is running and accessible."""
    # Common local PG ports
    for port in [5432, 5433, 5434]:
        if _port_open("127.0.0.1", port):
            # Try connecting with common local credentials
            for user in [os.environ.get("USER", "postgres"), "postgres", "gsd"]:
                url = f"postgresql://{user}@localhost:{port}/gsd_amauta"
                if _test_pg_connection(url):
                    return url
                # Try connecting to postgres db and creating gsd_amauta
                base_url = f"postgresql://{user}@localhost:{port}/postgres"
                if _test_pg_connection(base_url):
                    _create_database(base_url, "gsd_amauta")
                    if _test_pg_connection(url):
                        return url
    return None


def _detect_docker_postgresql():
    """Check if Docker GSD PostgreSQL container is running."""
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", "name=gsd", "--format", "{{.Ports}}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if "5433" in result.stdout:
            url = "postgresql://gsd:gsd@localhost:5433/gsd_amauta"
            if _test_pg_connection(url):
                return url
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def _auto_start_docker_postgresql():
    """Attempt to start Docker PG container if Docker is available.

    Tries to:
    1. Start an existing stopped gsd-postgres container
    2. Use docker compose to create and start a new container
    Falls back to docker-compose (v1) if docker compose (v2) is not available.

    Returns:
        Connection URL string if successful, None otherwise.
    """
    try:
        # Check if docker command exists and daemon is running
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return None  # Docker not available or not running

        # Check if container exists (running or stopped)
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=gsd-postgres",
             "--format", "{{.Status}}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.stdout.strip():
            # Container exists -- try to start it
            subprocess.run(
                ["docker", "start", "gsd-postgres"],
                capture_output=True, text=True, timeout=30,
            )
        else:
            # Container doesn't exist -- use docker compose
            compose_file = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..", "docker", "docker-compose.yml"
            )
            if not os.path.isfile(compose_file):
                return None  # No compose file available

            # Try docker compose v2 first, fall back to docker-compose v1
            started = False
            for cmd in [
                ["docker", "compose", "-f", compose_file, "up", "-d"],
                ["docker-compose", "-f", compose_file, "up", "-d"],
            ]:
                try:
                    r = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=60,
                    )
                    if r.returncode == 0:
                        started = True
                        break
                except FileNotFoundError:
                    continue  # Command not found, try next
            if not started:
                return None

        # Wait for PG to become ready (up to 15s)
        url = "postgresql://gsd:gsd@localhost:5433/gsd_amauta"
        for _ in range(15):
            time.sleep(1)
            if _test_pg_connection(url):
                return url
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def _port_open(host, port):
    """Check if a TCP port is open."""
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def _test_pg_connection(url):
    """Test if a PostgreSQL connection works."""
    try:
        import psycopg2

        conn = psycopg2.connect(url, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


def _check_pgvector(url):
    """Check if pgvector extension is available."""
    try:
        import psycopg2

        conn = psycopg2.connect(url, connect_timeout=3)
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
        result = cur.fetchone()
        conn.close()
        return result is not None
    except Exception:
        return False


def _create_database(base_url, db_name):
    """Create a database if it doesn't exist."""
    try:
        import psycopg2
        from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

        conn = psycopg2.connect(base_url, connect_timeout=3)
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (db_name,)
        )
        if not cur.fetchone():
            # Use identifier quoting for safety (db_name is controlled, but be safe)
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
    """Mask password in URL for display."""
    return re.sub(r"://([^:]+):([^@]+)@", r"://\1:***@", url)


if __name__ == "__main__":
    import json as _json
    import sys as _sys

    # --auto-start / --no-auto-start flags control Docker auto-start behavior
    # Default: auto_start=True (the init flow wants auto-start by default)
    auto_start = "--no-auto-start" not in _sys.argv
    if "--auto-start" in _sys.argv:
        auto_start = True

    result = detect_infrastructure(auto_start=auto_start)
    print(_json.dumps(result, indent=2))
