#!/usr/bin/env python3
"""services/embedding_backfill.py — the re-embed job, the cutover, and the mixed-model refusal.

Phase 89 plan 89-08 (RET-05; decisions 5, D5 and fact F1 of 89-CONTEXT.md).

THE RULE THIS MODULE ENFORCES
─────────────────────────────
No query ever compares vectors of two models. Every vector column has a twin
(``<col>_next``) and every row records which model produced each of the two
(``embedding_model``, ``embedding_model_next`` — migration 034). One row per use
in ``embedding_state`` says which model is LIVE (``active_model``) and which is
being built (``target_model``).

TWO MODES, CHOSEN BY THE STATE, NEVER BY A FLAG
───────────────────────────────────────────────
* **fill** — the configured model IS the active one. Rows that have no vector,
  or a vector of another or unknown model, are embedded IN PLACE with the active
  model. This is what repairs a store that refuses with ``embedding_model_mixed``
  and what fills a freshly rebuilt database.
* **blue_green** — the configured model differs from the active one. Vectors are
  built in ``<col>_next`` while queries keep answering from ``<col>``. When none
  is missing the phase becomes ``cutover_ready`` and ``cutover`` swaps the two
  columns in one transaction, after a relevance comparison.

In both modes the vector and its model are written by ONE UPDATE, so a vector can
never exist without its provenance.

THE JOB IS COUNTED BEFORE IT SPENDS (D5)
────────────────────────────────────────
A run prints the token total first. It refuses without ``--budget-tokens``,
refuses when the count exceeds the budget (naming both numbers), and refuses a
budget above the model's free allowance unless ``--allow-paid`` is given.
``--count-only`` prints and spends nothing.

For ``--use code_index --count-only`` the number is the INGESTION CORPUS counted
from the source trees by ``services/rlm_ingestion.count_corpus_tokens`` (the same
walk, the same eligibility rule, the same ``content[:8192]`` truncation) — NOT
the rows of ``rlm_chunks``, which on a freshly rebuilt database is empty and
would count zero.

IT NEVER ASSUMES A RATE (F1)
────────────────────────────
The provider's limit is discovered from its answers. A 429 is honoured through
its ``Retry-After`` header when there is one and through exponential backoff
with jitter when there is not; a batch that is refused twice is halved, because a
tokens-per-minute limit smaller than one batch can never be satisfied by waiting.
The pace is then held at what the provider accepted. After the first few
requests the job prints the MEASURED rate and the estimated duration at that
rate, and ``--max-duration-seconds`` stops it there (resumable) when the estimate
is longer than the operator allowed.

IDEMPOTENT, RESUMABLE, SINGLE-FLIGHT
────────────────────────────────────
The cursor is the predicate itself ("rows that still need a vector"), so a run
that dies continues where it stopped. ``pg_try_advisory_lock`` on
``hashtext('embed:' || use)`` makes a second concurrent run exit with
``backfill_already_running``; the lock is released by PostgreSQL when the session
ends, so a crash cannot leave it held.

Exit codes: 0 done · 1 internal error · 2 refused (budget, validation, missing
argument) · 3 ``backfill_already_running`` · 4 incomplete but resumable (rate
limit, budget exhausted mid-run, duration limit, interruption) · 5 cutover
refused (incomplete backfill or worse relevance).

Example:
    >>> EXIT_REFUSED, EXIT_ALREADY_RUNNING, EXIT_INCOMPLETE, EXIT_CUTOVER_REFUSED
    (2, 3, 4, 5)
"""
import argparse
import collections
import datetime
import json
import logging
import os
import pathlib
import random
import sys
import threading
import time
import urllib.error
import urllib.request

if __name__ == "__main__" and not __package__:  # launched as a script: ONE module identity
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

try:
    from services import harness_config
except ImportError:  # pragma: no cover - imported with services/ itself on sys.path
    import harness_config

log = logging.getLogger("amauta.embedding_backfill")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2
EXIT_ALREADY_RUNNING = 3
EXIT_INCOMPLETE = 4
EXIT_CUTOVER_REFUSED = 5

USES = (harness_config.USE_MEMORY, harness_config.USE_CODE_INDEX)

PHASE_STEADY = "steady"
PHASE_BACKFILLING = "backfilling"
PHASE_CUTOVER_READY = "cutover_ready"

MODE_FILL = "fill"
MODE_BLUE_GREEN = "blue_green"

#: Voyage's own recommendation for documents per request; the per-request token
#: cap of the model is applied on top of it, whichever is smaller.
DEFAULT_BATCH_SIZE = int(os.environ.get("GSD_EMBED_BATCH_SIZE", "128"))
#: Fraction of the model's per-request token cap a batch may fill (the count is
#: an estimate, so the cap is not approached).
REQUEST_CAP_FRACTION = 0.8
DEFAULT_MAX_RETRIES = int(os.environ.get("GSD_EMBED_MAX_RETRIES", "8"))
BACKOFF_BASE_SECONDS = float(os.environ.get("GSD_EMBED_BACKOFF_BASE_SECONDS", "2"))
BACKOFF_CAP_SECONDS = float(os.environ.get("GSD_EMBED_BACKOFF_CAP_SECONDS", "120"))
HTTP_TIMEOUT_SECONDS = float(os.environ.get("GSD_EMBED_HTTP_TIMEOUT_SECONDS", "60"))
VOYAGE_EMBEDDINGS_URL = os.environ.get(
    "GSD_VOYAGE_EMBEDDINGS_URL", "https://api.voyageai.com/v1/embeddings")
OPENAI_EMBEDDINGS_URL = os.environ.get(
    "GSD_OPENAI_EMBEDDINGS_URL", "https://api.openai.com/v1/embeddings")
#: Requests the rate is measured over before the duration estimate is printed.
CALIBRATION_REQUESTS = 3
RELEVANCE_SAMPLE = int(os.environ.get("GSD_EMBED_RELEVANCE_SAMPLE", "20"))
RELEVANCE_K = 5

#: The script path a remedy names. ``gsd-tools embeddings ...`` (plan 89-11)
#: forwards to exactly this file.
SCRIPT = "services/embedding_backfill.py"

TableSpec = collections.namedtuple(
    "TableSpec", "table id_column vector_column text_column max_chars input_type")

#: Every vector column, by use. ``text_column`` None = the source text was never
#: stored (task_completions embeds a feature vector the row does not keep), so the
#: column cannot be re-embedded: it takes part in the cutover swap and comes out
#: of it empty rather than mixed.
USE_TABLES = {
    harness_config.USE_MEMORY: (
        TableSpec("gsd_memory", "id", "embedding", "text", 32000, "document"),
        TableSpec("gsd_memory_archive", "id", "embedding", "text", 32000, "document"),
        TableSpec("semantic_cache", "id", "query_embedding", "query_text", 32000, "query"),
        TableSpec("skill_invocations", "id", "context_embedding", "invocation_text",
                  32000, "document"),
        TableSpec("task_completions", "id", "embedding", None, 0, "document"),
    ),
    harness_config.USE_CODE_INDEX: (
        TableSpec("rlm_chunks", "id", "embedding_code", "content", 8192, "document"),
    ),
}


# ── typed errors ─────────────────────────────────────────────────────────────

