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

try:
    import numpy as _np
    _HAS_NUMPY = True
except ImportError:
    _np = None  # type: ignore
    _HAS_NUMPY = False

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
# Calibration constants (SCALE-03 logistic regression)
# ═══════════════════════════════════════════════════════

_SIMILARITY_NEIGHBORS = 20          # k-nearest neighbors to retrieve for calibration
_COLD_START_MIN_SIMILARITY = 0.5    # min mean similarity; below this → cold-start bias
_CALIBRATION_LR_ITERATIONS = 50    # gradient-descent steps for in-house logistic regression
_CALIBRATION_LR_RATE = 0.05        # learning rate for logistic regression

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


# ═══════════════════════════════════════════════════════
# Escalation — Phase 42 SCALE-04
# ═══════════════════════════════════════════════════════

ESCALATION_TRIGGERS = [
    "manifest_violation",
    "file_count_overshoot",
    "executor_self_report",
    "validator_divergence",
]

_ESCALATION_BIAS = 20  # added to raw_score on each fired escalation

# Regex to count prior escalation entries (not cap_hit entries) in escalation_flags.
_PRIOR_ESC_RE = re.compile(
    r"^(manifest_violation|file_count_overshoot|executor_self_report|validator_divergence):"
)


def detect_escalation(
    handoff: dict,
    executor_report: "dict | None",
    validator_report: "dict | None",
    config: dict,
) -> "list[str]":
    """Detect escalation triggers from current step state. Pure function — no I/O.

    Parameters
    ----------
    handoff : dict
        StepHandoff dict. Must contain 'escalation_flags' (list) and optionally
        'context_snapshot' with 'feature_vector' (dict) and 'chosen_phases' (list).
    executor_report : dict or None
        Executor summary dict. Keys used:
          - 'files_touched': int — count of files actually modified by the executor.
          - 'complexity_surprise': bool — executor self-flags unexpected complexity.
          - 'manifest_violation': bool — executor explicitly reports a manifest violation.
          - 'summary': str (optional) — executor prose; searched for 'COMPLEXITY_SURPRISE'.
    validator_report : dict or None
        Validator verdict dict. Keys used:
          - 'verdict': str — one of 'pass', 'gaps_found', 'fail'.
          - 'violations': list[str] — includes 'manifest_violation' if detected.
    config : dict
        Project config (.planning/config.json). Expected key:
          config['scale_adaptive']['escalation_triggers'] — dict of trigger_name→bool.
          config['scale_adaptive']['file_overshoot_multiplier'] — float (default 1.5).

    Returns
    -------
    list[str]
        Sorted list of trigger names that fired this call.
        Triggers disabled in config are excluded even if conditions match.
    """
    _sa = config.get("scale_adaptive", {})
    _trigger_toggles = _sa.get("escalation_triggers", {})
    _multiplier = _sa.get("file_overshoot_multiplier", 1.5)

    def _enabled(trigger: str) -> bool:
        """Return True if trigger is enabled in config (default True when absent)."""
        return bool(_trigger_toggles.get(trigger, True))

    fired: list = []

    # ── 1. manifest_violation ─────────────────────────────────────────────────────
    if _enabled("manifest_violation"):
        _mv_from_validator = (
            validator_report is not None
            and "manifest_violation" in validator_report.get("violations", [])
        )
        _mv_from_executor = (
            executor_report is not None
            and executor_report.get("manifest_violation") is True
        )
        if _mv_from_validator or _mv_from_executor:
            fired.append("manifest_violation")

    # ── 2. file_count_overshoot ───────────────────────────────────────────────────
    if _enabled("file_count_overshoot") and executor_report is not None:
        _files_touched = executor_report.get("files_touched")
        _context = handoff.get("context_snapshot", {})
        _fv = _context.get("feature_vector", {})
        _files_expected = _fv.get("files_expected")
        if (
            isinstance(_files_touched, (int, float))
            and isinstance(_files_expected, (int, float))
            and _files_expected > 0
            and _files_touched > _multiplier * _files_expected
        ):
            fired.append("file_count_overshoot")

    # ── 3. executor_self_report ───────────────────────────────────────────────────
    if _enabled("executor_self_report") and executor_report is not None:
        _surprise_flag = executor_report.get("complexity_surprise") is True
        _summary_str = executor_report.get("summary", "") or ""
        _surprise_marker = "COMPLEXITY_SURPRISE" in str(_summary_str)
        if _surprise_flag or _surprise_marker:
            fired.append("executor_self_report")

    # ── 4. validator_divergence ───────────────────────────────────────────────────
    if _enabled("validator_divergence") and validator_report is not None:
        _verdict = validator_report.get("verdict", "")
        _chosen = handoff.get("context_snapshot", {}).get("chosen_phases", [])
        # Lighter set = chosen_phases length <= 4 (R,P,E,T or fewer)
        _is_lighter_set = len(_chosen) <= 4
        if _verdict in ("gaps_found", "fail") and _is_lighter_set:
            fired.append("validator_divergence")

    return fired


