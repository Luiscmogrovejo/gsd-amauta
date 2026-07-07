#!/usr/bin/env python3
"""
services/telemetry.py — Phase 62 TEL-01/TEL-02/TEL-03: consent-gated local
telemetry core, the Python twin of get-shit-done/bin/lib/telemetry.cjs.

Privacy policy (non-negotiable): payloads carry METADATA ONLY — ids, types,
counts, durations, error classes. NEVER file contents, prompts, memory text,
secrets, error messages, or raw project names. The project identifier sent
is a salted hash (see project_hash()), never the literal repo basename.

Pre-consent stance: "local-only until consented" is satisfied by the
STRICTER reading — nothing is recorded at all before opt-in. emit_event()
is a total no-op when telemetry is disabled: no buffer file is ever
created, no directory is created, no bytes are written.

Dual-runtime discipline (Phase 60 lesson, carried into Phase 62):
buffer_path() MUST resolve to the IDENTICAL file as bufferPath() in
get-shit-done/bin/lib/telemetry.cjs (AMAUTA_DATA_DIR override first, else
<repo_root>/data) and _data_dir() in services/capability_access.py. Both
runtimes share ONE buffer file; this module NEVER flushes to a network
sink — get-shit-done/bin/lib/telemetry.cjs owns the flush path exclusively
(flushNow() / maybeScheduleFlush()). This module performs NO network I/O
anywhere.

Every fs/JSON operation in this module is wrapped in try/except and
returns a safe default — this module NEVER raises to callers.

Envelope, EVENT_TYPES, buffer location/cap, config keys, env overrides, and
the privacy policy are LOCKED — see .planning/phases/62-telemetry/62-01-PLAN.md
("LOCKED Contracts") and get-shit-done/references/telemetry-events.md.
"""

import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone

# ── sys.path: ensure repo root is importable from any cwd (capability_access.py
#    precedent) ────────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


# ─── LOCKED constants (byte-identical to get-shit-done/bin/lib/telemetry.cjs) ─

SCHEMA_VERSION = "1.1"

EVENT_TYPES = (
    "phase_start",
    "phase_complete",
    "validator_verdict",
    "divergence_filed",
    "divergence_resolved",
    "escalation_fired",
    "party_session",
    "error_class",
    "compression_run",
)

BUFFER_FILENAME = "telemetry-buffer.jsonl"
BUFFER_CAP_DEFAULT = 2000

TELEMETRY_CONFIG_DEFAULTS = {
    "enabled": False,
    "consented_at": None,
    "prompted_at": None,
    "salt": None,
    "sink_url": None,
}


# ─── Path resolution ─────────────────────────────────────────────────────────

def _data_dir():
    """Return the telemetry data directory: AMAUTA_DATA_DIR override first,
    else <repo_root>/data — MUST match DATA_DIR in gsd-amauta.cjs
    (process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data')) and
    dataDir() in get-shit-done/bin/lib/telemetry.cjs (dual-runtime
    discipline, Phase 60 lesson)."""
    override = os.environ.get("AMAUTA_DATA_DIR")
    if override:
        return override
    return os.path.join(_HERE, "..", "data")


def buffer_path():
    """Return the full path to the shared JSONL telemetry buffer file —
    IDENTICAL to bufferPath() in get-shit-done/bin/lib/telemetry.cjs."""
    return os.path.join(_data_dir(), BUFFER_FILENAME)


def _config_path():
    """Resolve the telemetry config file path. GSD_TELEMETRY_CONFIG_PATH is
    an AUTHORITATIVE-EXCLUSIVE test seam: when set, it is returned
    unconditionally — even if the file does not exist at that path — and
    callers must NOT fall through to the repo-root default (v3.4 env-seam
    learning, mirrors configPath() in telemetry.cjs)."""
    override = os.environ.get("GSD_TELEMETRY_CONFIG_PATH")
    if override:
        return override
    return os.path.join(_REPO_ROOT, ".planning", "config.json")


# ─── Config CRUD (fail-open) ─────────────────────────────────────────────────

