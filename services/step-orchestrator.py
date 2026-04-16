#!/usr/bin/env python3
"""
Step Orchestrator — manages step-level handoffs for sharded workflows.

Phase 41 / SHARD-04: Each workflow step boundary produces a StepHandoff object
stored in the step_handoffs PG table. Enables resumption, rollback, and
validation between steps in plan-phase, execute-phase, and discuss-phase.

5 public functions:
  load_or_create_handoff — query PG or create fresh StepHandoff
  save_handoff            — append-only INSERT to step_handoffs
  get_next_step           — return next step file path or None
  rollback_step           — rewind completed_steps and save rollback handoff
  validate_handoff        — structural + semantic validation, returns (bool, errors)
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

try:
    from pydantic import BaseModel, Field, model_validator
    _HAS_PYDANTIC = True
except ImportError:
    # Fallback: minimal dataclass shim so module imports without crashing.
    import dataclasses
    import sys
    print("[step_orchestrator] pydantic not available; using dataclass fallback", file=sys.stderr)
    _HAS_PYDANTIC = False

    class _FakeField:
        def __call__(self, **kwargs):
            return dataclasses.field(
                default=kwargs.get("default", dataclasses.MISSING),
                default_factory=kwargs.get("default_factory", dataclasses.MISSING)
            )
    Field = _FakeField()

    class BaseModel:
        pass

    def model_validator(**kwargs):
        def decorator(fn):
            return fn
        return decorator

try:
    import psycopg2
    import psycopg2.extras
    _HAS_PG = True
except ImportError:
    _HAS_PG = False

log = logging.getLogger("amauta.step_orchestrator")

# ═══════════════════════════════════════════════════════
# Step sequences — one entry per sharded workflow
# ═══════════════════════════════════════════════════════

WORKFLOW_STEPS = {
    "plan-phase": [
        "step-01-init",
        "step-02-research",
        "step-03-plan",
        "step-04-check",
        "step-05-approve",
    ],
    "execute-phase": [
        "step-01-prepare",
        "step-02-route",
        "step-03-execute",
        "step-04-verify",
        "step-05-validate",
        "step-06-close",
    ],
    "discuss-phase": [
        "step-01-scout",
        "step-02-analyze",
        "step-03-discuss",
        "step-04-commit",
    ],
}

_CONTEXT_SNAPSHOT_MAX_CHARS = 2400  # ~600 tokens (cl100k_base approximation)

# ═══════════════════════════════════════════════════════
# StepHandoff model
# ═══════════════════════════════════════════════════════

if _HAS_PYDANTIC:
    class StepHandoff(BaseModel):
        """Typed handoff object passed between workflow steps.

        Stored append-only in step_handoffs PG table.
        context_snapshot must be <=600 tokens (~2400 chars serialized).
        """

        id: str = Field(default_factory=lambda: str(uuid4()),
                        description="Auto-generated UUID primary key")
        workflow_name: str = Field(...,
                                   description="One of: plan-phase, execute-phase, discuss-phase")
        step_id: str = Field(..., description="Current step identifier (e.g., step-01-init)")
        task_id: str = Field(..., description="Links to RPETD task (e.g., TK-0041)")
        phase_number: int = Field(..., ge=1, description="Phase number being executed")
        completed_steps: list = Field(default_factory=list,
                                      description="step_ids that have completed")
        context_snapshot: dict = Field(...,
                                       description="RPETDContext-compatible snapshot, <=600 tokens")
        artifacts: dict = Field(default_factory=dict,
                                description="Step outputs: {plan_files, summaries, commits}")
        decisions: list = Field(default_factory=list,
                                description="Decisions made during workflow execution")
        user_inputs: list = Field(default_factory=list,
                                  description="User responses to AskUserQuestion prompts")
        next_step: Optional[str] = Field(default=None,
                                         description="Next step to execute, or None if complete")
        escalation_flags: list = Field(default_factory=list,
                                       description="Flags for issues needing operator attention")
        created_at: str = Field(
            default_factory=lambda: datetime.now(timezone.utc).isoformat(),
            description="Auto-generated ISO timestamp"
        )

else:
    import dataclasses as _dc

    @_dc.dataclass
    class StepHandoff:
        """Minimal StepHandoff dataclass for environments without pydantic."""
        id: str = _dc.field(default_factory=lambda: str(uuid4()))
        workflow_name: str = ""
        step_id: str = ""
        task_id: str = ""
        phase_number: int = 0
        completed_steps: list = _dc.field(default_factory=list)
        context_snapshot: dict = _dc.field(default_factory=dict)
        artifacts: dict = _dc.field(default_factory=dict)
        decisions: list = _dc.field(default_factory=list)
        user_inputs: list = _dc.field(default_factory=list)
        next_step: Optional[str] = None
        escalation_flags: list = _dc.field(default_factory=list)
        created_at: str = _dc.field(
            default_factory=lambda: datetime.now(timezone.utc).isoformat()
        )


# ═══════════════════════════════════════════════════════
# Database connection
# ═══════════════════════════════════════════════════════

_DEFAULT_PG_URL = "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"

def _get_conn():
    """Return a psycopg2 connection using DATABASE_URL or default.

    Follows the same pattern as pg_store._get_conn().
    Raises RuntimeError if psycopg2 is not installed.
    """
    if not _HAS_PG:
        raise RuntimeError("psycopg2 not installed — cannot connect to PostgreSQL")
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("GSD_POSTGRES_URL") or _DEFAULT_PG_URL
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


# ═══════════════════════════════════════════════════════
# Public functions
# ═══════════════════════════════════════════════════════

def load_or_create_handoff(workflow: str, phase: int, task_id: str) -> StepHandoff:
    """Load the latest StepHandoff from PG, or create a fresh one.

    Query strategy: SELECT latest row WHERE workflow_name + phase_number + task_id.
    If found: deserialize and return.
    If not found: create new StepHandoff with step_id = first step, next_step = second step.

    Args:
        workflow:   Workflow name (e.g., "plan-phase")
        phase:      Phase number (e.g., 41)
        task_id:    RPETD task identifier (e.g., "TK-0041")

    Returns:
        StepHandoff — either loaded from PG or freshly initialized.
    """
    steps = WORKFLOW_STEPS.get(workflow, [])

    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, workflow_name, step_id, task_id, phase_number,"
                " completed_steps, context_snapshot, artifacts, decisions,"
                " user_inputs, next_step, escalation_flags, created_at"
                " FROM step_handoffs"
                " WHERE workflow_name = %s AND phase_number = %s AND task_id = %s"
                " ORDER BY created_at DESC LIMIT 1",
                (workflow, phase, task_id),
            )
            row = cur.fetchone()
        conn.close()

        if row:
            log.info("Loaded existing handoff id=%s step=%s", row[0], row[2])
            return StepHandoff(
                id=str(row[0]),
                workflow_name=row[1],
                step_id=row[2],
                task_id=row[3],
                phase_number=row[4],
                completed_steps=list(row[5] or []),
                context_snapshot=row[6] or {},
                artifacts=row[7] or {},
                decisions=list(row[8] or []),
                user_inputs=list(row[9] or []),
                next_step=row[10],
                escalation_flags=list(row[11] or []),
                created_at=row[12].isoformat() if row[12] else datetime.now(timezone.utc).isoformat(),
            )
    except Exception as exc:
        log.warning("PG unavailable, creating fresh handoff: %s", exc)

    # No existing record — create fresh
    first_step = steps[0] if steps else "step-01-init"
    second_step = steps[1] if len(steps) > 1 else None
    log.info("Creating fresh handoff workflow=%s phase=%s step=%s", workflow, phase, first_step)
    return StepHandoff(
        workflow_name=workflow,
        step_id=first_step,
        task_id=task_id,
        phase_number=phase,
        completed_steps=[],
        context_snapshot={},
        next_step=second_step,
    )


def save_handoff(handoff: StepHandoff) -> None:
    """Append-only INSERT of a StepHandoff into step_handoffs.

    Does NOT upsert — each step boundary creates a new row.
    Uses parameterized queries throughout.

    Args:
        handoff: StepHandoff object to persist.

    Raises:
        RuntimeError: If PG is unavailable.
        Exception:    If INSERT fails.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO step_handoffs"
                " (id, workflow_name, step_id, task_id, phase_number,"
                "  completed_steps, context_snapshot, artifacts,"
                "  decisions, user_inputs, next_step, escalation_flags)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    handoff.id,
                    handoff.workflow_name,
                    handoff.step_id,
                    handoff.task_id,
                    handoff.phase_number,
                    handoff.completed_steps,
                    json.dumps(handoff.context_snapshot),
                    json.dumps(handoff.artifacts),
                    json.dumps(handoff.decisions),
                    json.dumps(handoff.user_inputs),
                    handoff.next_step,
                    handoff.escalation_flags,
                ),
            )
        conn.commit()
        log.info("Saved handoff id=%s step=%s next=%s", handoff.id, handoff.step_id, handoff.next_step)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_next_step(handoff: StepHandoff) -> Optional[str]:
    """Return the next step file path, or None if the workflow is complete.

    Looks up workflow_name in WORKFLOW_STEPS, finds current step_id position,
    and returns "steps/{next_step}.md" or None if at the last step.

    Args:
        handoff: Current StepHandoff object.

    Returns:
        str: Relative path like "steps/step-02-research.md"
        None: If current step is the last step.
    """
    steps = WORKFLOW_STEPS.get(handoff.workflow_name)
    if not steps:
        log.warning("Unknown workflow: %s", handoff.workflow_name)
        return None

    try:
        idx = steps.index(handoff.step_id)
    except ValueError:
        log.warning("step_id %s not in WORKFLOW_STEPS[%s]", handoff.step_id, handoff.workflow_name)
        return None

    if idx + 1 >= len(steps):
        log.info("Workflow %s is complete after step %s", handoff.workflow_name, handoff.step_id)
        return None

    next_step = steps[idx + 1]
    return f"steps/{next_step}.md"