def apply_escalation(
    handoff: dict,
    fired_triggers: "list[str]",
    config: dict,
) -> dict:
    """Compute the escalation outcome. Pure function — no I/O.

    Parameters
    ----------
    handoff : dict
        StepHandoff dict. Must contain:
          - 'escalation_flags': list[str] — prior escalation flag strings.
          - 'context_snapshot': dict with 'complexity_score' and 'chosen_phases'.
    fired_triggers : list[str]
        Trigger names from detect_escalation().
    config : dict
        Project config. Expected key:
          config['scale_adaptive']['max_escalations_per_task'] — int (default 2).
          config['complexity_buckets'] — list (passed to select_phases).

    Returns
    -------
    dict
        {
          'new_score': int,
          'new_chosen_phases': list[str],
          'escalation_flags_to_append': list[str],
          'cap_hit': bool,
        }
    """
    _sa = config.get("scale_adaptive", {})
    max_escalations = int(_sa.get("max_escalations_per_task", 2))

    _existing_flags = handoff.get("escalation_flags", []) or []
    _context = handoff.get("context_snapshot", {}) or {}
    _current_score = int(_context.get("complexity_score", 0) or 0)
    _current_phases = list(_context.get("chosen_phases", []) or [])

    # Count prior escalation events (not cap_hit entries)
    prior_count = sum(1 for f in _existing_flags if _PRIOR_ESC_RE.match(str(f)))

    if prior_count >= max_escalations:
        # Cap hit — record but do NOT re-score
        return {
            "new_score": _current_score,
            "new_chosen_phases": _current_phases,
            "escalation_flags_to_append": [
                f"cap_hit:{','.join(fired_triggers)}"
            ],
            "cap_hit": True,
        }

    # Under cap — compute new score and new phase set
    new_score = min(100, _current_score + _ESCALATION_BIAS * len(fired_triggers))
    new_chosen_phases = select_phases(new_score, config)
    flags_to_append = [
        f"{t}:rescored_to_{new_score}" for t in fired_triggers
    ]

    return {
        "new_score": new_score,
        "new_chosen_phases": new_chosen_phases,
        "escalation_flags_to_append": flags_to_append,
        "cap_hit": False,
    }


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


# ═══════════════════════════════════════════════════════
# Calibration — Phase 42 SCALE-03 (logistic regression learning loop)
# ═══════════════════════════════════════════════════════

def _load_similar_completions(
    feature_vector: dict,
    embedding: "list[float] | None",
    k: int = _SIMILARITY_NEIGHBORS,
) -> "list[dict]":
    """Query task_completions for the k nearest neighbors by pgvector cosine distance.

    Parameters
    ----------
    feature_vector : dict
        The 7-key feature dict (used for logging only in this function).
    embedding : list[float] or None
        1024-dim embedding of the feature vector for cosine similarity retrieval.
        If None or PG unavailable, returns [].
    k : int
        Number of nearest neighbors to retrieve (default _SIMILARITY_NEIGHBORS=20).

    Returns
    -------
    list[dict]
        Each dict has keys: feature_vector, raw_score, calibrated_score,
        outcome_label, escalation_history, distance, similarity.
        Returns [] on any error or when embedding is None.
    """
    if embedding is None:
        return []
    if not _HAS_PG:
        log.debug("_load_similar_completions: psycopg2 not installed — returning []")
        return []

    sql = """
        SELECT
            feature_vector,
            raw_score,
            calibrated_score,
            outcome_label,
            escalation_history,
            embedding <=> %s::vector AS distance
        FROM task_completions
        ORDER BY embedding <=> %s::vector
        LIMIT %s
    """
    # pgvector expects the embedding as a stringified list: '[0.1,0.2,...]'
    embedding_str = "[" + ",".join(str(float(v)) for v in embedding) + "]"

    try:
        conn = _get_conn()
    except Exception as exc:
        log.warning("_load_similar_completions: PG unavailable — %s", exc)
        return []

    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (embedding_str, embedding_str, k))
                rows = cur.fetchall()
    except Exception as exc:
        log.warning("_load_similar_completions: query failed — %s", exc)
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass

    results = []
    for row in rows:
        d = dict(row)
        distance = float(d.get("distance") or 1.0)
        # Parse feature_vector if it's a JSON string
        fv = d.get("feature_vector")
        if isinstance(fv, str):
            try:
                fv = json.loads(fv)
            except (json.JSONDecodeError, TypeError):
                fv = {}
        d["feature_vector"] = fv or {}
        # Parse escalation_history if it's a JSON string
        eh = d.get("escalation_history")
        if isinstance(eh, str):
            try:
                eh = json.loads(eh)
            except (json.JSONDecodeError, TypeError):
                eh = []
        d["escalation_history"] = eh or []
        d["distance"] = distance
        d["similarity"] = max(0.0, 1.0 - distance)
        results.append(d)

    return results