class BackfillError(Exception):
    """A typed refusal or failure: ``{error, message, ...details}``.

    Args:
        code: machine-readable reason, also the ``error`` field of the payload.
        message: one sentence a person can act on.
        exit_code: the process exit status the CLI maps it to.
        details: structured context merged into the payload.
    """

    def __init__(self, code, message, exit_code=EXIT_REFUSED, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details

    def to_dict(self):
        """Returns: dict payload with ``error`` and ``message`` first."""
        payload = {"error": self.code, "message": self.message}
        payload.update(self.details)
        return payload


class StateTableAbsent(BackfillError):
    """``embedding_state`` does not exist: migration 034 has not been applied."""

    def __init__(self):
        super().__init__(
            "embedding_state_absent",
            "the embedding_state table does not exist; apply the migrations "
            "(034-embedding-blue-green.sql) first",
            exit_code=EXIT_REFUSED)


class DatabaseUnreachable(BackfillError):
    """The configured PostgreSQL did not accept a connection."""

    def __init__(self, reason):
        super().__init__(
            "database_unreachable",
            "the configured PostgreSQL did not accept a connection (%s); nothing "
            "was read or written" % reason, exit_code=EXIT_REFUSED)


class EmbeddingModelMixedError(Exception):
    """A vector query was REFUSED because the table holds another model's vectors.

    Answering with fewer rows would be worse than failing: a mixed store returns
    plausible nonsense. The payload names the table, the active model, every
    offending model with its row count, and the commands that repair it.

    Attributes:
        payload: ``{"error": "embedding_model_mixed", "table", "column", "use",
            "active_model", "offending_models", "offending_rows_by_model", "rows",
            "remedy", "remedy_steps"}``.
    """

    code = "embedding_model_mixed"

    def __init__(self, payload):
        super().__init__(
            "%s holds %d vector(s) not produced by the active model %s: %s"
            % (payload["table"], payload["rows"], payload["active_model"],
               payload["remedy"]))
        self.payload = payload

    def to_dict(self):
        """Returns: the typed payload (a copy)."""
        return dict(self.payload)


class RateLimited(Exception):
    """The provider answered 429.

    Args:
        retry_after: seconds from the ``Retry-After`` header, or None.
        detail: the provider's own message, truncated.
    """

    def __init__(self, retry_after=None, detail=""):
        super().__init__(detail or "rate limited")
        self.retry_after = retry_after
        self.detail = detail


class ProviderError(Exception):
    """The provider failed in a way that waiting will not fix."""


# ── small helpers ────────────────────────────────────────────────────────────

def _connect(dsn, autocommit=False, connect_timeout=None):
    import psycopg2

    try:
        conn = psycopg2.connect(dsn, connect_timeout=int(connect_timeout or os.environ.get(
            "GSD_PG_CONNECT_TIMEOUT_SECONDS", "10")))
    except psycopg2.OperationalError as exc:
        # Typed, and without the DSN: the driver's message can carry a host.
        raise DatabaseUnreachable(type(exc).__name__)
    conn.autocommit = autocommit
    return conn


def _resolve_dsn(dsn=None, env=None):
    """The DSN to work on. Never guesses one.

    Raises:
        BackfillError: ``no_database`` when nothing is configured or the backend
            is pinned to SQLite (SQLite stores no vectors, so there is nothing to
            re-embed).
    """
    if dsn:
        return dsn
    resolved = harness_config._state_dsn(env)  # noqa: SLF001 - one resolver, two callers
    if not resolved:
        raise BackfillError(
            "no_database",
            "no PostgreSQL is configured (GSD_POSTGRES_URL is unset or the backend "
            "is pinned to SQLite); vectors exist only in PostgreSQL",
            exit_code=EXIT_REFUSED)
    return resolved


def _conn_key(conn):
    """A cache key for one live connection, or None for a stand-in."""
    try:
        return (id(conn), conn.get_backend_pid(), conn.dsn)
    except Exception:  # noqa: BLE001 - a test double: never cached
        return None


def _vector_literal(vector):
    return "[" + ",".join(repr(float(v)) for v in vector) + "]"


def _pause(seconds):
    """Wait *seconds* (the default ``pause`` of the pacer; tests inject their own)."""
    if seconds > 0:
        threading.Event().wait(seconds)


def _audit(cur, event_type, status, content, metadata, actor=None):
    cur.execute(
        "INSERT INTO gsd_audit_log (task_id, event_type, agent_id, actor, status, "
        "content, metadata) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)",
        ("embeddings", event_type, "embedding_backfill",
         actor or os.environ.get("GSD_AGENT_NAME") or "operator",
         status, content, json.dumps(metadata, default=str)))


def _text_predicate(spec):
    return "%s IS NOT NULL AND btrim(%s) <> ''" % (spec.text_column, spec.text_column)


def _tokens_sql(spec, chars_per_token):
    return ("COALESCE(SUM(CEIL(char_length(left(%s, %d))::numeric / %d)), 0)"
            % (spec.text_column, spec.max_chars, chars_per_token))


def _chars_per_token():
    try:
        return max(1, int(harness_config.load_catalogue()["token_estimate"]["chars_per_token"]))
    except Exception:  # noqa: BLE001 - the estimator's own default
        return 3


# ── embedding_state ──────────────────────────────────────────────────────────

_STATE_COLUMNS = ("use", "active_model", "target_model", "previous_model", "phase",
                  "started_at", "rows_total", "rows_done", "tokens_spent",
                  "budget_tokens", "updated_at")


def read_states(conn):
    """Every ``embedding_state`` row, keyed by use.

    Raises:
        StateTableAbsent: when migration 034 has not been applied.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('embedding_state') IS NOT NULL")
        if not cur.fetchone()[0]:
            raise StateTableAbsent()
        cur.execute("SELECT %s FROM embedding_state" % ", ".join(_STATE_COLUMNS))
        rows = cur.fetchall()
    return {row[0]: dict(zip(_STATE_COLUMNS, row)) for row in rows}


def read_states_for_dsn(dsn, connect_timeout=None):
    """:func:`read_states` on a short-lived connection."""
    conn = _connect(dsn, autocommit=True, connect_timeout=connect_timeout)
    try:
        return read_states(conn)
    finally:
        conn.close()


def _state(conn, use):
    state = read_states(conn).get(use)
    if state is None:
        raise BackfillError(
            "embedding_state_absent",
            "embedding_state has no row for use %r; re-apply migration 034" % use,
            exit_code=EXIT_REFUSED, use=use)
    return state


def mark_target(conn, use, model, actor=None):
    """Record that *model* is now the DESIRED model for *use*. Never switches it.

    * the same as ``active_model``: nothing is pending — ``target_model`` is
      cleared and the phase returns to ``steady``;
    * a different embedding model: ``target_model = model``,
      ``phase = 'backfilling'``; ``active_model`` is NOT touched;
    * ``rerank``: there are no vectors to rebuild, so the model takes effect.

    Returns:
        dict: ``{active_model, target_model, phase}`` after the change.
    """
    state = _state(conn, use)
    with conn.cursor() as cur:
        if use == harness_config.USE_RERANK:
            cur.execute(
                "UPDATE embedding_state SET previous_model = active_model, "
                "active_model = %s, target_model = NULL, phase = 'steady', "
                "updated_at = NOW() WHERE use = %s AND active_model <> %s",
                (model, use, model))
        elif model == state["active_model"]:
            cur.execute(
                "UPDATE embedding_state SET target_model = NULL, phase = 'steady', "
                "updated_at = NOW() WHERE use = %s", (use,))
        elif model != state["target_model"]:
            cur.execute(
                "UPDATE embedding_state SET target_model = %s, phase = 'backfilling', "
                "started_at = NOW(), rows_total = 0, rows_done = 0, tokens_spent = 0, "
                "budget_tokens = NULL, updated_at = NOW() WHERE use = %s", (model, use))
        _audit(cur, "embedding_target_set", "ok",
               "%s: desired model set to %s" % (use, model),
               {"use": use, "model": model, "active_model": state["active_model"]},
               actor=actor)
    conn.commit()
    _ACTIVE_MEMO.clear()
    after = _state(conn, use)
    return {k: after[k] for k in ("active_model", "target_model", "phase")}


def mark_target_for_dsn(dsn, use, model, actor=None):
    """:func:`mark_target` on a short-lived connection (called by ``config-set``)."""
    conn = _connect(dsn)
    try:
        return mark_target(conn, use, model, actor=actor)
    finally:
        conn.close()


#: ``{conn key: (monotonic time, {use: active_model})}``. A cutover in another
#: process must become visible, so the answer is trusted only briefly.
_ACTIVE_MEMO = {}
ACTIVE_MEMO_SECONDS = float(os.environ.get("GSD_EMBED_STATE_CACHE_SECONDS", "30"))


def active_model_for(conn, use):
    """The LIVE model for *use* on this store, or None when the store has no state.

    None means migration 034 is not applied (or the connection is a stand-in):
    the caller keeps its pre-034 behaviour. Never raises.
    """
    key = _conn_key(conn)
    if key is None:
        return None
    hit = _ACTIVE_MEMO.get(key)
    now = time.monotonic()
    if hit is not None and now - hit[0] < ACTIVE_MEMO_SECONDS:
        return hit[1].get(use)
    try:
        states = read_states(conn)
        answer = {u: s["active_model"] for u, s in states.items()}
    except Exception as exc:  # noqa: BLE001 - "no state" is an answer here
        log.debug("embedding_state_unreadable error=%s", type(exc).__name__)
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        answer = {}
    if len(_ACTIVE_MEMO) > 64:
        _ACTIVE_MEMO.clear()
    _ACTIVE_MEMO[key] = (now, answer)
    return answer.get(use)


# ── the mixed-model refusal ──────────────────────────────────────────────────

#: Connections on which a table was found to hold ONLY the active model's
#: vectors. Only the clean verdict is remembered: a refusal is re-measured every
#: time, so repairing the store makes the next query answer.
_SINGLE_MODEL_OK = set()

#: Marker the statement carries, so a test can count how often the check ran.
MIXED_CHECK_MARKER = "/* embedding_model_mixed check */"


def reset_caches():
    """Forget every per-connection answer (tests, and after a cutover)."""
    _ACTIVE_MEMO.clear()
    _SINGLE_MODEL_OK.clear()


def remedy_steps(use):
    """The commands that repair a mixed store, as argv lists.

    Step 1 prints ``tokens_total``; step 2 takes it (or more) as its budget.
    ``{tokens_total}`` is the one placeholder.
    """
    return [
        {"argv": [SCRIPT, "backfill", "--use", use, "--count-only"],
         "produces": "tokens_total"},
        {"argv": [SCRIPT, "backfill", "--use", use, "--budget-tokens", "{tokens_total}"],
         "needs": "tokens_total"},
    ]


def assert_single_model(conn, use, table, vector_column, active_model):
    """Refuse when *table* holds a vector that *active_model* did not produce.

    A NULL ``embedding_model`` on a row that carries a vector is OFFENDING, not
    "unknown and therefore acceptable": after migration 034 every writer records
    the model in the statement that writes the vector, so a NULL is a vector whose
    origin nobody can vouch for, and accepting it is exactly how a mixed store
    would keep answering.

    The clean verdict is cached per connection; a refusal is never cached.

    Args:
        conn: a psycopg2 connection.
        use: ``memory`` or ``code_index`` (names the remedy).
        table: the table about to be searched.
        vector_column: its live vector column.
        active_model: the model whose vectors the query will compare against.

    Raises:
        EmbeddingModelMixedError: with the typed payload.
    """
    key = _conn_key(conn)
    memo = (key, table, vector_column, active_model) if key is not None else None
    if memo is not None and memo in _SINGLE_MODEL_OK:
        return
    with conn.cursor() as cur:
        cur.execute(
            MIXED_CHECK_MARKER +
            " SELECT embedding_model, COUNT(*) FROM %s"
            " WHERE %s IS NOT NULL"
            " AND (embedding_model IS NULL OR embedding_model <> %%s)"
            " GROUP BY embedding_model ORDER BY COUNT(*) DESC" % (table, vector_column),
            (active_model,))
        rows = cur.fetchall()
    if not rows:
        if memo is not None:
            if len(_SINGLE_MODEL_OK) > 256:
                _SINGLE_MODEL_OK.clear()
            _SINGLE_MODEL_OK.add(memo)
        return
    by_model = {(model if model is not None else "<unknown: NULL provenance>"): int(count)
                for model, count in rows}
    steps = remedy_steps(use)
    raise EmbeddingModelMixedError({
        "error": EmbeddingModelMixedError.code,
        "table": table,
        "column": vector_column,
        "use": use,
        "active_model": active_model,
        "offending_models": list(by_model),
        "offending_rows_by_model": by_model,
        "rows": sum(by_model.values()),
        "remedy": "%s ; then: %s" % (" ".join(steps[0]["argv"]),
                                      " ".join(steps[1]["argv"])),
        "remedy_steps": steps,
    })


# ── providers ────────────────────────────────────────────────────────────────

_BATCH_PROVIDER_OVERRIDE = None


def set_batch_provider_override(provider):
    """Install (or clear) the batch-provider override; returns the previous one.

    The provider is ``(texts, model, input_type) -> {"embeddings": [...],
    "total_tokens": int | None}`` and may raise :class:`RateLimited`. Never set
    in production: it is the seam the deterministic stand-in enters through.
    """
    global _BATCH_PROVIDER_OVERRIDE
    previous = _BATCH_PROVIDER_OVERRIDE
    _BATCH_PROVIDER_OVERRIDE = provider
    return previous


def _http_embed(url, key_env, body):
    api_key = os.environ.get(key_env, "")
    if not api_key:
        raise ProviderError("%s is not set" % key_env)
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
        method="POST")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001 - the status is what matters
            pass
        if exc.code == 429:
            retry_after = None
            raw = exc.headers.get("Retry-After") if exc.headers else None
            try:
                retry_after = float(raw) if raw else None
            except ValueError:
                retry_after = None
            raise RateLimited(retry_after=retry_after, detail=detail)
        raise ProviderError("HTTP %s from the embedding provider: %s" % (exc.code, detail))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ProviderError("%s: %s" % (type(exc).__name__, exc))
    ordered = sorted(payload.get("data", []), key=lambda item: item.get("index", 0))
    usage = payload.get("usage") or {}
    return {"embeddings": [item["embedding"] for item in ordered],
            "total_tokens": usage.get("total_tokens")}


def default_batch_provider(texts, model, input_type):
    """Embed *texts* with *model* through its catalogue provider.

    Raises:
        RateLimited: on HTTP 429.
        ProviderError: on any other failure, including a model that is not in
            the catalogue.
    """
    record = harness_config.model_record(model)
    if record is None:
        raise ProviderError("%r is not in the embedding model catalogue" % model)
    dimension = harness_config.COLUMN_DIMENSION
    provider = record.get("provider")
    if provider == "voyage":
        return _http_embed(VOYAGE_EMBEDDINGS_URL, "VOYAGE_API_KEY", {
            "input": list(texts), "model": model, "input_type": input_type,
            "output_dimension": dimension})
    if provider == "openai":
        return _http_embed(OPENAI_EMBEDDINGS_URL, "OPENAI_API_KEY", {
            "input": list(texts), "model": model, "dimensions": dimension})
    if provider == "local":
        try:
            from services import rlm_embeddings
        except ImportError:  # pragma: no cover - script-launched from services/
            import rlm_embeddings
        vectors = [rlm_embeddings._try_qodo(text) for text in texts]  # noqa: SLF001
        if any(v is None for v in vectors):
            raise ProviderError("the local embedding model did not answer")
        return {"embeddings": vectors, "total_tokens": None}
    raise ProviderError("no provider implementation for %r" % provider)


def _provider(provider=None):
    return provider or _BATCH_PROVIDER_OVERRIDE or default_batch_provider


class Pacer:
    """Paces requests from what the provider ANSWERS; assumes no rate.

    * a 429 waits ``Retry-After`` when the header is present, else exponential
      backoff with full jitter on top of a doubling floor (so delays increase);
    * the second consecutive 429 for one batch asks the caller to halve it;
    * after a 429 the interval between requests is held at the observed gap that
      the provider accepted, and relaxed slowly after sustained success.

    Args:
        pause: ``callable(seconds)``; tests inject a recorder.
        rng: ``random.Random``; tests inject a seeded one.
        max_retries: 429s tolerated for one batch before the run stops, resumable.
    """

    def __init__(self, pause=None, rng=None, max_retries=DEFAULT_MAX_RETRIES):
        self.pause = pause or _pause
        self.rng = rng or random.Random()
        self.max_retries = max_retries
        self.interval = 0.0
        self.delays = []
        self.rate_limit_events = 0
        self._streak = 0

    def backoff_delay(self, attempt, retry_after=None):
        """The delay before retry number *attempt* (1-based)."""
        floor = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
        if retry_after is not None and retry_after > 0:
            return max(float(retry_after), 0.0) + self.rng.uniform(0, 1)
        return floor + self.rng.uniform(0, floor)

    def call(self, send, shrink=None):
        """Run ``send()`` until it succeeds, honouring every 429.

        Args:
            send: zero-argument callable performing the request.
            shrink: optional callable invoked on the second consecutive 429; it
                returns True when the batch was made smaller.

        Raises:
            BackfillError: ``rate_limited`` (exit 4, resumable) after
                ``max_retries`` refusals.
        """
        attempt = 0
        if self.interval > 0:
            self.pause(self.interval)
        while True:
            try:
                result = send()
            except RateLimited as limited:
                attempt += 1
                self.rate_limit_events += 1
                self._streak = 0
                if attempt > self.max_retries:
                    raise BackfillError(
                        "rate_limited",
                        "the provider refused the same request %d times; the run "
                        "stops here and continues from this point when re-run"
                        % attempt, exit_code=EXIT_INCOMPLETE,
                        retries=attempt, delays=list(self.delays),
                        provider_detail=limited.detail)
                delay = self.backoff_delay(attempt, limited.retry_after)
                self.delays.append(round(delay, 3))
                self.interval = max(self.interval, min(delay, BACKOFF_CAP_SECONDS))
                log.warning("embed_rate_limited attempt=%d delay=%.2f", attempt, delay)
                if attempt >= 2 and shrink is not None:
                    shrink()
                self.pause(delay)
                continue
            self._streak += 1
            if self._streak >= 20 and self.interval > 0:
                self.interval *= 0.8
                self._streak = 0
            return result


# ── counting ─────────────────────────────────────────────────────────────────

def _pending_predicate(spec, mode):
    """The cursor: the rows of *spec* that still need a vector. One ``%s`` (the model)."""
    if mode == MODE_FILL:
        return ("(%s IS NULL OR embedding_model IS DISTINCT FROM %%s)" % spec.vector_column)
    return ("(%s_next IS NULL OR embedding_model_next IS DISTINCT FROM %%s)"
            % spec.vector_column)


def count_pending(conn, use, mode, model):
    """Rows and estimated tokens the job would embed, per table and in total.

    Returns:
        dict: ``{"rows_total", "tokens_total", "tables": [{table, rows, tokens,
        reembeddable}]}``.
    """
    per = _chars_per_token()
    tables = []
    with conn.cursor() as cur:
        for spec in USE_TABLES[use]:
            if spec.text_column is None:
                tables.append({"table": spec.table, "rows": 0, "tokens": 0,
                               "reembeddable": False})
                continue
            cur.execute(
                "SELECT COUNT(*), %s FROM %s WHERE %s AND %s"
                % (_tokens_sql(spec, per), spec.table, _text_predicate(spec),
                   _pending_predicate(spec, mode)), (model,))
            rows, tokens = cur.fetchone()
            tables.append({"table": spec.table, "rows": int(rows), "tokens": int(tokens),
                           "reembeddable": True})
    return {"rows_total": sum(t["rows"] for t in tables),
            "tokens_total": sum(t["tokens"] for t in tables), "tables": tables}


def _corpus_count(paths):
    try:
        from services import rlm_ingestion
    except ImportError:  # pragma: no cover - script-launched from services/
        import rlm_ingestion
    return rlm_ingestion.count_corpus_tokens(paths)


def _plan(conn, use, env=None, write=True):
    """Mode, model and state for a run, from the configuration and the state.

    With ``write=False`` (``--count-only``) the state is only READ: counting
    never records a target, so it changes nothing at all.
    """
    state = _state(conn, use)
    configured = harness_config.configured_model(use, env=env)
    active = state["active_model"]
    if not write:
        return (MODE_FILL if configured == active else MODE_BLUE_GREEN), configured, state
    if configured == active:
        if state["phase"] != PHASE_STEADY or state["target_model"]:
            mark_target(conn, use, configured)
            state = _state(conn, use)
        return MODE_FILL, active, state
    if state["target_model"] != configured:
        mark_target(conn, use, configured)
        state = _state(conn, use)
    return MODE_BLUE_GREEN, configured, state


# ── the job ──────────────────────────────────────────────────────────────────

def run_backfill(dsn=None, use=None, budget_tokens=None, count_only=False,
                 batch_size=None, paths=None, allow_paid=False,
                 max_duration_seconds=None, provider=None, pacer=None,
                 emit=None, on_batch=None, env=None, actor=None):
    """Count, then (unless ``count_only``) embed every pending row of *use*.

    Args:
        dsn: PostgreSQL DSN; resolved from the environment when omitted.
        use: ``memory`` or ``code_index``.
        budget_tokens: the most this run may spend. Required to spend anything.
        count_only: print the count and stop; makes no provider call.
        batch_size: documents per request (default 128), further limited by the
            model's per-request token cap.
        paths: source trees, for ``code_index`` — the count-only total is the
            ingestion corpus of these trees.
        allow_paid: accept a budget above the model's free allowance.
        max_duration_seconds: stop (resumable) when the duration estimated at
            the measured rate exceeds this.
        provider: batch provider; the catalogue provider when omitted.
        pacer: a :class:`Pacer`; a default one when omitted.
        emit: ``callable(dict)`` receiving each event line.
        on_batch: test hook called after each committed batch.
        env: mapping for configuration lookups.
        actor: who runs it, for the audit row.

    Returns:
        dict: the result event — mode, model, counts, ``tokens_spent``,
        ``rows_done``, ``rate_limit_events``, ``delays``, ``complete``.

    Raises:
        BackfillError: every refusal, typed (see the module docstring for the
            exit code each maps to).
    """
    if use not in USES:
        raise BackfillError("invalid_use", "--use must be one of %s" % ", ".join(USES),
                            valid=list(USES))
    emit = emit or (lambda event: None)
    dsn = _resolve_dsn(dsn, env)
    conn = _connect(dsn)
    lock_conn = None
    try:
        mode, model, state = _plan(conn, use, env=env, write=not count_only)
        pending = count_pending(conn, use, mode, model)
        record = harness_config.model_record(model) or {}
        count_event = {
            "event": "count", "use": use, "mode": mode, "model": model,
            "active_model": state["active_model"], "phase": state["phase"],
            "rows_total": pending["rows_total"], "tokens_total": pending["tokens_total"],
            "tables": pending["tables"], "count_basis": "database_rows",
            "token_estimate": "ceil(characters / %d) per text, an over-count by design"
                              % _chars_per_token(),
            "free_tokens": record.get("free_tokens"),
            "price_per_mtok": record.get("price_per_mtok"),
        }
        if use == harness_config.USE_CODE_INDEX and count_only:
            if not paths:
                raise BackfillError(
                    "code_index_paths_required",
                    "--use code_index --count-only counts the INGESTION CORPUS from "
                    "the source trees and needs at least one --path; the rows of "
                    "rlm_chunks are not the measurement (an empty table counts 0)",
                    database_pending_rows=pending["rows_total"],
                    database_pending_tokens=pending["tokens_total"])
            corpus = _corpus_count(paths)
            count_event.update({
                "count_basis": "ingestion_corpus",
                "tokens_total": corpus["tokens_total"],
                "corpus": corpus,
                "database_pending_rows": pending["rows_total"],
                "database_pending_tokens": pending["tokens_total"],
            })
        tpm = record.get("tpm_tier1")
        if tpm:
            count_event["estimated_duration_seconds_at_catalogue_ceiling"] = round(
                count_event["tokens_total"] / (tpm / 60.0), 1)
            count_event["estimated_duration_note"] = (
                "UNMEASURED: the catalogue's tier-1 limit, a ceiling. The run "
                "measures the real rate from the provider's answers and prints the "
                "estimate at that rate after %d requests." % CALIBRATION_REQUESTS)
        emit(count_event)
        if count_only:
            return dict(count_event, event="result", count_only=True, tokens_spent=0,
                        provider_calls=0, complete=pending["rows_total"] == 0)

        tokens_total = pending["tokens_total"]
        if budget_tokens is None:
            raise BackfillError(
                "budget_required",
                "this run would embed about %d tokens (%d rows); it does not start "
                "without --budget-tokens" % (tokens_total, pending["rows_total"]),
                tokens_total=tokens_total, rows_total=pending["rows_total"], use=use)
        if tokens_total > budget_tokens:
            raise BackfillError(
                "budget_exceeded",
                "the counted total is %d tokens and the budget is %d tokens; "
                "nothing was spent" % (tokens_total, budget_tokens),
                tokens_total=tokens_total, budget_tokens=budget_tokens, use=use)
        free = record.get("free_tokens")
        if free is not None and budget_tokens > free and not allow_paid:
            raise BackfillError(
                "budget_above_free_allowance",
                "the budget is %d tokens and %s's free allowance is %d tokens; "
                "spending beyond it is the operator's decision (--allow-paid)"
                % (budget_tokens, model, free),
                budget_tokens=budget_tokens, free_tokens=free, model=model)

        lock_conn = _connect(dsn, autocommit=True)
        with lock_conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(hashtext(%s))", ("embed:" + use,))
            if not cur.fetchone()[0]:
                raise BackfillError(
                    "backfill_already_running",
                    "another embedding job holds the lock for use %r" % use,
                    exit_code=EXIT_ALREADY_RUNNING, use=use)

        resuming = (mode == MODE_BLUE_GREEN and state["phase"] == PHASE_BACKFILLING
                    and (state["rows_done"] or 0) > 0)
        with conn.cursor() as cur:
            if resuming:
                cur.execute(
                    "UPDATE embedding_state SET rows_total = rows_done + %s, "
                    "budget_tokens = %s, updated_at = NOW() WHERE use = %s",
                    (pending["rows_total"], budget_tokens, use))
            else:
                cur.execute(
                    "UPDATE embedding_state SET started_at = NOW(), rows_total = %s, "
                    "rows_done = 0, tokens_spent = 0, budget_tokens = %s, "
                    "updated_at = NOW() WHERE use = %s",
                    (pending["rows_total"], budget_tokens, use))
        conn.commit()

        pacer = pacer or Pacer()
        send = _provider(provider)
        size = {"n": max(1, int(batch_size or DEFAULT_BATCH_SIZE))}
        cap = record.get("max_tokens_per_request")
        token_cap = int(cap * REQUEST_CAP_FRACTION) if cap else None
        per = _chars_per_token()
        spent = rows_done = calls = 0
        started = time.monotonic()
        skipped = collections.defaultdict(list)
        stop = None
        measured = None

        for spec in USE_TABLES[use]:
            if spec.text_column is None or stop:
                continue
            vec = spec.vector_column if mode == MODE_FILL else spec.vector_column + "_next"
            mod = "embedding_model" if mode == MODE_FILL else "embedding_model_next"
            while True:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT %s, left(%s, %d) FROM %s WHERE %s AND %s "
                        "AND NOT (%s::text = ANY(%%s)) ORDER BY %s LIMIT %%s"
                        % (spec.id_column, spec.text_column, spec.max_chars, spec.table,
                           _text_predicate(spec), _pending_predicate(spec, mode),
                           spec.id_column, spec.id_column),
                        (model, skipped[spec.table], size["n"]))
                    rows = cur.fetchall()
                conn.commit()
                if not rows:
                    break
                batch, estimate = [], 0
                for row_id, text in rows:
                    tokens = -(-len(text) // per)
                    if batch and token_cap and estimate + tokens > token_cap:
                        break
                    batch.append((row_id, text))
                    estimate += tokens
                if spent + estimate > budget_tokens:
                    stop = BackfillError(
                        "budget_exhausted",
                        "the next batch (about %d tokens) would take the run past its "
                        "budget of %d tokens (%d spent); re-run with a budget to continue"
                        % (estimate, budget_tokens, spent), exit_code=EXIT_INCOMPLETE,
                        tokens_spent=spent, budget_tokens=budget_tokens)
                    break

                def shrink():
                    if len(batch) > 1:
                        del batch[max(1, len(batch) // 2):]
                        size["n"] = max(1, size["n"] // 2)
                        return True
                    return False

                try:
                    answer = pacer.call(
                        lambda: send([text for _id, text in batch], model, spec.input_type),
                        shrink=shrink)
                except ProviderError as exc:
                    stop = BackfillError(
                        "provider_failed",
                        "the embedding provider failed: %s" % exc,
                        exit_code=EXIT_INCOMPLETE, tokens_spent=spent)
                    break
                except BackfillError as exc:
                    stop = exc
                    break
                calls += 1
                vectors = answer["embeddings"]
                used = answer.get("total_tokens")
                if used is None:
                    used = sum(-(-len(text) // per) for _id, text in batch)
                with conn.cursor() as cur:
                    for (row_id, _text), vector in zip(batch, vectors):
                        if not vector or len(vector) != harness_config.COLUMN_DIMENSION:
                            skipped[spec.table].append(str(row_id))
                            continue
                        # ONE statement writes the vector AND its model.
                        cur.execute(
                            "UPDATE %s SET %s = %%s::vector, %s = %%s WHERE %s = %%s"
                            % (spec.table, vec, mod, spec.id_column),
                            (_vector_literal(vector), model, row_id))
                    done = min(len(batch), len(vectors))
                    cur.execute(
                        "UPDATE embedding_state SET rows_done = rows_done + %s, "
                        "tokens_spent = tokens_spent + %s, updated_at = NOW() "
                        "WHERE use = %s", (done, used, use))
                conn.commit()
                spent += used
                rows_done += done
                elapsed = max(time.monotonic() - started, 1e-6) + sum(pacer.delays)
                rate = spent / elapsed
                remaining = max(tokens_total - spent, 0)
                eta = round(remaining / rate, 1) if rate > 0 else None
                emit({"event": "batch", "table": spec.table, "rows": done,
                      "rows_done": rows_done, "rows_total": pending["rows_total"],
                      "tokens": used, "tokens_spent": spent,
                      "budget_tokens": budget_tokens, "provider_calls": calls,
                      "eta_seconds": eta})
                measured = {"event": "rate_measured", "requests": calls,
                            "tokens_per_minute": round(rate * 60, 1),
                            "rate_limit_events": pacer.rate_limit_events,
                            "estimated_duration_seconds": eta,
                            "basis": "measured over %d request(s), waits included" % calls}
                if calls == CALIBRATION_REQUESTS:
                    emit(measured)
                    if (max_duration_seconds is not None and eta is not None
                            and eta > max_duration_seconds):
                        stop = BackfillError(
                            "duration_exceeds_limit",
                            "at the measured rate the run needs about %s s, more than "
                            "the %s s allowed; it stops here and continues when re-run"
                            % (eta, max_duration_seconds), exit_code=EXIT_INCOMPLETE,
                            estimated_duration_seconds=eta,
                            max_duration_seconds=max_duration_seconds,
                            tokens_spent=spent)
                        break
                if on_batch is not None:
                    on_batch({"table": spec.table, "rows_done": rows_done,
                              "tokens_spent": spent, "provider_calls": calls})

        if 0 < calls < CALIBRATION_REQUESTS and measured is not None:
            emit(measured)  # a job shorter than the calibration window still reports
        remaining = count_pending(conn, use, mode, model)
        complete = remaining["rows_total"] == 0 and stop is None
        with conn.cursor() as cur:
            if mode == MODE_BLUE_GREEN and remaining["rows_total"] == 0:
                cur.execute(
                    "UPDATE embedding_state SET phase = 'cutover_ready', "
                    "updated_at = NOW() WHERE use = %s AND phase = 'backfilling'", (use,))
            _audit(cur, "embedding_backfill", "ok" if complete else "incomplete",
                   "%s %s with %s: %d rows, %d tokens" % (use, mode, model, rows_done, spent),
                   {"use": use, "mode": mode, "model": model, "rows_done": rows_done,
                    "tokens_spent": spent, "budget_tokens": budget_tokens,
                    "provider_calls": calls, "rate_limit_events": pacer.rate_limit_events,
                    "remaining_rows": remaining["rows_total"],
                    "stopped": stop.code if stop else None}, actor=actor)
        conn.commit()
        reset_caches()
        result = {
            "event": "result", "use": use, "mode": mode, "model": model,
            "rows_total": pending["rows_total"], "rows_done": rows_done,
            "tokens_total": tokens_total, "tokens_spent": spent,
            "budget_tokens": budget_tokens, "provider_calls": calls,
            "rate_limit_events": pacer.rate_limit_events, "delays": list(pacer.delays),
            "remaining_rows": remaining["rows_total"],
            "skipped_rows": {t: len(ids) for t, ids in skipped.items() if ids},
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "phase": _state(conn, use)["phase"], "complete": complete,
        }
        if stop is not None:
            stop.details.setdefault("result", result)
            raise stop
        if not complete:
            raise BackfillError(
                "backfill_incomplete",
                "%d row(s) could not be embedded (the provider returned no usable "
                "vector for them)" % remaining["rows_total"],
                exit_code=EXIT_INCOMPLETE, result=result)
        return result
    finally:
        for handle in (lock_conn, conn):
            if handle is not None:
                try:
                    handle.close()
                except Exception:  # noqa: BLE001 - closing a dead session
                    pass


# ── cutover ──────────────────────────────────────────────────────────────────

def _swap_columns(cur, spec):
    """Exchange ``<col>`` with ``<col>_next`` and the two model columns. Catalog-only."""
    for live in (spec.vector_column, "embedding_model"):
        nxt = live + "_next"
        tmp = live + "_swap"
        cur.execute("ALTER TABLE %s RENAME COLUMN %s TO %s" % (spec.table, live, tmp))
        cur.execute("ALTER TABLE %s RENAME COLUMN %s TO %s" % (spec.table, nxt, live))
        cur.execute("ALTER TABLE %s RENAME COLUMN %s TO %s" % (spec.table, tmp, nxt))


def _mrr(conn, spec, column, model_column, model, probes, vectors, k=RELEVANCE_K):
    total = 0.0
    with conn.cursor() as cur:
        for (row_id, _text), vector in zip(probes, vectors):
            cur.execute(
                "SELECT %s FROM %s WHERE %s IS NOT NULL AND %s = %%s "
                "ORDER BY %s <=> %%s::vector LIMIT %%s"
                % (spec.id_column, spec.table, column, model_column, column),
                (model, _vector_literal(vector), k))
            ranked = [str(r[0]) for r in cur.fetchall()]
            if str(row_id) in ranked:
                total += 1.0 / (ranked.index(str(row_id)) + 1)
    return round(total / len(probes), 4) if probes else None


def relevance_compare(conn, use, active, target, provider=None, sample=None):
    """MRR@5 of a known-item probe against the new vectors and against the old.

    The probe is the same for both sides: *sample* stored rows, each queried with
    its own text (embedded as a QUERY by the model that built that side) and
    expected back at rank 1. It is the measurement plan 89-01's relevance check
    reports (MRR@k over query -> expected id), applied to the two columns of one
    table so the two numbers are comparable.

    Returns:
        dict: ``{"table", "probes", "k", "mrr_next", "mrr_live", "live_comparable"}``
        — ``mrr_live`` is None when the live column holds no vector of the active
        model (nothing to be worse than).
    """
    spec = USE_TABLES[use][0]
    send = _provider(provider)
    sample = sample or RELEVANCE_SAMPLE
    nxt = spec.vector_column + "_next"
    with conn.cursor() as cur:
        cur.execute(
            "SELECT %s, left(%s, %d) FROM %s WHERE %s IS NOT NULL "
            "AND embedding_model_next = %%s AND %s ORDER BY %s LIMIT %%s"
            % (spec.id_column, spec.text_column, spec.max_chars, spec.table, nxt,
               _text_predicate(spec), spec.id_column), (target, sample))
        probes = cur.fetchall()
        cur.execute(
            "SELECT COUNT(*) FROM %s WHERE %s IS NOT NULL AND embedding_model = %%s"
            % (spec.table, spec.vector_column), (active,))
        live_rows = cur.fetchone()[0]
    report = {"table": spec.table, "probes": len(probes), "k": RELEVANCE_K,
              "mrr_next": None, "mrr_live": None, "live_comparable": bool(live_rows)}
    if not probes:
        return report
    texts = [text for _id, text in probes]
    pacer = Pacer()
    new_vectors = pacer.call(lambda: send(texts, target, "query"))["embeddings"]
    report["mrr_next"] = _mrr(conn, spec, nxt, "embedding_model_next", target,
                              probes, new_vectors)
    if live_rows:
        old_vectors = pacer.call(lambda: send(texts, active, "query"))["embeddings"]
        report["mrr_live"] = _mrr(conn, spec, spec.vector_column, "embedding_model",
                                  active, probes, old_vectors)
    return report


def run_cutover(dsn=None, use=None, rollback=False, skip_relevance_check=False,
                relevance_tolerance=0.0, relevance_sample=None, provider=None,
                env=None, actor=None):
    """Switch *use* to its target model in ONE transaction, or switch back.

    Forward: every re-embeddable row that has a live vector must have its new one;
    the relevance comparison must not be worse; then the columns are swapped,
    ``active_model`` becomes the target, the phase returns to ``steady`` and an
    audit row is written. The previous vectors stay in ``<col>_next`` until
    ``drop-previous --confirm``.

    ``rollback=True`` swaps back to ``previous_model`` while those vectors exist.

    Returns:
        dict: ``{"event": "result", "use", "cutover": bool, "active_model",
        "previous_model", "relevance", ...}``.

    Raises:
        BackfillError: ``backfill_incomplete`` / ``relevance_worse`` /
            ``nothing_to_roll_back`` (exit 5), ``backfill_already_running`` (3).
    """
    if use not in USES:
        raise BackfillError("invalid_use", "--use must be one of %s" % ", ".join(USES),
                            valid=list(USES))
    dsn = _resolve_dsn(dsn, env)
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s))", ("embed:" + use,))
            if not cur.fetchone()[0]:
                raise BackfillError(
                    "backfill_already_running",
                    "another embedding job holds the lock for use %r" % use,
                    exit_code=EXIT_ALREADY_RUNNING, use=use)
        state = _state(conn, use)
        active = state["active_model"]

        if rollback:
            previous = state["previous_model"]
            if not previous or state["phase"] != PHASE_STEADY:
                raise BackfillError(
                    "nothing_to_roll_back",
                    "use %r has no previous model to return to (phase %s); the "
                    "previous vectors are kept only until drop-previous"
                    % (use, state["phase"]), exit_code=EXIT_CUTOVER_REFUSED, use=use)
            with conn.cursor() as cur:
                cur.execute("SET LOCAL lock_timeout = '10s'")
                for spec in USE_TABLES[use]:
                    _swap_columns(cur, spec)
                cur.execute(
                    "UPDATE embedding_state SET active_model = %s, previous_model = %s, "
                    "target_model = NULL, phase = 'steady', updated_at = NOW() "
                    "WHERE use = %s", (previous, active, use))
                _audit(cur, "embedding_cutover_rollback", "ok",
                       "%s: %s -> %s (rollback)" % (use, active, previous),
                       {"use": use, "from": active, "to": previous}, actor=actor)
            conn.commit()
            reset_caches()
            return {"event": "result", "use": use, "cutover": True, "rollback": True,
                    "active_model": previous, "previous_model": active,
                    "phase": PHASE_STEADY}

        target = state["target_model"]
        if not target or target == active:
            conn.rollback()
            return {"event": "result", "use": use, "cutover": False,
                    "reason": "nothing_to_cut_over", "active_model": active,
                    "phase": state["phase"],
                    "message": "use %r is steady on %s; a fill-mode backfill writes "
                               "the live column directly and needs no cutover"
                               % (use, active)}

        missing = {}
        with conn.cursor() as cur:
            for spec in USE_TABLES[use]:
                if spec.text_column is None:
                    continue
                cur.execute(
                    "SELECT COUNT(*) FROM %s WHERE %s IS NOT NULL AND %s AND "
                    "(%s_next IS NULL OR embedding_model_next IS DISTINCT FROM %%s)"
                    % (spec.table, spec.vector_column, _text_predicate(spec),
                       spec.vector_column), (target,))
                count = cur.fetchone()[0]
                if count:
                    missing[spec.table] = int(count)
        if missing:
            raise BackfillError(
                "backfill_incomplete",
                "%d row(s) have a live vector and no %s vector yet; run the backfill "
                "to completion first" % (sum(missing.values()), target),
                exit_code=EXIT_CUTOVER_REFUSED, use=use, missing_by_table=missing,
                target_model=target)

        relevance = {"skipped": True}
        if not skip_relevance_check:
            try:
                relevance = relevance_compare(conn, use, active, target,
                                              provider=provider, sample=relevance_sample)
            except (ProviderError, BackfillError) as exc:
                raise BackfillError(
                    "relevance_check_failed",
                    "the relevance comparison could not run (%s); the cutover is "
                    "refused rather than performed blind (--skip-relevance-check "
                    "records an explicit override)" % exc,
                    exit_code=EXIT_CUTOVER_REFUSED, use=use)
            if (relevance["mrr_live"] is not None and relevance["mrr_next"] is not None
                    and relevance["mrr_next"] < relevance["mrr_live"] - relevance_tolerance):
                raise BackfillError(
                    "relevance_worse",
                    "MRR@%d against the %s vectors is %s, worse than %s against the "
                    "%s vectors; the cutover is refused and queries stay on %s"
                    % (relevance["k"], target, relevance["mrr_next"],
                       relevance["mrr_live"], active, active),
                    exit_code=EXIT_CUTOVER_REFUSED, use=use, relevance=relevance,
                    active_model=active, target_model=target)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL lock_timeout = '10s'")
            for spec in USE_TABLES[use]:
                _swap_columns(cur, spec)
            cur.execute(
                "UPDATE embedding_state SET previous_model = active_model, "
                "active_model = %s, target_model = NULL, phase = 'steady', "
                "updated_at = NOW() WHERE use = %s", (target, use))
            _audit(cur, "embedding_cutover", "ok", "%s: %s -> %s" % (use, active, target),
                   {"use": use, "from": active, "to": target, "relevance": relevance,
                    "relevance_check_skipped": bool(skip_relevance_check)}, actor=actor)
        conn.commit()
        reset_caches()
        return {"event": "result", "use": use, "cutover": True, "rollback": False,
                "active_model": target, "previous_model": active,
                "phase": PHASE_STEADY, "relevance": relevance}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001 - closing a dead session
            pass


def drop_previous(dsn=None, use=None, confirm=False, env=None, actor=None):
    """Erase the previous model's vectors (``<col>_next``) after a cutover.

    The columns themselves stay, empty, for the next blue/green. Irreversible:
    after this ``cutover --rollback`` has nothing to return to.

    Raises:
        BackfillError: ``confirmation_required`` without ``confirm``;
            ``backfill_in_progress`` while a target is being built (the same
            columns hold it).
    """
    if use not in USES:
        raise BackfillError("invalid_use", "--use must be one of %s" % ", ".join(USES),
                            valid=list(USES))
    if not confirm:
        raise BackfillError(
            "confirmation_required",
            "drop-previous erases the previous model's vectors and makes "
            "`cutover --rollback` impossible; pass --confirm", use=use)
    conn = _connect(_resolve_dsn(dsn, env))
    try:
        state = _state(conn, use)
        if state["phase"] != PHASE_STEADY:
            raise BackfillError(
                "backfill_in_progress",
                "use %r is %s: the *_next columns hold the vectors being built, "
                "not previous ones" % (use, state["phase"]), use=use)
        erased = {}
        with conn.cursor() as cur:
            for spec in USE_TABLES[use]:
                cur.execute(
                    "UPDATE %s SET %s_next = NULL, embedding_model_next = NULL "
                    "WHERE %s_next IS NOT NULL OR embedding_model_next IS NOT NULL"
                    % (spec.table, spec.vector_column, spec.vector_column))
                erased[spec.table] = cur.rowcount
            cur.execute("UPDATE embedding_state SET previous_model = NULL, "
                        "updated_at = NOW() WHERE use = %s", (use,))
            _audit(cur, "embedding_drop_previous", "ok",
                   "%s: previous vectors erased" % use,
                   {"use": use, "previous_model": state["previous_model"],
                    "rows": erased}, actor=actor)
        conn.commit()
        return {"event": "result", "use": use, "dropped": True, "rows": erased,
                "previous_model": state["previous_model"]}
    finally:
        conn.close()


def status(dsn=None, env=None):
    """``embedding_state`` for every use, with the configured (desired) models."""
    states = read_states_for_dsn(_resolve_dsn(dsn, env))
    for use, state in states.items():
        try:
            state["configured_model"] = harness_config.configured_model(use, env=env)
        except harness_config.HarnessConfigError as exc:
            state["configured_model_error"] = exc.to_dict()
    return {"event": "result", "states": states}


def verify_catalogue(model, write=False, provider=None, env=None):
    """One tiny live call: the endpoint answers and the vector has the catalogue's size.

    A rate-limit answer is REPORTED (``verified: None``), not treated as a
    failure of the catalogue.

    Args:
        model: a catalogue embedding model id.
        write: on success, set ``verified_at`` / ``verified_by`` in the file.

    Returns:
        dict: ``{"model", "verified": True|False|None, "dimension", "expected",
        "total_tokens", "written"}``.
    """
    record = harness_config.model_record(model, env=env)
    if record is None or record.get("kind") != "embed":
        raise BackfillError(
            "unknown_model", "%r is not an embedding model in the catalogue" % model,
            valid=harness_config.models_of_kind("embed", env=env))
    expected = record["default_dimension"]
    try:
        answer = _provider(provider)(["def gsd_catalogue_probe(): return 1"], model,
                                     "document")
    except RateLimited as limited:
        return {"event": "result", "model": model, "verified": None,
                "reason": "rate_limited", "provider_detail": limited.detail,
                "expected": expected, "written": False}
    except ProviderError as exc:
        return {"event": "result", "model": model, "verified": False,
                "reason": str(exc), "expected": expected, "written": False}
    dimension = len(answer["embeddings"][0]) if answer.get("embeddings") else 0
    verified = dimension == expected
    written = False
    if verified and write:
        path = harness_config.catalogue_path(env)
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        for entry in data["models"]:
            if entry["id"] == model:
                entry["verified_at"] = datetime.date.today().isoformat()
                entry["verified_by"] = (
                    "embeddings verify-catalogue: one live call returned %d dimensions"
                    % dimension)
        tmp = pathlib.Path(str(path) + ".tmp.%d" % os.getpid())
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
        os.replace(tmp, path)
        written = True
    return {"event": "result", "model": model, "verified": verified,
            "dimension": dimension, "expected": expected,
            "total_tokens": answer.get("total_tokens"), "written": written}


# ── CLI ──────────────────────────────────────────────────────────────────────

def build_parser():
    """The argparse surface (``gsd-tools embeddings ...`` forwards to it verbatim)."""
    parser = argparse.ArgumentParser(
        prog="embeddings",
        description="Re-embed, cut over and inspect the embedding models (RET-05).")
    sub = parser.add_subparsers(dest="verb", required=True)

    p_backfill = sub.add_parser("backfill", help="count, then embed every pending row")
    p_backfill.add_argument("--use", required=True, choices=USES)
    p_backfill.add_argument("--count-only", action="store_true")
    p_backfill.add_argument("--budget-tokens", type=int, default=None)
    p_backfill.add_argument("--batch-size", type=int, default=None)
    p_backfill.add_argument("--path", action="append", default=[])
    p_backfill.add_argument("--allow-paid", action="store_true")
    p_backfill.add_argument("--max-duration-seconds", type=float, default=None)
    p_backfill.add_argument("--cutover", action="store_true")
    p_backfill.add_argument("--skip-relevance-check", action="store_true")
    p_backfill.add_argument("--dsn", default=None)
    p_backfill.add_argument("--json", action="store_true")

    p_cutover = sub.add_parser("cutover", help="switch a use to its target model")
    p_cutover.add_argument("--use", required=True, choices=USES)
    p_cutover.add_argument("--rollback", action="store_true")
    p_cutover.add_argument("--skip-relevance-check", action="store_true")
    p_cutover.add_argument("--relevance-tolerance", type=float, default=0.0)
    p_cutover.add_argument("--relevance-sample", type=int, default=None)
    p_cutover.add_argument("--dsn", default=None)
    p_cutover.add_argument("--json", action="store_true")

    p_drop = sub.add_parser("drop-previous", help="erase the previous model's vectors")
    p_drop.add_argument("--use", required=True, choices=USES)
    p_drop.add_argument("--confirm", action="store_true")
    p_drop.add_argument("--dsn", default=None)
    p_drop.add_argument("--json", action="store_true")

    p_status = sub.add_parser("status", help="embedding_state per use")
    p_status.add_argument("--dsn", default=None)
    p_status.add_argument("--json", action="store_true")

    p_verify = sub.add_parser("verify-catalogue", help="one tiny live call for a model")
    p_verify.add_argument("--model", required=True)
    p_verify.add_argument("--write", action="store_true")
    p_verify.add_argument("--json", action="store_true")
    return parser


def main(argv=None, emit=None):
    """CLI entry point. Prints one JSON document per line; the last is the result.

    Returns:
        int: the exit code documented in the module docstring.
    """
    args = build_parser().parse_args(argv)

    def out(event):
        if emit is not None:
            emit(event)
        sys.stdout.write(json.dumps(event, sort_keys=True, default=str) + "\n")
        sys.stdout.flush()

    try:
        if args.verb == "backfill":
            result = run_backfill(
                dsn=args.dsn, use=args.use, budget_tokens=args.budget_tokens,
                count_only=args.count_only, batch_size=args.batch_size,
                paths=args.path, allow_paid=args.allow_paid,
                max_duration_seconds=args.max_duration_seconds, emit=out)
            out(result)
            if args.cutover and not args.count_only:
                out(run_cutover(dsn=args.dsn, use=args.use,
                                skip_relevance_check=args.skip_relevance_check))
        elif args.verb == "cutover":
            out(run_cutover(
                dsn=args.dsn, use=args.use, rollback=args.rollback,
                skip_relevance_check=args.skip_relevance_check,
                relevance_tolerance=args.relevance_tolerance,
                relevance_sample=args.relevance_sample))
        elif args.verb == "drop-previous":
            out(drop_previous(dsn=args.dsn, use=args.use, confirm=args.confirm))
        elif args.verb == "status":
            out(status(dsn=args.dsn))
        else:
            result = verify_catalogue(args.model, write=args.write)
            out(result)
            if result["verified"] is None:
                return EXIT_INCOMPLETE
            if result["verified"] is False:
                return EXIT_REFUSED
        return EXIT_OK
    except BackfillError as exc:
        out(exc.to_dict())
        return exc.exit_code
    except harness_config.HarnessConfigError as exc:
        out(exc.to_dict())
        return EXIT_REFUSED
    except Exception as exc:  # noqa: BLE001 - typed body; the trace goes to the log
        log.exception("embedding_backfill_failed")
        out({"error": "internal_error", "message": type(exc).__name__})
        return EXIT_ERROR


if __name__ == "__main__":
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    sys.exit(main())