def read_telemetry_config():
    """Read the `telemetry` section of the config file, merged over
    defaults. Any read/parse failure (missing file, invalid JSON, missing
    key) returns pure defaults — never raises."""
    try:
        with open(_config_path(), "r") as f:
            parsed = json.load(f)
        section = parsed.get("telemetry") if isinstance(parsed, dict) else None
        section = section if isinstance(section, dict) else {}
        merged = dict(TELEMETRY_CONFIG_DEFAULTS)
        merged.update(section)
        return merged
    except Exception:
        return dict(TELEMETRY_CONFIG_DEFAULTS)


def is_enabled():
    """GSD_TELEMETRY env: 'off' hard-disables regardless of config; 'on'
    enables for this process (test/CI seam); unset defers to config."""
    env_flag = os.environ.get("GSD_TELEMETRY")
    if env_flag == "off":
        return False
    if env_flag == "on":
        return True
    try:
        return read_telemetry_config().get("enabled") is True
    except Exception:
        return False


def _buffer_cap():
    """GSD_TELEMETRY_BUFFER_CAP env if a positive int, else BUFFER_CAP_DEFAULT."""
    raw = os.environ.get("GSD_TELEMETRY_BUFFER_CAP")
    if raw is not None:
        try:
            n = int(raw)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    return BUFFER_CAP_DEFAULT


# ─── Envelope construction ───────────────────────────────────────────────────

def project_hash():
    """sha256 hex of (salt || '') + repo-basename, sliced to the first 16
    hex chars. Never the raw repo name itself."""
    try:
        cfg = read_telemetry_config()
        salt = cfg.get("salt") or ""
        basename = os.path.basename(os.path.normpath(_REPO_ROOT))
        return hashlib.sha256((salt + basename).encode("utf-8")).hexdigest()[:16]
    except Exception:
        return "0" * 16


def build_event(event_type, payload=None):
    """Build the LOCKED 6-key event envelope. Never raises."""
    return {
        "schema_version": SCHEMA_VERSION,
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "ts": datetime.now(timezone.utc).isoformat(),
        "project_hash": project_hash(),
        "payload": payload or {},
    }


# ─── emit_event() — the no-op-when-disabled gate ────────────────────────────

def emit_event(event_type, payload=None):
    """emit_event(event_type, payload) — the sole write path into the
    telemetry buffer.

    - Returns {"emitted": False, "reason": "disabled"} when telemetry is
      not enabled. THIS IS THE PRE-CONSENT ZERO-COLLECTION GUARANTEE: no
      buffer directory or file is ever created, no bytes are written.
    - Returns {"emitted": False, "reason": "unknown_event_type"} when
      event_type is not one of the frozen EVENT_TYPES.
    - Otherwise appends one JSON line to the buffer (creating _data_dir()
      recursively if needed), enforces _buffer_cap() by keeping only the
      LAST N lines (oldest dropped first), and returns {"emitted": True}.

    NEVER performs network I/O (Node's lib/telemetry.cjs is the exclusive
    flush owner). NEVER raises.
    """
    try:
        if not is_enabled():
            return {"emitted": False, "reason": "disabled"}
        if event_type not in EVENT_TYPES:
            return {"emitted": False, "reason": "unknown_event_type"}

        event = build_event(event_type, payload)
        b_path = buffer_path()

        try:
            os.makedirs(os.path.dirname(b_path), exist_ok=True)
            with open(b_path, "a") as f:
                f.write(json.dumps(event) + "\n")
        except Exception:
            return {"emitted": False, "reason": "write_failed"}

        # Enforce the bounded cap — oldest lines dropped first.
        try:
            cap = _buffer_cap()
            with open(b_path, "r") as f:
                raw = f.read()
            lines = [l for l in raw.split("\n") if l.strip()]
            if len(lines) > cap:
                kept = lines[len(lines) - cap:]
                with open(b_path, "w") as f:
                    f.write("\n".join(kept) + "\n")
        except Exception:
            # Fail-open: cap enforcement failing must never block emit success.
            pass

        return {"emitted": True}
    except Exception:
        return {"emitted": False, "reason": "error"}