def _logistic_regression(
    neighbors: "list[dict]",
    target_features: dict,
) -> float:
    """In-house NumPy logistic regression calibration signal.

    Algorithm (documented per CONTEXT.md decision: in-house NumPy, no new dep):
      1. Build feature matrix X (N×7) from neighbor feature_vectors.
         Booleans coerced to 0/1. Numeric features left as-is.
      2. Normalize each column by dividing by max (or 1 if max==0) to keep
         gradients stable.
      3. Build binary label vector y: 1 if outcome_label == 'validator_pass',
         0 otherwise (the model predicts 'similar task succeeded').
      4. Run _CALIBRATION_LR_ITERATIONS steps of batch gradient descent:
           grad = X.T @ (sigmoid(X @ w) - y) / N
           w -= lr * grad
         with L2 regularization term: grad += (lambda/N) * w  (lambda=0.01)
      5. Predict probability for target_features: p = sigmoid(w · x_target).
         Interpretation:
           p > 0.7 → similar tasks succeeded → trust the raw score (nudge down -5)
           p < 0.3 → similar tasks failed   → boost score for safety (+10)
           else    → leave score unchanged

    Parameters
    ----------
    neighbors : list[dict]
        Each dict must have 'feature_vector' (dict) and 'outcome_label' (str).
    target_features : dict
        The 7-key feature dict for the task being scored.

    Returns
    -------
    float
        Probability p in [0.0, 1.0].
        Returns 0.5 (no-op) if fewer than 3 neighbors or NumPy unavailable.
    """
    if not _HAS_NUMPY:
        log.warning("_logistic_regression: NumPy not available — returning 0.5 (no-op)")
        return 0.5
    if len(neighbors) < 3:
        return 0.5  # insufficient data

    def _to_vec(fv: dict) -> "list[float]":
        """Convert a feature dict to a 7-element numeric list (same order as FEATURE_KEYS)."""
        return [
            float(fv.get("files_expected", 0)),
            float(fv.get("estimated_loc", 0)),
            float(fv.get("test_impact", 0)),
            float(fv.get("dependency_depth", 0)),
            float(1 if fv.get("has_migration") else 0),
            float(1 if fv.get("has_api_change") else 0),
            float(fv.get("security_sensitivity", 0)),
        ]

    # Build X and y
    X = _np.array([_to_vec(n["feature_vector"]) for n in neighbors], dtype=_np.float64)
    y = _np.array(
        [1.0 if n.get("outcome_label") == "validator_pass" else 0.0 for n in neighbors],
        dtype=_np.float64,
    )

    # Normalize columns (avoid division by zero)
    col_max = X.max(axis=0)
    col_max[col_max == 0] = 1.0
    X_norm = X / col_max

    # Initialize weights
    n_features = X_norm.shape[1]
    w = _np.zeros(n_features, dtype=_np.float64)

    N = float(len(neighbors))
    lr = _CALIBRATION_LR_RATE
    lam = 0.01  # L2 regularization lambda

    # Gradient descent
    for _ in range(_CALIBRATION_LR_ITERATIONS):
        logits = X_norm @ w
        # sigmoid with clip to avoid overflow
        logits_clipped = _np.clip(logits, -500, 500)
        probs = 1.0 / (1.0 + _np.exp(-logits_clipped))
        error = probs - y
        grad = (X_norm.T @ error) / N + (lam / N) * w
        w -= lr * grad

    # Predict for target
    x_target = _np.array(_to_vec(target_features), dtype=_np.float64)
    x_target_norm = x_target / col_max
    logit = float(_np.dot(w, x_target_norm))
    logit_clipped = max(-500.0, min(500.0, logit))
    p = 1.0 / (1.0 + _np.exp(-logit_clipped))
    return float(p)


