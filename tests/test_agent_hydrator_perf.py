"""
tests/test_agent_hydrator_perf.py — p95 < 500ms performance test for hydrate()

Phase 47-01-07. Requires a real PG backend — skips cleanly if PG is unavailable.
Runs 20 sequential invocations of hydrate("planner"), excludes warmup (first run),
computes p95 over 19 samples, asserts p95 < 500ms.

No mocks. No fixture seeding. Works against whatever real data exists in
agent_findings + gsd_memory + Valkey — empty/sparse data is fine; the perf
budget covers the gather wall-clock, not the result content.
"""

import asyncio
import os
import sys
import time

import pytest

# ── Repo root on sys.path ──────────────────────────────────────────────────────

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ── PG availability gate (same pattern as test_migration_020.py) ──────────────


def _pg_available() -> bool:
    """Return True if a PG connection can be obtained. False on any failure."""
    try:
        from services.pg_store import PGStore

        store = PGStore()
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return True
    except Exception:
        return False


# ── Import hydrate (must succeed even when PG is down) ────────────────────────

from services.agent_hydrator import hydrate  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# Perf test
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.skipif(not _pg_available(), reason="PG required for perf test")
def test_hydrate_p95_under_500ms():
    """p95 latency of hydrate('planner') must be < 500ms over 19 samples (warmup excluded).

    Uses agents/gsd-planner.md as the agent (known to exist in repo).
    Runs 20 invocations: first is warmup, p95 computed on samples 1..19.
    Each invocation uses asyncio.run() to create a fresh event loop (matches CLI usage).
    """
    n_runs = 20
    agent = "planner"

    timings_ms: list[float] = []

    for i in range(n_runs):
        t0 = time.perf_counter()
        asyncio.run(hydrate(agent))
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        timings_ms.append(elapsed_ms)

    # Exclude warmup (index 0); compute p95 on remaining 19 samples
    samples = timings_ms[1:]
    sorted_samples = sorted(samples)
    # Simple percentile: index at 95th position in sorted list
    p95_idx = int(0.95 * len(sorted_samples))
    p95_ms = sorted_samples[p95_idx]

    # Build distribution string for assertion failure message
    distribution_str = ", ".join(f"{ms:.1f}" for ms in sorted_samples)

    assert p95_ms < 500, (
        f"p95 latency {p95_ms:.1f}ms >= 500ms budget. "
        f"Distribution (19 samples, sorted): [{distribution_str}]. "
        f"Warmup (excluded): {timings_ms[0]:.1f}ms"
    )
