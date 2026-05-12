#!/usr/bin/env python3
"""
Complexity Scorer — Phase 42 / SCALE-01 + SCALE-02.

Scores task complexity on a 0-100 integer scale using a 7-feature vector,
selects the minimum effective RPETD phase set from configurable buckets,
and persists historical outcomes to the task_completions PG table for
SCALE-03 logistic regression calibration.

Public API (4 functions):
  extract_features  — derive 7-feature dict from plan path + task metadata
  score_features    — compute 0-100 integer from feature dict (pure, deterministic)
  select_phases     — pick RPETD phase set from complexity_buckets config
  store_completion  — INSERT into task_completions; return UUID string

Import safety: mirrors step-orchestrator.py pattern.
  - try psycopg2 → _HAS_PG; graceful fallback if not installed
  - try pydantic → not needed here (no model); plain dicts used throughout
  - Module imports cleanly in CI/test environments without DB or voyage-ai

Dependency depth (DEFERRED note):
  The original intent for 'dependency_depth' was to read from the RLM
  NetworkX graph (v2.9 RLM-06), which is symbol-keyed (function/class →
  callers/callees). At Phase 42 HEAD 48728f1 that graph is not file-keyed,
  and the Node CLI dispatcher has no subcommand for computing file-level
  graph depth. Wiring a real file-level depth surface is DEFERRED to a
  follow-up phase.

  Phase 42 uses FILE-COUNT HEURISTIC ONLY:
      dependency_depth = min(len(files_expected) // 3, 10)

  This slot is intentionally reserved for future calibration once a real
  graph-depth surface (either symbol-extraction from files_expected walking
  rlm_graph.get_neighbors, or a file-keyed graph layer) is added.
"""

import json
import logging
import os
import re
import warnings
from typing import Optional

try:
    import psycopg2
    import psycopg2.extras
    _HAS_PG = True
except ImportError:
    _HAS_PG = False

log = logging.getLogger("amauta.complexity_scorer")

# ═══════════════════════════════════════════════════════
# Module constants
# ═══════════════════════════════════════════════════════

FEATURE_KEYS = [
    "files_expected",
    "estimated_loc",
    "test_impact",
    "dependency_depth",
    "has_migration",
    "has_api_change",
    "security_sensitivity",
]

OUTCOME_LABELS = [
    "validator_pass",
    "task_fail",
    "gaps_found",
    "manifest_overshoot",
    "escalation_fired",
]

# Default bucket configuration — 5 buckets, inclusive max boundary.
# Score 0-15  → Execute only (lightest)
# Score 16-35 → Plan + Execute + Test
# Score 36-60 → R + P + E + T
# Score 61-85 → R + P + E + T + D
# Score 86-100 → Full RPETD + S + A
_DEFAULT_BUCKETS = [
    {"max": 15, "phases": ["E"]},
    {"max": 35, "phases": ["P", "E", "T"]},
    {"max": 60, "phases": ["R", "P", "E", "T"]},
    {"max": 85, "phases": ["R", "P", "E", "T", "D"]},
    {"max": 100, "phases": ["R", "P", "E", "T", "D", "S", "A"]},
]

# Floor rules: path prefix → minimum security_sensitivity score.
# The floor is the MINIMUM for any file whose path STARTS WITH the key.
# Files matching multiple prefixes get the MAX floor value among matches.
_FLOOR_RULES = {
    "services/": 3,
    "agents/": 3,
    "migrations/": 4,
    "specs/": 2,
}

# Files matching these patterns signal an API change.
_API_CHANGE_PATTERNS = [
    r"services/amauta-daemon\.py$",
    r"^api/",
    r"/router\.py$",
    r"/routes\.py$",
]

_DEFAULT_PG_URL = "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"

# ═══════════════════════════════════════════════════════
# Database connection (mirrors step-orchestrator._get_conn)
# ═══════════════════════════════════════════════════════

def _get_conn():
    """Return a psycopg2 connection using DATABASE_URL, GSD_POSTGRES_URL, or default.

    Raises RuntimeError if psycopg2 is not installed.
    """
    if not _HAS_PG:
        raise RuntimeError("psycopg2 not installed — cannot connect to PostgreSQL")
    db_url = (
        os.environ.get("DATABASE_URL")
        or os.environ.get("GSD_POSTGRES_URL")
        or _DEFAULT_PG_URL
    )
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


# ═══════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════

