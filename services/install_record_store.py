#!/usr/bin/env python3
"""
services/install_record_store.py — Phase 49 MOD-03/MOD-04

CRUD store for module_installs rows. Auto-selects backend via
infra_detect.detect_infrastructure(auto_start=False): PG when available,
else JSON file at ~/.amauta/data/module_installs.json (Phase 44 cascade).

SQLite fallback path (FROZEN):
    ~/.amauta/data/module_installs.json

Row schema mirror (9 columns from migration 022):
    module_name, version, manifest_hash, installed_at, upgraded_at,
    applied_migrations, registered_services, installed_agents, installed_skills

Environment overrides:
    GSD_INSTALL_RECORD_BACKEND=sqlite   forces JSON file (used by tests)
    GSD_POSTGRES_URL                    explicit PG connection URL

Error policy: PG errors bubble up as psycopg2.Error; JSON file errors
bubble up as OSError / ValueError. The store does NOT catch-and-format —
that is lifecycle's responsibility.

NO dependency on services/module_lifecycle.py (store is consumed by lifecycle,
not the reverse).
"""

import json
import os
import pathlib
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ─── Import-safety: psycopg2 ─────────────────────────────────────────────────

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    _HAS_PG = True
except ImportError:
    _HAS_PG = False
    psycopg2 = None  # type: ignore[assignment]
    RealDictCursor = None  # type: ignore[assignment]

# ─── Constants ────────────────────────────────────────────────────────────────

SQLITE_FALLBACK_PATH = os.path.expanduser("~/.amauta/data/module_installs.json")

# Exact 9-column names + order from migration 022-module-installs.sql
ROW_COLUMNS = (
    "module_name",
    "version",
    "manifest_hash",
    "installed_at",
    "upgraded_at",
    "applied_migrations",
    "registered_services",
    "installed_agents",
    "installed_skills",
)

# Required columns (missing these → ValueError from put_install_record)
_REQUIRED_COLUMNS = {"module_name", "version", "manifest_hash"}

# Tuple of supported backend labels (grep-visible constant)
BACKEND_LABEL = ("postgresql", "sqlite")

# ─── Backend detection ────────────────────────────────────────────────────────


def _detect_backend() -> str:
    """
    Return "postgresql" or "sqlite" based on available infrastructure.

    Priority:
    1. GSD_INSTALL_RECORD_BACKEND env var (test isolation + operator override)
    2. infra_detect.detect_infrastructure(auto_start=False) result
    3. Fallback to "sqlite" if detect import fails or returns non-PG
    """
    # Environment override wins unconditionally
    env_override = os.environ.get("GSD_INSTALL_RECORD_BACKEND", "").strip().lower()
    if env_override == "sqlite":
        return "sqlite"
    if env_override == "postgresql":
        if _HAS_PG:
            return "postgresql"
        # Explicitly requested PG but not available — degrade
        return "sqlite"

    # Dynamic detection via infra_detect
    if _HAS_PG:
        try:
            from services.infra_detect import detect_infrastructure
            infra = detect_infrastructure(auto_start=False)
            if infra.get("backend") == "postgresql":
                return "postgresql"
        except Exception:
            pass

    return "sqlite"


# ─── PG connection helper ─────────────────────────────────────────────────────


def _pg_conn():
    """
    Open a direct psycopg2 connection.

    Uses GSD_POSTGRES_URL env var, then falls back to infra_detect URL.
    Raises psycopg2.OperationalError on connection failure.
    """
    if not _HAS_PG:
        raise RuntimeError("psycopg2 not installed; cannot open PG connection")

    url = os.environ.get("GSD_POSTGRES_URL")
    if not url:
        try:
            from services.infra_detect import detect_infrastructure
            infra = detect_infrastructure(auto_start=False)
            url = infra.get("connection_url")
        except Exception:
            url = None

    if not url:
        raise psycopg2.OperationalError("No PostgreSQL connection URL available")

    return psycopg2.connect(url, connect_timeout=10)


# ─── JSON file helpers ────────────────────────────────────────────────────────


def _json_file_path() -> str:
    """Return the active JSON fallback file path (may be overridden by tests)."""
    return SQLITE_FALLBACK_PATH


def _read_json_file() -> Dict[str, dict]:
    """
    Load the JSON install-records file.

    Ensures the parent directory exists. Returns {} if the file does not
    exist. Raises ValueError on malformed JSON.
    """
    path = _json_file_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json_file(records: Dict[str, dict]) -> None:
    """
    Atomically write records to the JSON install-records file.

    Uses write-to-tempfile + os.replace for atomicity (matches Phase 44
    PG-down fallback patterns).
    """
    path = _json_file_path()
    dir_path = os.path.dirname(os.path.abspath(path))
    os.makedirs(dir_path, exist_ok=True)

    # Write to a temp file in the same directory for atomic replace
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2, default=_json_default)
        os.replace(tmp_path, path)
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _json_default(obj: Any) -> Any:
    """JSON serializer for datetime objects."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _serialize_datetime(value: Any) -> Optional[str]:
    """Convert a datetime value to ISO8601 string (uniform PG + JSON output)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    # Already a string (from JSON file or explicit ISO8601 input)
    return str(value)


