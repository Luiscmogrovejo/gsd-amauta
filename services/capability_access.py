#!/usr/bin/env python3
"""
services/capability_access.py — Phase 60 TOOL-02/TOOL-03: capability access layer.

Out-of-task capability accesses use task_id='SYSTEM' (sentinel) because
gsd_audit_log.task_id is NOT NULL (migrations/006-audit-log.sql:8) and
/api/audit/log rejects falsy task_id with 400.

Enforcement posture (GSD_CAPABILITY_ENFORCE=warn|block|off, default warn):
  - warn  (default): unlisted access is allowed but logged with a warning
    (capability_unlisted event) — advisory, per the HARDEN-01 bootstrap
    precedent (warn mode first, enforce once the hook layer lands in
    Phase 67).
  - block: unlisted access is refused with a structured error code.
  - off:   the Phase 67 HOOK-05-lineage kill switch — unlisted-access checks
    are skipped entirely, EXCEPT the destructive-class confirmation gate,
    which applies in ALL modes including off (60-CONTEXT locked: "regardless
    of enforcement mode").

Graceful degradation (fail-open): every capability access completes even
when the audit-log write fails. If the PG store is unavailable (or the
write raises), a JSONL record is appended locally to the buffer file named
by BUFFER_FILENAME below, for later replay via flush_buffer(). This is
genuinely new plumbing (NOT the tasks.json dual-write pattern, where PG
mirrors JSON) — here PG is primary and JSON is the fallback that catches
what PG drops.

Dual-runtime discipline: _data_dir() MUST resolve to the SAME directory as
DATA_DIR in get-shit-done/bin/gsd-amauta.cjs (AMAUTA_DATA_DIR override
first, else <repo_root>/data) or the Node-side daemon-down buffer and this
module's flush_buffer() split into two files that never meet — the
degraded-mode "every access is audit-logged" guarantee would silently
break.
"""

import fnmatch
import glob
import json
import os
import sys
from datetime import datetime, timezone

# ── sys.path: ensure repo root is importable from any cwd (a2a_registry.py /
#    agent_hydrate_cli.py precedent) ─────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.capability_schema import load_capability_catalog, validate_catalog
except Exception:
    from capability_schema import load_capability_catalog, validate_catalog  # type: ignore

try:
    from services.agent_schema import load_agent_definition  # type: ignore
    _HAS_AGENT_SCHEMA = True
except Exception:
    try:
        from agent_schema import load_agent_definition  # type: ignore
        _HAS_AGENT_SCHEMA = True
    except Exception:
        _HAS_AGENT_SCHEMA = False
        load_agent_definition = None  # type: ignore


# ─── Constants (exact values — LOCKED) ─────────────────────────────────────

SENTINEL_TASK_ID = "SYSTEM"                 # fits VARCHAR(20)
ENFORCE_ENV = "GSD_CAPABILITY_ENFORCE"      # warn | block | off
ENFORCE_DEFAULT = "warn"
EVENT_ACCESS = "capability_access"
EVENT_UNLISTED = "capability_unlisted"
BUFFER_FILENAME = "capability-audit-buffer.jsonl"

_ENFORCE_MODES = ("warn", "block", "off")


# ─── Enforcement mode ───────────────────────────────────────────────────────

def get_enforce_mode() -> str:
    """Return the active enforcement mode.

    Any value not in ("warn", "block", "off") falls back to "warn" —
    fail-safe-to-advisory, never fail-open-to-block.
    """
    mode = os.environ.get(ENFORCE_ENV, ENFORCE_DEFAULT).lower()
    if mode not in _ENFORCE_MODES:
        return "warn"
    return mode


# ─── Catalog entry resolution ───────────────────────────────────────────────

def resolve_entry(name, catalog=None):
    """Return the catalog entry dict whose 'name' matches, else None."""
    raw = catalog if catalog is not None else load_capability_catalog()
    for entry in raw.get("entries", []):
        if entry.get("name") == name:
            return entry
    return None


# ─── check_access decision table ────────────────────────────────────────────

