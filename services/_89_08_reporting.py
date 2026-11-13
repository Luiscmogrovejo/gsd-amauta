"""services/_89_08_reporting.py — the embedding models, in `doctor` and `/health`.

Phase 89 plan 89-08 (RET-05). The embedding and rerank models are settings
validated against a pinned catalogue, and a model change is a blue/green
re-embed. This module says, in the two places an operator looks:

    doctor   FAIL  embedding_catalogue  the configured model is not in the catalogue
             WARN  embedding_catalogue  the catalogue has not been re-verified for 90 days
             WARN  embedding_catalogue  an OLDER model is configured, with the exact
                                        `config-set` that moves to the current one
             WARN  embedding_state      a re-embed is in progress (phase per use)
             OK    ...                  otherwise

    /health  {"extra": {"embeddings": {"models": {...}, "state": {...}}}}

It is contributed through plan 89-09's hooks (``services/report_hooks.py``): this
plan edits neither ``services/doctor.py`` nor ``services/amauta-daemon.py``.
``HEALTH_KEY`` names the fragment, so the public ``/health`` payload does not
carry a plan number (the fix plan 89-06 made and asked of this plan).

Voyage publishes no model-list endpoint, so nothing here "discovers" a newer
model: the only automatable check is the configured model AGAINST THE CATALOGUE,
and the catalogue's own age. See docs/EMBEDDING-MODELS.md.

SILENT WITHOUT A POSTGRESQL
───────────────────────────
Vectors exist only in PostgreSQL. On an install pinned to SQLite, or with no DSN
configured, there is no vector an embedding model could have produced, so this
module contributes NOTHING — the same rule ``_89_06_reporting`` follows for the
lexical engine. A row about a setting that governs nothing would be noise in
every degraded install's ``doctor``.

Example:
    >>> doctor_rows({"GSD_FORCE_SQLITE": "1"})
    []
"""
import datetime
import logging
import os

try:
    from services import harness_config, report_hooks
except ImportError:  # pragma: no cover - script-launched from services/
    import harness_config
    import report_hooks

log = logging.getLogger(__name__)

#: The name this module's ``/health`` fragment is published under.
HEALTH_KEY = "embeddings"

CATEGORY_CATALOGUE = "embedding_catalogue"
CATEGORY_STATE = "embedding_state"

#: A catalogue record not re-verified for this long is reported.
STALE_AFTER_DAYS = int(os.environ.get("GSD_EMBEDDING_CATALOGUE_STALE_DAYS", "90"))

DOCS = "docs/EMBEDDING-MODELS.md"

#: Reporting must not hang `doctor` on an unreachable database.
STATE_CONNECT_TIMEOUT_SECONDS = int(os.environ.get(
    "GSD_REPORT_PG_CONNECT_TIMEOUT_SECONDS", "3"))

_MODEL_KEYS = tuple(k for k, spec in harness_config.HARNESS_KEYS.items()
                    if spec["type"] == "model")


def _parse_date(value):
    try:
        return datetime.date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _successor(record, catalogue, use=None):
    """The ``current`` model to move to: the use's catalogue default when it
    qualifies (same kind, provider and dimension), else the cheapest that does."""
    candidates = [
        m for m in catalogue["models"]
        if m.get("status") == "current" and m.get("kind") == record.get("kind")
        and m.get("default_dimension") == record.get("default_dimension")
        and m.get("provider") == record.get("provider") and m["id"] != record["id"]
    ]
    if not candidates:
        return None
    preferred = (catalogue.get("uses", {}).get(use) or {}).get("default")
    for candidate in candidates:
        if candidate["id"] == preferred:
            return candidate
    return sorted(candidates, key=lambda m: (m.get("price_per_mtok") or 0, m["id"]))[0]