def rollback_step(handoff: StepHandoff, target_step: str) -> StepHandoff:
    """Roll back to a prior completed step.

    Validates target_step is in completed_steps, then creates a new StepHandoff
    with step_id = target_step and completed_steps truncated to before target_step.
    Saves the rollback record to PG.

    Args:
        handoff:      Current StepHandoff to roll back from.
        target_step:  The step_id to roll back to.

    Returns:
        Updated StepHandoff with truncated completed_steps.

    Raises:
        ValueError: If target_step is not in completed_steps.
    """
    if target_step not in handoff.completed_steps:
        raise ValueError(
            f"Cannot rollback to '{target_step}' — not in completed_steps: {handoff.completed_steps}"
        )

    # Truncate completed_steps to everything before target_step
    target_idx = handoff.completed_steps.index(target_step)
    truncated = handoff.completed_steps[:target_idx]

    # Recalculate next_step
    steps = WORKFLOW_STEPS.get(handoff.workflow_name, [])
    try:
        step_idx = steps.index(target_step)
        recalc_next = steps[step_idx + 1] if step_idx + 1 < len(steps) else None
    except ValueError:
        recalc_next = None

    rollback = StepHandoff(
        workflow_name=handoff.workflow_name,
        step_id=target_step,
        task_id=handoff.task_id,
        phase_number=handoff.phase_number,
        completed_steps=truncated,
        context_snapshot=handoff.context_snapshot,
        artifacts=handoff.artifacts,
        decisions=handoff.decisions,
        user_inputs=handoff.user_inputs,
        next_step=recalc_next,
        escalation_flags=handoff.escalation_flags + [f"ROLLBACK to {target_step}"],
    )

    log.info("Rolling back to step=%s completed_steps=%s", target_step, truncated)
    save_handoff(rollback)
    return rollback