def _parse_files_expected_from_plan(path: str) -> list:
    """Parse all files listed in <files_expected> blocks from a PLAN.md file.

    Uses a simple regex over the YAML sublists inside <files_expected>...</files_expected>
    tags. Returns a flat list of file path strings.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except (OSError, IOError) as exc:
        log.warning("Could not read plan file %s: %s", path, exc)
        return []

    files = []
    # Find all <files_expected> blocks
    for block in re.findall(r"<files_expected>(.*?)</files_expected>", content, re.DOTALL):
        # Match YAML list items: "      - path/to/file"
        for line in block.splitlines():
            stripped = line.strip()
            if stripped.startswith("- ") and not stripped.startswith("- []"):
                candidate = stripped[2:].strip()
                # Skip section headers (modify:, create:, delete:) and empty entries
                if candidate and not candidate.endswith(":") and candidate != "[]":
                    files.append(candidate)
    return files


def _estimate_loc_from_plan(path: str) -> int:
    """Sum estimated_loc fields from all tasks in the plan (default 0 if absent)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except (OSError, IOError):
        return 0

    total = 0
    for m in re.finditer(r"<estimated_loc>\s*(\d+)\s*</estimated_loc>", content):
        try:
            total += int(m.group(1))
        except ValueError:
            pass
    return total


def _llm_grade_test_impact(files: list, task_meta: dict) -> int:
    """LLM-based test impact grader (stub — returns 0 unless GSD_COMPLEXITY_LLM=1).

    When GSD_COMPLEXITY_LLM=1, this would call an LLM to assess test impact
    based on file semantics. For now, returns 0 so the deterministic floor
    from the file count is always used.
    """
    if os.environ.get("GSD_COMPLEXITY_LLM") != "1":
        return 0
    # Future: call LLM to grade semantic test impact (0-10)
    # Placeholder — never reached unless explicitly enabled
    log.debug("GSD_COMPLEXITY_LLM=1: LLM test impact grading not yet implemented")
    return 0


def _llm_grade_security(files: list, task_meta: dict) -> int:
    """LLM-based security sensitivity grader (stub — returns 0 unless GSD_COMPLEXITY_LLM=1).

    When GSD_COMPLEXITY_LLM=1, this would call an LLM to assess security
    sensitivity based on file semantics and task description. Returns 0
    so the deterministic floor rules always apply as the base.
    """
    if os.environ.get("GSD_COMPLEXITY_LLM") != "1":
        return 0
    # Future: call LLM to grade semantic security sensitivity (0-10)
    log.debug("GSD_COMPLEXITY_LLM=1: LLM security grading not yet implemented")
    return 0


# ═══════════════════════════════════════════════════════
# Public functions
# ═══════════════════════════════════════════════════════