def resolve(env=None, today=None):
    """Everything both readers report, computed once.

    Args:
        env: mapping to read; ``os.environ`` when omitted.
        today: the date staleness is measured from (tests pass one).

    Returns:
        dict: ``{"models": {key: {...}}, "problems": [(status, category, detail,
        data)], "state": {use: {...}} | None, "state_reason": str | None}``, or
        None when no PostgreSQL is configured (see the module docstring).
    """
    env = os.environ if env is None else env
    if not harness_config._state_dsn(env):  # noqa: SLF001 - the one DSN resolver
        return None
    today = today or datetime.date.today()
    models, problems = {}, []
    try:
        catalogue = harness_config.load_catalogue(env=env)
    except harness_config.HarnessConfigError as exc:
        return {"models": {}, "state": None, "state_reason": "catalogue_unreadable",
                "problems": [(report_hooks.STATUS_FAIL, CATEGORY_CATALOGUE,
                              exc.message, exc.to_dict())]}

    for key in _MODEL_KEYS:
        try:
            row = harness_config.resolve(key, env=env)
        except harness_config.HarnessConfigError as exc:
            problems.append((
                report_hooks.STATUS_FAIL, CATEGORY_CATALOGUE,
                "%s: %s" % (key, exc.message), exc.to_dict()))
            models[key] = {"error": exc.code}
            continue
        record = harness_config.model_record(row["value"], catalogue)
        models[key] = {"value": row["value"], "default": row["default"],
                       "source": row["source"], "status": record.get("status"),
                       "verified_at": record.get("verified_at")}
        verified = _parse_date(record.get("verified_at"))
        if verified is None:
            problems.append((
                report_hooks.STATUS_WARN, CATEGORY_CATALOGUE,
                "the catalogue record of %s (%s) has never been verified; see %s"
                % (row["value"], key, DOCS),
                {"key": key, "model": row["value"], "verified_at": None}))
        elif (today - verified).days > STALE_AFTER_DAYS:
            problems.append((
                report_hooks.STATUS_WARN, CATEGORY_CATALOGUE,
                "the embedding model catalogue has not been re-verified since %s "
                "(%s, used by %s); see %s"
                % (verified.isoformat(), row["value"], key, DOCS),
                {"key": key, "model": row["value"],
                 "verified_at": verified.isoformat(),
                 "age_days": (today - verified).days}))
        if record.get("status") == "older":
            successor = _successor(record, catalogue,
                                   harness_config.HARNESS_KEYS[key]["use"])
            if successor is not None:
                command = "config-set %s %s" % (key, successor["id"])
                consequence = ("starts a re-embed" if record.get("kind") == "embed"
                               else "takes effect at once")
                problems.append((
                    report_hooks.STATUS_WARN, CATEGORY_CATALOGUE,
                    "%s is an older model, superseded by %s ($%s per million tokens "
                    "against $%s); `%s` %s"
                    % (row["value"], successor["id"], successor.get("price_per_mtok"),
                       record.get("price_per_mtok"), command, consequence),
                    {"key": key, "model": row["value"], "successor": successor["id"],
                     "command": command}))

    states, reason = harness_config.read_states(
        env=env, connect_timeout=STATE_CONNECT_TIMEOUT_SECONDS)
    state = None
    if states is not None:
        state = {use: {"active_model": s.get("active_model"),
                       "target_model": s.get("target_model"),
                       "phase": s.get("phase"), "rows_total": s.get("rows_total"),
                       "rows_done": s.get("rows_done"),
                       "tokens_spent": s.get("tokens_spent"),
                       "budget_tokens": s.get("budget_tokens")}
                 for use, s in sorted(states.items())}
    return {"models": models, "problems": problems, "state": state,
            "state_reason": reason}


def health_fragment(env=None):
    """The ``/health`` fragment under :data:`HEALTH_KEY`.

    Returns:
        dict: ``{"models": {...}, "state": {...}|None, "state_reason": ...,
        "degraded": bool, "problems": [detail, ...]}``.

    Example:
        >>> health_fragment({"GSD_FORCE_SQLITE": "1"}) is None
        True
    """
    answer = resolve(env)
    if answer is None:
        return None
    pending = any((s or {}).get("phase") not in (None, "steady")
                  for s in (answer["state"] or {}).values())
    return {
        "models": answer["models"],
        "state": answer["state"],
        "state_reason": answer["state_reason"],
        "reembed_pending": pending,
        "degraded": bool(answer["problems"]),
        "problems": [detail for _status, _category, detail, _data in answer["problems"]],
    }


def doctor_rows(env=None, today=None):
    """The ``doctor`` rows: catalogue problems, then ``embedding_state`` per use.

    Args:
        env: mapping to read; ``os.environ`` when omitted.
        today: the date staleness is measured from (tests pass one).

    Returns:
        list: ``(status, category, detail, data)`` tuples in ``doctor``'s own
        vocabulary; empty when no PostgreSQL is configured, otherwise at
        least one row for the catalogue.
    """
    answer = resolve(env, today=today)
    if answer is None:
        return []
    rows = list(answer["problems"])
    if not any(r[1] == CATEGORY_CATALOGUE for r in rows):
        summary = ", ".join("%s=%s" % (k.rsplit(".", 1)[-1] if "rerank" not in k
                                       else "rerank", v.get("value"))
                            for k, v in answer["models"].items())
        rows.append((report_hooks.STATUS_OK, CATEGORY_CATALOGUE,
                     "configured models are current catalogue entries (%s)" % summary,
                     {"models": answer["models"]}))
    if answer["state"] is None:
        rows.append((report_hooks.STATUS_OK, CATEGORY_STATE,
                     "no embedding_state to report (%s)" % answer["state_reason"],
                     {"reason": answer["state_reason"]}))
        return rows
    for use, state in answer["state"].items():
        if state["phase"] == "steady":
            rows.append((report_hooks.STATUS_OK, CATEGORY_STATE,
                         "%s: phase steady on %s" % (use, state["active_model"]), state))
        else:
            rows.append((
                report_hooks.STATUS_WARN, CATEGORY_STATE,
                "%s: phase %s — %s of %s rows re-embedded for %s, %s tokens spent; "
                "queries still answer from %s"
                % (use, state["phase"], state["rows_done"], state["rows_total"],
                   state["target_model"], state["tokens_spent"], state["active_model"]),
                state))
    return rows
