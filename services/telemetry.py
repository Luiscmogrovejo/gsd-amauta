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

# TK-1890 AGEN-04: token/cost budget ceiling — default OFF, opt-in like the
# `compression` block. 0 = unlimited. action: "warn" logs a structured
# warning event; "block" additionally returns a block signal for callers.
TOKEN_BUDGET_DEFAULTS = {
    "enabled": False,
    "max_tokens_per_task": 0,
    "max_cost_usd_per_task": 0,
    "action": "warn",
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


# ─── Token/cost budget ceiling (TK-1890 AGEN-04) — fail-open enforcement ────

def read_token_budget_config():
    """Read the `token_budget` section of the config file, merged over
    TOKEN_BUDGET_DEFAULTS. Any read/parse failure (missing file, invalid
    JSON, missing key, non-dict section) returns pure defaults — never
    raises. Mirrors read_telemetry_config() exactly.

    Returns:
        dict: {"enabled", "max_tokens_per_task", "max_cost_usd_per_task",
        "action"} merged over defaults.
    """
    try:
        with open(_config_path(), "r") as f:
            parsed = json.load(f)
        section = parsed.get("token_budget") if isinstance(parsed, dict) else None
        section = section if isinstance(section, dict) else {}
        merged = dict(TOKEN_BUDGET_DEFAULTS)
        merged.update(section)
        return merged
    except Exception:
        return dict(TOKEN_BUDGET_DEFAULTS)


def _coerce_num(value, cast, default=0):
    """Coerce `value` via `cast` (int/float); non-numeric/negative → default."""
    try:
        n = cast(value)
        if n < 0:
            return default
        return n
    except (TypeError, ValueError):
        return default


def check_budget_ceiling(spent_tokens=0, spent_cost=0.0):
    """check_budget_ceiling(spent_tokens, spent_cost) — the AGEN-04
    enforcement point: compares spend against the config `token_budget`
    ceiling and returns the enforcement verdict.

    Args:
        spent_tokens: tokens consumed so far (task scope).
        spent_cost: USD cost consumed so far (task scope).

    Returns:
        dict: {"over": bool, "action": "warn"|"block",
               "limit": {"max_tokens_per_task", "max_cost_usd_per_task"},
               "spent": {"tokens", "cost_usd"}}.

    Semantics (LOCKED to the config defaults above):
        - enabled is not True  → over is always False (default OFF, opt-in).
        - a limit of 0 means unlimited on that axis.
        - action is "block" only when configured exactly "block"; anything
          else (including malformed) degrades to "warn".
        - Fail-open: NEVER raises; any internal failure returns over=False.

    Example:
        >>> check_budget_ceiling(spent_tokens=500, spent_cost=0.01)
        {'over': False, 'action': 'warn', 'limit': {...}, 'spent': {...}}
    """
    try:
        cfg = read_token_budget_config()
        max_tokens = _coerce_num(cfg.get("max_tokens_per_task"), int, 0)
        max_cost = _coerce_num(cfg.get("max_cost_usd_per_task"), float, 0.0)
        action = "block" if cfg.get("action") == "block" else "warn"
        tokens = _coerce_num(spent_tokens, int, 0)
        cost = _coerce_num(spent_cost, float, 0.0)
        over = False
        if cfg.get("enabled") is True:
            over_tokens = max_tokens > 0 and tokens > max_tokens
            over_cost = max_cost > 0 and cost > max_cost
            over = bool(over_tokens or over_cost)
        return {
            "over": over,
            "action": action,
            "limit": {
                "max_tokens_per_task": max_tokens,
                "max_cost_usd_per_task": max_cost,
            },
            "spent": {"tokens": tokens, "cost_usd": cost},
        }
    except Exception:
        return {
            "over": False,
            "action": "warn",
            "limit": dict(
                max_tokens_per_task=0, max_cost_usd_per_task=0.0
            ),
            "spent": {"tokens": 0, "cost_usd": 0.0},
        }


def _payload_token_spend(payload):
    """Extract (spent_tokens, spent_cost) from an event payload carrying
    token-usage metadata, or None when the payload records no usage.
    Recognized token keys: spent_tokens, token_usage, tokens_used, tokens,
    total_tokens. Recognized cost keys: spent_cost, cost_usd, cost.
    Never raises."""
    try:
        if not isinstance(payload, dict):
            return None
        tokens = None
        for key in ("spent_tokens", "token_usage", "tokens_used", "tokens",
                    "total_tokens"):
            if isinstance(payload.get(key), (int, float)):
                tokens = payload[key]
                break
        cost = None
        for key in ("spent_cost", "cost_usd", "cost"):
            if isinstance(payload.get(key), (int, float)):
                cost = payload[key]
                break
        if tokens is None and cost is None:
            return None
        return (tokens or 0, cost or 0.0)
    except Exception:
        return None


def _log_budget_warning(verdict):
    """Emit one structured warning line (ENG-05 shape) to stderr when the
    budget ceiling is exceeded. Metadata only — counts and limits, never
    content. EVENT_TYPES is a LOCKED contract, so the warning is a log
    line, not a new buffer event type. Never raises."""
    try:
        line = json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": "warn",
            "service": "telemetry",
            "message": "token_budget_ceiling_exceeded",
            "context": verdict,
        })
        sys.stderr.write(line + "\n")
    except Exception:
        pass


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
    - Budget ceiling hook (TK-1890 AGEN-04): when the payload records token
      usage (see _payload_token_spend()), check_budget_ceiling() runs at
      this recording point. If over budget, a structured warning is logged
      and the verdict rides along as {"emitted": True, "budget": {...}} —
      the block signal for callers when action == "block". While
      token_budget is disabled (the default) the verdict is never over, the
      "budget" key is never attached, and behavior is byte-identical to
      before.

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

        # Budget ceiling enforcement at the recording point (TK-1890 AGEN-04).
        # Fail-open: the ceiling check must never break emit success.
        try:
            spend = _payload_token_spend(payload)
            if spend is not None:
                verdict = check_budget_ceiling(spend[0], spend[1])
                if verdict.get("over"):
                    _log_budget_warning(verdict)
                    return {"emitted": True, "budget": verdict}
        except Exception:
            pass

        return {"emitted": True}
    except Exception:
        return {"emitted": False, "reason": "error"}
