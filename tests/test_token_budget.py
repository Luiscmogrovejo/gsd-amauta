#!/usr/bin/env python3
"""tests/test_token_budget.py — TK-1890 AGEN-04: config-driven token/cost
budget ceiling in services/telemetry.py.

Covers: under-budget, over-budget warn, over-budget block (block signal
returned to callers via emit_event), disabled (default OFF — zero behavior
change), config-absent fail-open, malformed-config fail-open, zero-limit
means unlimited, and the cost-only ceiling axis.

Fixture idioms mirror tests/test_telemetry.py: monkeypatch.setenv +
tmp_path sandboxes via the GSD_TELEMETRY_CONFIG_PATH authoritative-exclusive
seam and AMAUTA_DATA_DIR — the real repo data/ dir and .planning/config.json
are NEVER touched by these tests.

Run: pytest tests/test_token_budget.py -q
"""

import json
import os
import sys

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from services.telemetry import (
    TOKEN_BUDGET_DEFAULTS,
    check_budget_ceiling,
    emit_event,
    read_token_budget_config,
)


def _write_config(tmp_path, monkeypatch, token_budget=None, raw=None,
                  telemetry_enabled=True):
    """Write a sandboxed config file and point the module at it.

    token_budget=None omits the block entirely (config-absent-for-section
    case); raw=<str> writes literal bytes (malformed-JSON case)."""
    cfg_path = tmp_path / "config.json"
    if raw is not None:
        cfg_path.write_text(raw)
    else:
        cfg = {"telemetry": {"enabled": telemetry_enabled, "salt": "s"}}
        if token_budget is not None:
            cfg["token_budget"] = token_budget
        cfg_path.write_text(json.dumps(cfg))
    monkeypatch.setenv("GSD_TELEMETRY_CONFIG_PATH", str(cfg_path))
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("GSD_TELEMETRY", "on")
    return cfg_path


def test_under_budget(tmp_path, monkeypatch):
    """Enabled with generous limits: spend below both ceilings → over=False."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 10000,
        "max_cost_usd_per_task": 5.0, "action": "warn",
    })
    verdict = check_budget_ceiling(spent_tokens=500, spent_cost=0.01)
    assert verdict["over"] is False
    assert verdict["action"] == "warn"
    assert verdict["limit"]["max_tokens_per_task"] == 10000
    assert verdict["spent"] == {"tokens": 500, "cost_usd": 0.01}


def test_over_budget_warn(tmp_path, monkeypatch):
    """Enabled, low token ceiling, action=warn: over=True + structured
    warning logged at the emit_event recording point."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 100,
        "max_cost_usd_per_task": 0, "action": "warn",
    })
    verdict = check_budget_ceiling(spent_tokens=250)
    assert verdict["over"] is True
    assert verdict["action"] == "warn"

    # Recording-point integration: emit an event whose payload records
    # token usage; the warn path returns the verdict but never blocks emit.
    res = emit_event("phase_complete", {"token_usage": 250})
    assert res["emitted"] is True
    assert res["budget"]["over"] is True
    assert res["budget"]["action"] == "warn"


def test_over_budget_warn_logs_structured_event(tmp_path, monkeypatch, capsys):
    """The over-budget path writes one ENG-05-shaped structured warning line
    to stderr (EVENT_TYPES is LOCKED, so it is a log line, not a new
    buffer event type)."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 100,
        "max_cost_usd_per_task": 0, "action": "warn",
    })
    res = emit_event("phase_complete", {"token_usage": 999})
    assert res["emitted"] is True and res["budget"]["over"] is True
    err = capsys.readouterr().err.strip().splitlines()
    warn = json.loads(err[-1])
    assert warn["level"] == "warn"
    assert warn["service"] == "telemetry"
    assert warn["message"] == "token_budget_ceiling_exceeded"
    assert warn["context"]["over"] is True
    assert warn["context"]["spent"]["tokens"] == 999


def test_over_budget_block(tmp_path, monkeypatch):
    """action=block: the block signal is returned to callers from both
    check_budget_ceiling and the emit_event recording point."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 100,
        "max_cost_usd_per_task": 0, "action": "block",
    })
    verdict = check_budget_ceiling(spent_tokens=250)
    assert verdict["over"] is True
    assert verdict["action"] == "block"

    res = emit_event("phase_complete", {"spent_tokens": 250})
    assert res["emitted"] is True
    assert res["budget"]["over"] is True
    assert res["budget"]["action"] == "block"


def test_disabled_zero_behavior_change(tmp_path, monkeypatch):
    """Default OFF: enabled=false with ridiculously low limits never trips,
    and emit_event's return value is byte-identical to pre-TK-1890 shape
    (no 'budget' key)."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": False, "max_tokens_per_task": 1,
        "max_cost_usd_per_task": 0.0001, "action": "block",
    })
    verdict = check_budget_ceiling(spent_tokens=10**9, spent_cost=10**6)
    assert verdict["over"] is False

    res = emit_event("phase_complete", {"token_usage": 10**9})
    assert res == {"emitted": True}


def test_config_absent_fail_open(tmp_path, monkeypatch):
    """No config file at all: pure defaults (enabled=False), never raises,
    never blocks."""
    monkeypatch.setenv("GSD_TELEMETRY_CONFIG_PATH",
                       str(tmp_path / "does-not-exist.json"))
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("GSD_TELEMETRY", "on")
    assert read_token_budget_config() == TOKEN_BUDGET_DEFAULTS
    verdict = check_budget_ceiling(spent_tokens=10**9, spent_cost=10**6)
    assert verdict["over"] is False
    res = emit_event("phase_complete", {"token_usage": 10**9})
    assert res == {"emitted": True}


def test_malformed_config_fail_open(tmp_path, monkeypatch):
    """Invalid JSON / non-dict token_budget section: never raises, over=False."""
    _write_config(tmp_path, monkeypatch, raw="{not valid json!!")
    assert read_token_budget_config() == TOKEN_BUDGET_DEFAULTS
    assert check_budget_ceiling(10**9, 10**6)["over"] is False

    _write_config(tmp_path, monkeypatch, raw=json.dumps(
        {"token_budget": "not-a-dict"}))
    assert read_token_budget_config() == TOKEN_BUDGET_DEFAULTS
    assert check_budget_ceiling(10**9, 10**6)["over"] is False

    # Malformed VALUES inside an otherwise-enabled block also fail open.
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": "lots",
        "max_cost_usd_per_task": None, "action": 42,
    })
    verdict = check_budget_ceiling(spent_tokens=10**9)
    assert verdict["over"] is False       # unparseable limit → 0 → unlimited
    assert verdict["action"] == "warn"    # non-"block" degrades to warn


def test_zero_limit_means_unlimited(tmp_path, monkeypatch):
    """enabled=true with both limits 0: 0 = unlimited, never over."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 0,
        "max_cost_usd_per_task": 0, "action": "block",
    })
    assert check_budget_ceiling(10**12, 10**9)["over"] is False


def test_cost_only_ceiling(tmp_path, monkeypatch):
    """The cost axis enforces independently of the token axis."""
    _write_config(tmp_path, monkeypatch, token_budget={
        "enabled": True, "max_tokens_per_task": 0,
        "max_cost_usd_per_task": 1.50, "action": "warn",
    })
    assert check_budget_ceiling(spent_tokens=10**9, spent_cost=1.49)["over"] is False
    verdict = check_budget_ceiling(spent_tokens=0, spent_cost=2.00)
    assert verdict["over"] is True
    assert verdict["spent"]["cost_usd"] == 2.00