def check_access(entry_name, agent_id, confirm=False, catalog=None):
    """Evaluate whether agent_id may access entry_name.

    Returns dict: {"allowed": bool, "outcome": str, "enforce_mode": str,
    "entry": <entry dict or None>, "code": <str, only when refused>,
    "warning": <str or None>}. When outcome == "auth_missing" the result
    additionally carries "env": <the missing env-var name>.
    """
    mode = get_enforce_mode()
    entry = resolve_entry(entry_name, catalog=catalog)

    # Destructive-class confirmation gate — applies in ALL modes, including
    # 'off' (60-CONTEXT locked: "regardless of enforcement mode").
    if entry is not None and entry.get("security_class") == "destructive" and not confirm:
        return {
            "allowed": False,
            "outcome": "destructive_unconfirmed",
            "enforce_mode": mode,
            "entry": entry,
            "code": "capability_destructive_unconfirmed",
            "warning": None,
        }

    if mode == "off":
        # No further checks — callers skip logging entirely.
        return {
            "allowed": True,
            "outcome": "skipped_off",
            "enforce_mode": mode,
            "entry": entry,
            "warning": None,
        }

    if entry is None:
        if mode == "warn":
            return {
                "allowed": True,
                "outcome": "unlisted_warn",
                "enforce_mode": mode,
                "entry": None,
                "warning": (
                    f"capability_unlisted: '{entry_name}' is not in the "
                    f"capability catalog — file a divergence observation"
                ),
            }
        # mode == "block"
        return {
            "allowed": False,
            "outcome": "unlisted_blocked",
            "enforce_mode": mode,
            "entry": None,
            "code": "capability_unlisted_blocked",
            "warning": None,
        }

    auth = entry.get("auth") or {}
    method = auth.get("method", "")
    if method.endswith("-env"):
        env_name = auth.get("env")
        if not os.environ.get(env_name):
            return {
                "allowed": False,
                "outcome": "auth_missing",
                "enforce_mode": mode,
                "entry": entry,
                "code": "capability_auth_missing",
                "warning": None,
                "env": env_name,
            }

    return {
        "allowed": True,
        "outcome": "allowed",
        "enforce_mode": mode,
        "entry": entry,
        "warning": None,
    }


# ─── Audit logging (fail-open) ──────────────────────────────────────────────

def log_access(store, agent_id, entry_name, target, security_class, outcome,
                task_id=None, enforce_mode=None):
    """Audit-log one capability access. NEVER raises (fail-open).

    Writes to the immutable gsd_audit_log via store.audit_log() when store
    is truthy; on a None store or any exception, falls back to the local
    JSONL buffer (_buffer_access).
    """
    tid = task_id or SENTINEL_TASK_ID
    event_type = EVENT_UNLISTED if outcome.startswith("unlisted") else EVENT_ACCESS
    mode = enforce_mode or get_enforce_mode()
    metadata = {
        "catalog_entry": entry_name,
        "target": target,
        "security_class": security_class,
        "outcome": outcome,
        "enforce_mode": mode,
    }

    if store:
        try:
            row_id = store.audit_log(
                task_id=tid,
                event_type=event_type,
                agent_id=agent_id,
                metadata=metadata,
            )
            return {"logged": True, "id": row_id}
        except Exception:
            pass  # fall through to buffer

    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "task_id": tid,
        "event_type": event_type,
        "agent_id": agent_id,
        "catalog_entry": entry_name,
        "target": target,
        "security_class": security_class,
        "outcome": outcome,
        "enforce_mode": mode,
    }
    buffered = _buffer_access(record)
    return {"logged": False, "buffered": buffered}


# ─── JSONL PG-down buffer ────────────────────────────────────────────────────

def _data_dir():
    """Return the data directory: AMAUTA_DATA_DIR override first, else
    <repo_root>/data — MUST match DATA_DIR in gsd-amauta.cjs (~L100:
    process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data'))."""
    override = os.environ.get("AMAUTA_DATA_DIR")
    if override:
        return override
    return os.path.join(_HERE, "..", "data")


def buffer_path():
    """Return the full path to the JSONL PG-down buffer file."""
    return os.path.join(_data_dir(), BUFFER_FILENAME)


def _buffer_access(record):
    """Append one JSON line to buffer_path(). Fail-open: never raises."""
    try:
        path = buffer_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(record) + "\n")
        return True
    except Exception:
        return False


def flush_buffer(store, max_lines=1000):
    """Drain up to max_lines buffered records into store.audit_log().

    Returns {"flushed": N} on success (partial or full). On any exception
    mid-flush, leaves the buffer file untouched and returns
    {"flushed": <n_so_far>, "error": str(e)}. Never raises.
    """
    if not store:
        return {"flushed": 0}

    path = buffer_path()
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return {"flushed": 0}

    try:
        with open(path, "r") as f:
            lines = f.readlines()
    except Exception:
        return {"flushed": 0}

    to_process = lines[:max_lines]
    remainder = lines[max_lines:]
    flushed = 0
    try:
        for line in to_process:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            store.audit_log(
                task_id=rec.get("task_id"),
                event_type=rec.get("event_type"),
                agent_id=rec.get("agent_id"),
                metadata={
                    "catalog_entry": rec.get("catalog_entry"),
                    "target": rec.get("target"),
                    "security_class": rec.get("security_class"),
                    "outcome": rec.get("outcome"),
                    "enforce_mode": rec.get("enforce_mode"),
                },
            )
            flushed += 1
        with open(path, "w") as f:
            f.writelines(remainder)
        return {"flushed": flushed}
    except Exception as e:
        return {"flushed": flushed, "error": str(e)}