def validate_handoff(handoff: StepHandoff) -> tuple:
    """Validate a StepHandoff object for structural and semantic correctness.

    Checks:
      - All required fields are present and non-empty
      - workflow_name is one of the 3 known workflows
      - step_id exists in WORKFLOW_STEPS[workflow_name]
      - context_snapshot is a dict
      - Serialized context_snapshot <= 600 tokens (~2400 chars)

    Args:
        handoff: StepHandoff to validate.

    Returns:
        tuple[bool, list[str]]: (is_valid, list of error messages)
    """
    errors = []

    # Required field checks
    if not getattr(handoff, "workflow_name", None):
        errors.append("workflow_name is required")
    if not getattr(handoff, "step_id", None):
        errors.append("step_id is required")
    if not getattr(handoff, "task_id", None):
        errors.append("task_id is required")
    if not getattr(handoff, "phase_number", None):
        errors.append("phase_number is required and must be >= 1")
    if getattr(handoff, "context_snapshot", None) is None:
        errors.append("context_snapshot is required")

    # Workflow name validation
    if handoff.workflow_name and handoff.workflow_name not in WORKFLOW_STEPS:
        errors.append(
            f"workflow_name '{handoff.workflow_name}' is not one of: {list(WORKFLOW_STEPS.keys())}"
        )

    # step_id validation
    if handoff.workflow_name and handoff.step_id:
        valid_steps = WORKFLOW_STEPS.get(handoff.workflow_name, [])
        if handoff.step_id not in valid_steps:
            errors.append(
                f"step_id '{handoff.step_id}' not in WORKFLOW_STEPS['{handoff.workflow_name}']: {valid_steps}"
            )

    # context_snapshot type and size
    if getattr(handoff, "context_snapshot", None) is not None:
        if not isinstance(handoff.context_snapshot, dict):
            errors.append("context_snapshot must be a dict")
        else:
            try:
                serialized = json.dumps(handoff.context_snapshot)
                if len(serialized) > _CONTEXT_SNAPSHOT_MAX_CHARS:
                    errors.append(
                        f"context_snapshot exceeds 600-token limit: {len(serialized)} chars "
                        f"(max {_CONTEXT_SNAPSHOT_MAX_CHARS})"
                    )
            except (TypeError, ValueError) as exc:
                errors.append(f"context_snapshot is not JSON-serializable: {exc}")

    is_valid = len(errors) == 0
    return (is_valid, errors)