def calibrate_score(
    raw_score: int,
    feature_vector: dict,
    config: dict,
    embedding: "list[float] | None" = None,
) -> dict:
    """Calibrate a raw complexity score using historical task outcomes from PG.

    Implements SCALE-03: logistic regression learning loop with cold-start
    conservative-high bias.

    Cold-start branch (returns higher-caution score):
      - Activated when: total task_completions count < cold_start_threshold,
        OR fewer than 3 similar neighbors found,
        OR mean neighbor similarity < _COLD_START_MIN_SIMILARITY.
      - Bias: shift score to the start of the NEXT heavier bucket (more cautious).
        If already in the heaviest bucket, return raw_score unchanged.
      - Returns cold_start=True.

    Calibrated branch (data-driven adjustment):
      - Calls _logistic_regression on nearest neighbors.
      - p > 0.7 (similar tasks passed): nudge score down by 5 (trust the raw).
      - p < 0.3 (similar tasks failed): boost score up by 10 (safety margin).
      - 0.3 <= p <= 0.7: leave score unchanged.
      - Returns cold_start=False.

    Import-safety: If psycopg2 is not installed, always returns cold-start bias
    with a warning log. This preserves safe behavior in CI/CD without a DB.

    Parameters
    ----------
    raw_score : int
        Complexity score in [0, 100] from score_features().
    feature_vector : dict
        The 7-key feature dict for the task being scored.
    config : dict
        Project config dict (.planning/config.json). Must include:
          config['scale_adaptive']['cold_start_threshold'] (default 10).
          config['complexity_buckets'] (default _DEFAULT_BUCKETS).
    embedding : list[float] or None
        1024-dim embedding for pgvector similarity lookup.
        If None, PG lookup is skipped and cold-start bias always applies.

    Returns
    -------
    dict
        {
          'calibrated_score': int,    # adjusted score in [0, 100]
          'confidence': float,        # logistic regression p (0.0 on cold-start)
          'neighbor_count': int,      # number of similar completions found
          'cold_start': bool,         # True when cold-start branch fired
          'adjustment': int,          # calibrated_score - raw_score
        }
    """
    _sa = config.get("scale_adaptive", {})
    cold_start_threshold = int(_sa.get("cold_start_threshold", 10))
    buckets = config.get("complexity_buckets", _DEFAULT_BUCKETS)

    # ── 1. Read total task_completions row count ─────────────────────────────────
    total_count = 0
    if _HAS_PG:
        try:
            conn = _get_conn()
            try:
                with conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT COUNT(*) FROM task_completions")
                        row = cur.fetchone()
                        total_count = int(row[0]) if row else 0
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception as exc:
            log.warning("calibrate_score: could not read task_completions count — %s", exc)
            total_count = 0

    # ── 2. Load similar completions ──────────────────────────────────────────────
    neighbors = _load_similar_completions(feature_vector, embedding, _SIMILARITY_NEIGHBORS)
    mean_similarity = (
        sum(n["similarity"] for n in neighbors) / len(neighbors)
        if neighbors
        else 0.0
    )

    # ── 3. Cold-start branch ─────────────────────────────────────────────────────
    is_cold = (
        total_count < cold_start_threshold
        or len(neighbors) < 3
        or (len(neighbors) >= 3 and mean_similarity < _COLD_START_MIN_SIMILARITY)
    )

    if is_cold:
        # Bias UP: find the next heavier bucket's lower boundary
        shifted = raw_score
        current_bucket_idx = None
        for i, bucket in enumerate(buckets):
            if raw_score <= bucket["max"]:
                current_bucket_idx = i
                break

        if current_bucket_idx is not None and current_bucket_idx < len(buckets) - 1:
            # Shift to the START of the next bucket (prev bucket's max + 1)
            next_bucket_lower = buckets[current_bucket_idx]["max"] + 1
            shifted = next_bucket_lower
        # If already in the heaviest bucket, leave unchanged

        return {
            "calibrated_score": shifted,
            "confidence": 0.0,
            "neighbor_count": len(neighbors),
            "cold_start": True,
            "adjustment": shifted - raw_score,
        }

    # ── 4. Calibrated branch ─────────────────────────────────────────────────────
    p = _logistic_regression(neighbors, feature_vector)

    if p > 0.7:
        # Similar tasks succeeded — nudge down a touch
        calibrated = max(0, raw_score - 5)
    elif p < 0.3:
        # Similar tasks failed — boost for safety
        calibrated = min(100, raw_score + 10)
    else:
        calibrated = raw_score

    return {
        "calibrated_score": calibrated,
        "confidence": p,
        "neighbor_count": len(neighbors),
        "cold_start": False,
        "adjustment": calibrated - raw_score,
    }
