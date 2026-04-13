#!/usr/bin/env python3
"""
RPETDContext — structured context handoff between RPETD phases.

Phase 20 / HANDOFF-01: Each RPETD phase boundary produces a typed RPETDContext
object (<= 600 tokens) that replaces full conversation forwarding.

The 8 fields are designed per Attention Residuals application-layer principle:
original signal (original_intent) persists across ALL phases; derived context
(completed_work, current_state) is selectively aggregated per phase need.
"""

import hashlib
import json
from typing import Optional

try:
    from pydantic import BaseModel, Field, model_validator
except ImportError:
    # Fallback: if pydantic is not available, provide a minimal dataclass shim
    # that allows the module to be imported without crashing the daemon.
    import dataclasses
    import sys
    print("[rpetd_context] pydantic not available; using dataclass fallback", file=sys.stderr)

    class _FakeField:
        def __call__(self, **kwargs):
            return dataclasses.field(default=kwargs.get("default", dataclasses.MISSING),
                                      default_factory=kwargs.get("default_factory", dataclasses.MISSING))
    Field = _FakeField()

    class BaseModel:
        pass

    def model_validator(**kwargs):
        def decorator(fn):
            return fn
        return decorator


class RPETDContext(BaseModel):
    """Typed context object for RPETD phase handoffs.

    Exactly 8 fields. Compiled view must measure <= 600 tokens via tiktoken cl100k_base.
    Stored in PostgreSQL rpetd_context table after each phase boundary.
    """

    task_id: str = Field(..., description="Task identifier (e.g., TK-0051)")
    original_intent: str = Field(
        ...,
        description="Verbatim user request text — preserved across ALL phases (Attention Residuals: original signal persistence)"
    )
    completed_work: list[str] = Field(
        default_factory=list,
        description="List of completed actions from prior phases (e.g., ['R: found 3 relevant files', 'P: created plan with 2 tasks'])"
    )
    current_state: dict = Field(
        default_factory=dict,
        description="File paths and their status (e.g., {'services/pg_store.py': 'modified', 'tests/new_test.py': 'created'})"
    )
    active_constraints: list[str] = Field(
        default_factory=list,
        description="Active constraints and guardrails (e.g., ['scope ceiling: 40 LOC', 'no changes to amauta.py'])"
    )
    relevant_files: list[str] = Field(
        default_factory=list,
        description="File paths relevant to the current task (e.g., ['services/pg_store.py', 'migrations/009-rpetd-context.sql'])"
    )
    next_actions: list[str] = Field(
        default_factory=list,
        description="Ordered list of next steps for the upcoming phase (e.g., ['implement compaction function', 'add daemon endpoint'])"
    )
    context_version: str = Field(
        default="",
        description="SHA-256 hex digest of the serialized context (excluding this field) — enables staleness detection in Phase 21"
    )

    @model_validator(mode="after")
    def compute_context_version(self):
        """Auto-compute context_version as SHA-256 of the other 7 fields."""
        payload = {
            "task_id": self.task_id,
            "original_intent": self.original_intent,
            "completed_work": self.completed_work,
            "current_state": self.current_state,
            "active_constraints": self.active_constraints,
            "relevant_files": self.relevant_files,
            "next_actions": self.next_actions,
        }
        serialized = json.dumps(payload, sort_keys=True, default=str)
        self.context_version = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        return self

    def to_compiled_view(self) -> dict:
        """Return the full model as a JSON-serializable dict for storage."""
        return self.model_dump()

    @classmethod
    def from_compiled_view(cls, data: dict) -> "RPETDContext":
        """Reconstruct an RPETDContext from a stored compiled_view dict."""
        return cls(**data)