# ─── Public API ───────────────────────────────────────────────────────────────


def get_install_record(module_name: str) -> Optional[Dict[str, Any]]:
    """
    Return the install record for module_name, or None if not found.

    Backend: postgresql or sqlite (JSON file) per _detect_backend().
    Datetime fields are serialized to ISO8601 strings on the way out
    (uniform across PG and JSON paths).
    """
    backend = _detect_backend()

    if backend == "postgresql":
        conn = _pg_conn()
        try:
            with conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(
                        """
                        SELECT module_name, version, manifest_hash,
                               installed_at, upgraded_at,
                               applied_migrations, registered_services,
                               installed_agents, installed_skills
                        FROM module_installs
                        WHERE module_name = %s
                        """,
                        (module_name,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        return None
                    record = dict(row)
                    # Normalize datetime fields
                    record["installed_at"] = _serialize_datetime(record["installed_at"])
                    record["upgraded_at"] = _serialize_datetime(record["upgraded_at"])
                    return record
        finally:
            conn.close()

    # SQLite (JSON file) path
    records = _read_json_file()
    return records.get(module_name)


def put_install_record(record: Dict[str, Any]) -> None:
    """
    Upsert an install record (insert or update on module_name conflict).

    Required keys: module_name, version, manifest_hash.
    Optional: upgraded_at (may be None), applied_migrations /
    registered_services / installed_agents / installed_skills (may be []).

    Raises ValueError if required keys are missing.
    """
    # Validate required keys
    missing = _REQUIRED_COLUMNS - set(record.keys())
    if missing:
        raise ValueError(f"put_install_record: missing required keys: {sorted(missing)}")

    backend = _detect_backend()
    module_name = record["module_name"]

    if backend == "postgresql":
        conn = _pg_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO module_installs (
                            module_name, version, manifest_hash,
                            installed_at, upgraded_at,
                            applied_migrations, registered_services,
                            installed_agents, installed_skills
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (module_name) DO UPDATE SET
                            version = EXCLUDED.version,
                            manifest_hash = EXCLUDED.manifest_hash,
                            installed_at = EXCLUDED.installed_at,
                            upgraded_at = EXCLUDED.upgraded_at,
                            applied_migrations = EXCLUDED.applied_migrations,
                            registered_services = EXCLUDED.registered_services,
                            installed_agents = EXCLUDED.installed_agents,
                            installed_skills = EXCLUDED.installed_skills
                        """,
                        (
                            module_name,
                            record.get("version"),
                            record.get("manifest_hash"),
                            record.get("installed_at"),
                            record.get("upgraded_at"),
                            record.get("applied_migrations", []),
                            record.get("registered_services", []),
                            record.get("installed_agents", []),
                            record.get("installed_skills", []),
                        ),
                    )
        finally:
            conn.close()
        return

    # SQLite (JSON file) path
    records = _read_json_file()
    records[module_name] = record
    _write_json_file(records)


def delete_install_record(module_name: str) -> bool:
    """
    Delete the install record for module_name.

    Returns True if the row existed and was deleted, False if not present.
    """
    backend = _detect_backend()

    if backend == "postgresql":
        conn = _pg_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM module_installs WHERE module_name = %s RETURNING module_name",
                        (module_name,),
                    )
                    deleted = cur.fetchone()
                    return deleted is not None
        finally:
            conn.close()

    # SQLite (JSON file) path
    records = _read_json_file()
    existed = module_name in records
    if existed:
        records.pop(module_name)
        _write_json_file(records)
    return existed


def list_install_records() -> List[Dict[str, Any]]:
    """
    Return all install records ordered by installed_at descending.

    Backend: postgresql or sqlite per _detect_backend().
    """
    backend = _detect_backend()

    if backend == "postgresql":
        conn = _pg_conn()
        try:
            with conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(
                        """
                        SELECT module_name, version, manifest_hash,
                               installed_at, upgraded_at,
                               applied_migrations, registered_services,
                               installed_agents, installed_skills
                        FROM module_installs
                        ORDER BY installed_at DESC
                        """
                    )
                    rows = cur.fetchall()
                    result = []
                    for row in rows:
                        rec = dict(row)
                        rec["installed_at"] = _serialize_datetime(rec["installed_at"])
                        rec["upgraded_at"] = _serialize_datetime(rec["upgraded_at"])
                        result.append(rec)
                    return result
        finally:
            conn.close()

    # SQLite (JSON file) path
    records = _read_json_file()
    all_records = list(records.values())

    def _sort_key(r: Dict[str, Any]) -> str:
        """Sort key: installed_at ISO8601 string, descending (negate by reversing)."""
        val = r.get("installed_at", "")
        return str(val) if val is not None else ""

    all_records.sort(key=_sort_key, reverse=True)
    return all_records