def extract_features(
    plan_path: Optional[str],
    task_meta: dict,
    project_root: str = ".",
) -> dict:
    """Derive the canonical 7-feature vector from a plan file + task metadata.

    Parameters
    ----------
    plan_path : str or None
        Absolute or relative path to the PLAN.md file for this task.
        If None or the file cannot be read, file-based features default to 0/False.
    task_meta : dict
        Arbitrary task metadata dict. May contain:
          - 'files_expected': list of file paths (overrides plan parse if provided)
          - 'estimated_loc': int (overrides plan parse if provided)
          - 'description': str (used for LLM grading when enabled)
          - 'title': str
    project_root : str
        Project root for resolving relative file paths (default ".").

    Returns
    -------
    dict
        Exactly the 7 FEATURE_KEYS keys. Raises KeyError if any key is missing
        (regression-guard — callers rely on all 7 keys being present).

    Feature notes
    -------------
    files_expected  : int  — count of files listed across all <files_expected> blocks
                             in the plan. Strict deterministic (code pattern).
    estimated_loc   : int  — sum of <estimated_loc> tags in plan tasks.
                             Deterministic when plan exists; 0 otherwise.
    has_migration   : bool — True if any file in files_expected matches migrations/*.sql
                             Strict deterministic (path pattern).
    has_api_change  : bool — True if any file matches daemon, api/, router.py, or routes.py
                             Strict deterministic (path pattern).
    test_impact     : int (0-10) — floor rule: count of test files in files_expected.
                             LLM grading enabled via GSD_COMPLEXITY_LLM=1 (takes max).
    security_sensitivity : int (0-10) — floor rule: max of _FLOOR_RULES matches.
                             LLM grading enabled via GSD_COMPLEXITY_LLM=1 (takes max).
    dependency_depth : int (0-10) — FILE-COUNT HEURISTIC ONLY (see module docstring).
                             min(len(files_expected) // 3, 10)
                             A real graph-depth surface is DEFERRED to a follow-up phase.
    """
    # Resolve files list
    if "files_expected" in task_meta and isinstance(task_meta["files_expected"], list):
        files = task_meta["files_expected"]
    elif plan_path:
        files = _parse_files_expected_from_plan(plan_path)
    else:
        files = []

    # files_expected: count of distinct file paths
    files_expected_count = len(files)

    # estimated_loc: plan-declared sum or task_meta override
    if "estimated_loc" in task_meta:
        try:
            estimated_loc = int(task_meta["estimated_loc"])
        except (TypeError, ValueError):
            estimated_loc = 0
    elif plan_path:
        estimated_loc = _estimate_loc_from_plan(plan_path)
    else:
        estimated_loc = 0

    # has_migration: any file matches migrations/*.sql
    has_migration = any(
        re.search(r"migrations/[^/]+\.sql$", f) for f in files
    )

    # has_api_change: any file matches the documented API-change patterns
    has_api_change = any(
        any(re.search(pat, f) for pat in _API_CHANGE_PATTERNS)
        for f in files
    )

    # test_impact: floor = count of files under tests/ (capped at 10)
    test_floor = min(len([f for f in files if f.startswith("tests/")]), 10)
    llm_test = _llm_grade_test_impact(files, task_meta)
    test_impact = max(test_floor, llm_test)

    # security_sensitivity: max floor among _FLOOR_RULES matches
    sec_floor = 0
    for f in files:
        for prefix, min_score in _FLOOR_RULES.items():
            if f.startswith(prefix):
                sec_floor = max(sec_floor, min_score)
    llm_sec = _llm_grade_security(files, task_meta)
    security_sensitivity = max(sec_floor, llm_sec)

    # dependency_depth: FILE-COUNT HEURISTIC (see module docstring).
    # Real graph-depth wiring is DEFERRED. This file-count heuristic is a
    # provisional slot so the feature vector has the correct shape for future
    # calibration once a file-keyed graph layer is available.
    dependency_depth = min(files_expected_count // 3, 10)

    features = {
        "files_expected": files_expected_count,
        "estimated_loc": estimated_loc,
        "test_impact": test_impact,
        "dependency_depth": dependency_depth,
        "has_migration": has_migration,
        "has_api_change": has_api_change,
        "security_sensitivity": security_sensitivity,
    }

    # Regression-guard: ensure all 7 keys are present
    for key in FEATURE_KEYS:
        if key not in features:
            raise KeyError(f"extract_features: missing key '{key}' in output")

    return features


def score_features(features: dict) -> int:
    """Compute a deterministic 0-100 integer complexity score from a feature dict.

    The function is pure — no side effects, no I/O. Calling it twice with the
    same input ALWAYS returns the same output.

    Score formula (weights sum to 100):
      files_expected    (0-20 files)   → max contribution 20   weight 20
      estimated_loc     (0-500 LOC)    → max contribution 15   weight 15
      test_impact       (0-10)         → max contribution 10   weight 10
      dependency_depth  (0-10)         → max contribution 15   weight 15
      has_migration     boolean        → flat +15 or 0         weight 15
      has_api_change    boolean        → flat +10 or 0         weight 10
      security_sensitivity (0-10)     → max contribution 15   weight 15
                                                              ─────────
                                                        total: 100

    Parameters
    ----------
    features : dict
        Must contain exactly the 7 FEATURE_KEYS. Raises KeyError if any key
        is missing.

    Returns
    -------
    int
        Score in [0, 100] (clamped after rounding).
    """
    for key in FEATURE_KEYS:
        if key not in features:
            raise KeyError(f"score_features: missing feature key '{key}'")

    score = (
        min(features["files_expected"], 20) / 20 * 20
        + min(features["estimated_loc"], 500) / 500 * 15
        + min(features["test_impact"], 10) / 10 * 10
        + min(features["dependency_depth"], 10) / 10 * 15
        + (15 if features["has_migration"] else 0)
        + (10 if features["has_api_change"] else 0)
        + min(features["security_sensitivity"], 10) / 10 * 15
    )

    # Round and clamp
    result = int(round(score))
    return max(0, min(100, result))


def select_phases(score: int, config: dict) -> list:
    """Select the RPETD phase set for a given complexity score.

    Reads 'complexity_buckets' from config (falls back to _DEFAULT_BUCKETS if
    the key is missing). Iterates buckets in order; returns the phases list of
    the first bucket whose max >= score (inclusive upper boundary).

    Parameters
    ----------
    score : int
        Complexity score in [0, 100]. Raises ValueError if outside this range.
    config : dict
        Project config dict (typically from .planning/config.json).
        Optional key: 'complexity_buckets' — list of {"max": N, "phases": [...]}

    Returns
    -------
    list[str]
        Phase letter list, e.g. ["E"] or ["R", "P", "E", "T", "D", "S", "A"].

    Raises
    ------
    ValueError
        If score < 0 or score > 100.
    """
    if score < 0 or score > 100:
        raise ValueError(f"select_phases: score {score} out of range [0, 100]")

    buckets = config.get("complexity_buckets", _DEFAULT_BUCKETS)

    for bucket in buckets:
        if score <= bucket["max"]:
            return list(bucket["phases"])

    # Should never reach here for a valid score+buckets config (last bucket max=100)
    # Fall back to full phase set as a safe default
    log.warning(
        "select_phases: score %d exceeded all bucket max values; using full phase set",
        score,
    )
    return list(_DEFAULT_BUCKETS[-1]["phases"])


def store_completion(
    task_id: str,
    phase_number: int,
    workflow_name: str,
    features: dict,
    raw_score: int,
    calibrated_score: Optional[int],
    chosen_phases: list,
    phases_run: list,
    outcome_label: str,
    escalation_history: list,
    embedding: Optional[list],
) -> str:
    """Persist a task completion record to the task_completions PG table.

    Validates inputs then INSERTs one row. Returns the generated UUID as a
    string. On PG unavailability (psycopg2 not installed, or DB unreachable),
    logs a warning and returns "" — mirrors the graceful fallback pattern
    used by step-orchestrator.load_or_create_handoff.

    Parameters
    ----------
    task_id : str
        Task identifier (e.g., "TK-0042").
    phase_number : int
        Phase number being recorded.
    workflow_name : str
        One of: plan-phase, execute-phase, discuss-phase.
    features : dict
        The 7-key feature dict from extract_features().
    raw_score : int
        Computed complexity score in [0, 100].
    calibrated_score : int or None
        LR-calibrated score in [0, 100], or None before SCALE-03 model trained.
    chosen_phases : list[str]
        Phase set selected by select_phases().
    phases_run : list[str]
        Actual phases executed (may differ from chosen if escalated).
    outcome_label : str
        One of OUTCOME_LABELS.
    escalation_history : list[dict]
        Escalation events that occurred during this task.
    embedding : list[float] or None
        1024-dim voyage-code-3 embedding of the feature vector, or None.

    Returns
    -------
    str
        UUID string of the inserted row, or "" on error.

    Raises
    ------
    ValueError
        If outcome_label is not in OUTCOME_LABELS, or scores are out of range.
    """
    # Input validation
    if outcome_label not in OUTCOME_LABELS:
        raise ValueError(
            f"store_completion: outcome_label '{outcome_label}' not in {OUTCOME_LABELS}"
        )
    if raw_score < 0 or raw_score > 100:
        raise ValueError(
            f"store_completion: raw_score {raw_score} out of range [0, 100]"
        )
    if calibrated_score is not None and (calibrated_score < 0 or calibrated_score > 100):
        raise ValueError(
            f"store_completion: calibrated_score {calibrated_score} out of range [0, 100]"
        )

    if not _HAS_PG:
        log.warning(
            "store_completion: psycopg2 not installed — skipping PG write for task %s",
            task_id,
        )
        return ""

    try:
        conn = _get_conn()
    except Exception as exc:
        log.warning(
            "store_completion: PG unavailable for task %s — %s",
            task_id,
            exc,
        )
        return ""

    sql = """
        INSERT INTO task_completions (
            task_id, phase_number, workflow_name,
            feature_vector, raw_score, calibrated_score,
            chosen_phases, phases_run, outcome_label,
            escalation_history, embedding
        ) VALUES (
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s
        )
        RETURNING id
    """

    # Serialize embedding as pgvector string if provided
    embedding_val = None
    if embedding is not None:
        embedding_val = embedding  # psycopg2 will pass as list; pgvector adapter handles it

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql,
                    (
                        task_id,
                        phase_number,
                        workflow_name,
                        json.dumps(features),
                        raw_score,
                        calibrated_score,
                        chosen_phases,
                        phases_run,
                        outcome_label,
                        json.dumps(escalation_history),
                        embedding_val,
                    ),
                )
                row = cur.fetchone()
                return str(row[0]) if row else ""
    except Exception as exc:
        log.warning(
            "store_completion: INSERT failed for task %s — %s",
            task_id,
            exc,
        )
        return ""
    finally:
        try:
            conn.close()
        except Exception:
            pass
