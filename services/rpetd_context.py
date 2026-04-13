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


# ─── Compaction Functions (Phase 20 / HANDOFF-02) ────────────────────────────


def prune_messages(messages, max_tokens=40000):
    """Prune old tool outputs from conversation messages.

    Phase 20 / HANDOFF-02 prune step: removes tool_result and tool_use content
    blocks from messages older than the token budget, keeping only the most
    recent messages that fit within max_tokens.

    Token counting: uses tiktoken cl100k_base if available, otherwise
    approximates at 4 chars per token.

    Args:
        messages: list[dict] — raw conversation messages in Claude API format.
            Each message has 'role' and 'content' keys.
        max_tokens: int — maximum token budget for pruned output (default 40K).

    Returns:
        list[dict] — pruned messages, most recent first up to max_tokens.
    """
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        def count_tokens(text):
            return len(enc.encode(text)) if isinstance(text, str) else len(enc.encode(str(text)))
    except ImportError:
        def count_tokens(text):
            return len(str(text)) // 4  # Approximate: 4 chars per token

    # Work backward from most recent messages
    pruned = []
    total_tokens = 0
    for msg in reversed(messages):
        content = msg.get("content", "")
        if isinstance(content, list):
            # Filter out tool_result and tool_use blocks from older messages
            if total_tokens > max_tokens * 0.5:
                # We're past the halfway point — strip tool content from older messages
                filtered_blocks = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") in ("tool_result", "tool_use"):
                        continue
                    filtered_blocks.append(block)
                content_str = json.dumps(filtered_blocks)
            else:
                content_str = json.dumps(content)
        else:
            content_str = str(content)

        msg_tokens = count_tokens(content_str)
        if total_tokens + msg_tokens > max_tokens:
            break
        pruned.append(msg)
        total_tokens += msg_tokens

    # Restore chronological order
    pruned.reverse()
    return pruned


# Compaction prompt template — structured extraction into RPETDContext fields
COMPACTION_PROMPT = """You are a context compactor for an RPETD task management system.

Extract the following 8 fields from the conversation below. Output ONLY valid JSON, no markdown fences.

Fields:
1. task_id: "{task_id}" (use this exact value)
2. original_intent: The user's original request in their exact words (first user message)
3. completed_work: Array of strings — what has been done so far, one entry per phase (e.g., "R: found 3 relevant files")
4. current_state: Object mapping file paths to status ("modified", "created", "analyzed", "unchanged")
5. active_constraints: Array of strings — scope ceilings, guardrails, rules in effect
6. relevant_files: Array of file paths that are relevant to this task
7. next_actions: Array of strings — ordered next steps for the upcoming phase
8. context_version: "" (will be auto-computed)

Conversation:
{conversation}

Output the JSON object with exactly these 8 keys. Be concise — total output must be under 500 tokens."""


def compact_conversation(messages, task_id, phase, llm_call=None):
    """Compact raw conversation into a structured RPETDContext.

    Phase 20 / HANDOFF-02: Two-step compaction:
    1. Prune: remove old tool outputs (prune_messages)
    2. Compact: LLM-summarize into RPETDContext fields

    Args:
        messages: list[dict] — raw conversation messages.
        task_id: str — task identifier for the context.
        phase: str — current RPETD phase letter.
        llm_call: callable or None — function(prompt) -> str that calls an LLM.
            If None, uses the fallback extraction path.

    Returns:
        RPETDContext instance.
    """
    # Step 1: Prune
    pruned = prune_messages(messages)

    # Step 2: Format conversation for compaction
    conversation_text = ""
    for msg in pruned:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        if isinstance(content, list):
            # Flatten content blocks to text
            parts = []
            for block in content:
                if isinstance(block, dict):
                    parts.append(block.get("text", str(block)))
                else:
                    parts.append(str(block))
            content = " ".join(parts)
        conversation_text += f"[{role}]: {content}\n\n"

    # Truncate conversation text to ~3000 chars to keep compaction prompt small
    if len(conversation_text) > 3000:
        conversation_text = conversation_text[:1500] + "\n...[truncated]...\n" + conversation_text[-1500:]

    # Step 3: LLM compaction or fallback
    if llm_call is not None:
        try:
            prompt = COMPACTION_PROMPT.format(
                task_id=task_id,
                conversation=conversation_text,
            )
            response = llm_call(prompt)

            # Parse LLM response as JSON
            # Strip markdown fences if present
            cleaned = response.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()

            data = json.loads(cleaned)
            data["task_id"] = task_id  # Ensure task_id is correct
            return RPETDContext(**data)
        except Exception:
            pass  # Fall through to fallback

    # Fallback: extract best-effort context from the last 3 messages
    return _fallback_extract(messages, task_id, phase)


def _fallback_extract(messages, task_id, phase):
    """Best-effort RPETDContext extraction when LLM compaction fails.

    Extracts original_intent from first user message, and constructs
    minimal completed_work / next_actions from recent messages.

    Args:
        messages: list[dict] — raw conversation messages.
        task_id: str — task identifier.
        phase: str — current RPETD phase letter.

    Returns:
        RPETDContext instance with best-effort field population.
    """
    # Find original intent (first user message)
    original_intent = "Unknown intent"
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                texts = [b.get("text", "") for b in content if isinstance(b, dict)]
                content = " ".join(texts)
            original_intent = str(content)[:500]
            break

    # Build completed_work from last 3 assistant messages
    completed_work = []
    assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
    for msg in assistant_msgs[-3:]:
        content = msg.get("content", "")
        if isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict)]
            content = " ".join(texts)
        summary = str(content)[:200]
        if summary.strip():
            completed_work.append(f"{phase}: {summary}")

    return RPETDContext(
        task_id=task_id,
        original_intent=original_intent,
        completed_work=completed_work,
        next_actions=[f"Continue {phase}-phase execution"],
    )
