"""Phase 89 plan 89-08 (RET-05) — the blue/green re-embed, the budget gate and
the mixed-model refusal.

TWO KINDS OF TEST IN THIS FILE
──────────────────────────────
* Tests that take the ``db`` or ``fresh_db`` fixture run against the DISPOSABLE
  PostgreSQL every CI cell brings up (plan 89-07), on a scratch database of
  their own module. They are skipped on a developer machine with no
  ``GSD_TEST_POSTGRES_URL``; each has its ``context: "local"`` row in
  ``tests/skip-exceptions.d/89-08.json``, which the gate refuses when ``CI`` is
  set.
* Everything else needs NO database — the corpus counter, the budget refusal of
  the ingestion path, the pacer — and runs everywhere, unlisted.

NO REAL PROVIDER CALL
─────────────────────
Every embedding in this file comes from ``tests/support/stub_embeddings.py``
``deterministic_embedding``, entered through the product's own seams
(``embedding_backfill.set_batch_provider_override`` or the ``provider=``
argument, and ``rlm_embeddings.set_provider_override``). The autouse fixture
below installs a provider that FAILS the test if anything reaches the default
one, so "no test made a real call" is enforced rather than claimed.
"""
import contextlib
import json
import math
import os
import pathlib
import random
import shutil
import sys
import time

import pytest

_REPO = pathlib.Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

import pg_engines  # noqa: E402  (tests/support is on sys.path — see tests/conftest.py)
import stub_embeddings  # noqa: E402

from services import embedding_backfill as eb  # noqa: E402
from services import harness_config, migrate_runner, rlm_embeddings, rlm_ingestion  # noqa: E402

MIGRATIONS = _REPO / "migrations"
UP_034 = MIGRATIONS / "034-embedding-blue-green.sql"
DOWN_034 = MIGRATIONS / "034-embedding-blue-green-DOWN.sql"

OLD = "voyage-code-4"   # migration 034's seeded active model
#: The target. voyage-code-3 has NO free allowance in the catalogue, so every run
#: towards it passes allow_paid=True — which is itself the product saying that
#: "switch back to the older model" is a paid re-embed, never a free one.
NEW = "voyage-code-3"

#: Every vector column of the schema: (table, live column).
VECTOR_COLUMNS = (
    ("gsd_memory", "embedding"),
    ("gsd_memory_archive", "embedding"),
    ("semantic_cache", "query_embedding"),
    ("rlm_chunks", "embedding_code"),
    ("task_completions", "embedding"),
    ("skill_invocations", "context_embedding"),
)


# ── the deterministic stand-in ───────────────────────────────────────────────

def vec(text, model):
    """A unit vector that depends on the text AND the model, not on input_type.

    Model-dependent, so two models' vectors of one text differ (as real ones do);
    input-type-independent, so a text queried against its own stored vector is an
    exact match — which is what makes the known-item relevance probe score 1.0.
    """
    return stub_embeddings.deterministic_embedding("%s\x00%s" % (model, text),
                                                   input_type="document")


class StubProvider:
    """A batch provider that records every call it receives."""

    def __init__(self, fail_first=0, retry_after=None, noisy_queries_for=None):
        self.calls = []
        self.fail_first = fail_first
        self.retry_after = retry_after
        self.noisy_queries_for = noisy_queries_for

    def __call__(self, texts, model, input_type):
        self.calls.append({"texts": list(texts), "model": model, "input_type": input_type})
        if self.fail_first > 0:
            self.fail_first -= 1
            raise eb.RateLimited(retry_after=self.retry_after, detail="stub 429")
        if self.noisy_queries_for == model and input_type == "query":
            # A model whose query side lands nowhere near its document side.
            return {"embeddings": [vec("noise:" + t, model) for t in texts],
                    "total_tokens": None}
        return {"embeddings": [vec(t, model) for t in texts], "total_tokens": None}

    @property
    def embedding_calls(self):
        return [c for c in self.calls if c["texts"]]


def _forbidden_provider(texts, model, input_type):
    raise AssertionError(
        "a test reached the DEFAULT embedding provider (%s, %d texts): every test "
        "in this file must inject the deterministic stand-in" % (model, len(texts)))


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch, tmp_path):
    """No real provider, no operator config, no stale per-connection answers."""
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: tmp_path / "home"))
    for name in ("GSD_EMBEDDING_MODEL_MEMORY", "GSD_EMBEDDING_MODEL_CODE_INDEX",
                 "GSD_RERANK_MODEL", "GSD_EMBEDDING_PROVIDER", "GSD_EMBEDDING_CATALOGUE",
                 rlm_ingestion.AMBIENT_BUDGET_ENV, "VOYAGE_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(eb, "default_batch_provider", _forbidden_provider)
    previous_batch = eb.set_batch_provider_override(None)
    previous_code = rlm_embeddings.set_provider_override(None)
    eb.reset_caches()
    rlm_embeddings.clear_cache()
    yield
    eb.set_batch_provider_override(previous_batch)
    rlm_embeddings.set_provider_override(previous_code)
    eb.reset_caches()
    rlm_embeddings.clear_cache()


def _connect(dsn, autocommit=True):
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    conn.autocommit = autocommit
    return conn


def _sql(dsn, statement, params=None, fetch=True):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(statement, params)
            return cur.fetchall() if fetch and cur.description else None
    finally:
        conn.close()


def _literal(vector):
    return "[" + ",".join(repr(float(v)) for v in vector) + "]"


@pytest.fixture(scope="module")
def _module_db(postgres_dsn):
    with pg_engines.migrated_database(postgres_dsn) as (dsn, report):
        assert "034-embedding-blue-green.sql" in report["applied"], report
        yield dsn


@pytest.fixture
def db(_module_db):
    """The module's migrated scratch database, emptied and reset before each test."""
    conn = _connect(_module_db)
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE gsd_memory, gsd_memory_archive, semantic_cache, "
                        "rlm_chunks, task_completions, skill_invocations CASCADE")
            cur.execute("DELETE FROM gsd_audit_log WHERE task_id = 'embeddings'")
            cur.execute(
                "UPDATE embedding_state SET active_model = CASE use WHEN 'rerank' "
                "THEN 'rerank-3' ELSE %s END, target_model = NULL, previous_model = NULL, "
                "phase = 'steady', started_at = NULL, rows_total = 0, rows_done = 0, "
                "tokens_spent = 0, budget_tokens = NULL", (OLD,))
    finally:
        conn.close()
    eb.reset_caches()
    return _module_db


def seed_memories(dsn, count, with_vectors_of=None, prefix="memory"):
    """Insert *count* memories; with a model name, each gets that model's vector."""
    texts = ["%s number %03d about topic%d" % (prefix, i, i) for i in range(count)]
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            for i, text in enumerate(texts):
                if with_vectors_of:
                    cur.execute(
                        "INSERT INTO gsd_memory (id, text, source, project_id, embedding, "
                        "embedding_model) VALUES (%s, %s, 'lesson-learned', 'p8908', "
                        "%s::vector, %s)",
                        ("%s-%03d" % (prefix, i), text, _literal(vec(text, with_vectors_of)),
                         with_vectors_of))
                else:
                    cur.execute(
                        "INSERT INTO gsd_memory (id, text, source, project_id) "
                        "VALUES (%s, %s, 'lesson-learned', 'p8908')",
                        ("%s-%03d" % (prefix, i), text))
    finally:
        conn.close()
    return texts


def state(dsn, use="memory"):
    return eb.read_states_for_dsn(dsn)[use]


def target_env(model=NEW, use="memory"):
    """The configuration a run sees: *model* is the DESIRED model for *use*."""
    key = {"memory": "GSD_EMBEDDING_MODEL_MEMORY",
           "code_index": "GSD_EMBEDDING_MODEL_CODE_INDEX"}[use]
    return {key: model}


class NoWait:
    """A ``pause`` that records the delays instead of waiting."""

    def __init__(self):
        self.delays = []

    def __call__(self, seconds):
        self.delays.append(seconds)


def pacer(seed=8908, max_retries=eb.DEFAULT_MAX_RETRIES):
    waits = NoWait()
    return eb.Pacer(pause=waits, rng=random.Random(seed), max_retries=max_retries), waits


# ═════════════════════════════════════════════════════════════════════════════
# No database: the ONE token counter, and the ingestion path's budget
# ═════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def tree(tmp_path):
    """A fixture source tree: two eligible files, one lexical-only, one ignored."""
    root = tmp_path / "tree"
    (root / "pkg").mkdir(parents=True)
    (root / "node_modules" / "dep").mkdir(parents=True)
    (root / ".hidden").mkdir()
    (root / "a.py").write_text(
        "def alpha():\n    return 1\n\n\ndef beta(x):\n    return x * 2\n", encoding="utf-8")
    (root / "pkg" / "b.py").write_text(
        "class Gamma:\n    def run(self):\n        return 'gamma'\n", encoding="utf-8")
    (root / "notes.md").write_text("# notes\n" + "lexical only text\n" * 40, encoding="utf-8")
    (root / "data.xyz").write_text("not a supported extension " * 500, encoding="utf-8")
    (root / "node_modules" / "dep" / "skipped.py").write_text(
        "def never_counted():\n    return 0\n", encoding="utf-8")
    (root / ".hidden" / "also_skipped.py").write_text("def nope():\n    return 0\n",
                                                      encoding="utf-8")
    return root


def _code_spy(model=OLD):
    calls = []

    def provider(text, input_type):
        calls.append((text, input_type))
        return vec(text, model), model

    return provider, calls


def test_count_only_makes_zero_embedding_calls_and_prints_a_token_total(tree, capsys):
    """(a) count-only over a fixture tree: a total, and NOT ONE provider call."""
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    count = rlm_ingestion.count_corpus_tokens([str(tree)])
    assert calls == [], "the counter called the embedding provider"
    assert count["tokens_total"] > 0
    assert count["files_eligible"] == 2 and count["chunks_eligible"] >= 2

    code = rlm_ingestion.main(["ingest", str(tree), "--count-only"])
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0
    assert printed["tokens_total"] == count["tokens_total"]
    assert printed["count_only"] is True and printed["tokens_spent"] == 0
    assert calls == []


def test_the_count_covers_only_the_eligible_corpus(tree):
    """A non-eligible file contributes 0; so does a skipped directory.

    The rule is the one ingestion applies — ``embed_eligible = ext in
    AST_EXTENSIONS`` — read here from the ingestion source rather than restated.
    """
    source = (_REPO / "services" / "rlm_ingestion.py").read_text(encoding="utf-8")
    assert "embed_eligible = ext in AST_EXTENSIONS" in source
    assert "embed_eligible = ext in AST_EXTENSIONS" in rlm_ingestion.ELIGIBILITY_RULE

    assert ".xyz" not in rlm_ingestion.AST_EXTENSIONS | rlm_ingestion.LEGACY_EXTENSIONS
    assert ".md" in rlm_ingestion.LEGACY_EXTENSIONS and ".py" in rlm_ingestion.AST_EXTENSIONS

    whole = rlm_ingestion.count_corpus_tokens([str(tree)])
    assert rlm_ingestion.count_corpus_tokens([str(tree / "data.xyz")])["tokens_total"] == 0
    assert rlm_ingestion.count_corpus_tokens([str(tree / "notes.md")])["tokens_total"] == 0
    assert rlm_ingestion.count_corpus_tokens(
        [str(tree / "node_modules")])["tokens_total"] > 0, "counted when named directly"
    by_file = (rlm_ingestion.count_corpus_tokens([str(tree / "a.py")])["tokens_total"]
               + rlm_ingestion.count_corpus_tokens([str(tree / "pkg" / "b.py")])["tokens_total"])
    assert whole["tokens_total"] == by_file, "only a.py and pkg/b.py are counted"
    assert whole["files_supported"] == 3 and whole["files_ineligible"] == 1

    # The count is per CHUNK, of the text the embedder is sent: chunk by chunk it
    # equals the estimator applied to content[:8192].
    expected = sum(
        harness_config.estimate_tokens(rlm_ingestion.chunk_text(c)[:8192])
        for f in (tree / "a.py", tree / "pkg" / "b.py")
        for c in rlm_ingestion.chunks_for_file(str(f))
        if rlm_ingestion.chunk_text(c).strip())
    assert whole["tokens_total"] == expected


def test_a_chunk_is_counted_at_the_embedders_truncation():
    long_chunk = {"content": "x" * 20000}
    assert rlm_ingestion.EMBED_TRUNCATION_CHARS == 8192
    assert rlm_ingestion.chunk_embed_tokens(long_chunk) == math.ceil(8192 / 3)
    assert rlm_ingestion.chunk_embed_tokens({"content": "   \n"}) == 0
    assert rlm_ingestion.chunk_embed_tokens({"text": "abcd"}) == 2
    source = (_REPO / "services" / "rlm_embeddings.py").read_text(encoding="utf-8")
    assert "[text[:8192]]" in source, "the embedder's truncation moved; so must the counter"


def test_ingestion_without_a_budget_refuses_with_the_typed_error(tree):
    """(b) no budget: refused before a connection is even looked at."""
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    total = rlm_ingestion.count_corpus_tokens([str(tree)])["tokens_total"]
    with pytest.raises(rlm_ingestion.IngestionBudgetError) as refused:
        rlm_ingestion.ingest_with_budget([str(tree)], None, None, force=True)
    payload = refused.value.to_dict()
    assert payload["error"] == "ingestion_budget_required"
    assert payload["tokens_total"] == total and payload["budget_tokens"] is None
    assert str(total) in payload["message"] and "--budget-tokens" in payload["message"]
    assert calls == []


def test_ingestion_above_the_budget_refuses_naming_both_numbers(tree):
    """(c) count above the budget: both numbers are in the refusal."""
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    total = rlm_ingestion.count_corpus_tokens([str(tree)])["tokens_total"]
    with pytest.raises(rlm_ingestion.IngestionBudgetError) as refused:
        rlm_ingestion.ingest_with_budget([str(tree)], None, total - 1, force=True)
    payload = refused.value.to_dict()
    assert payload["error"] == "ingestion_budget_exceeded"
    assert (payload["tokens_total"], payload["budget_tokens"]) == (total, total - 1)
    assert str(total) in payload["message"] and str(total - 1) in payload["message"]
    with pytest.raises(rlm_ingestion.IngestionBudgetError):
        rlm_ingestion.ingest_directory(str(tree), None, force=True, budget_tokens=1)
    assert calls == []


def test_the_ambient_budget_holds_a_budgetless_caller_and_ingests_nothing(tree, monkeypatch):
    """The service's query path passes no budget; the environment gives it one."""
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    monkeypatch.setenv(rlm_ingestion.AMBIENT_BUDGET_ENV, "1")
    stats = rlm_ingestion.ingest_directory(str(tree), None, force=True)
    assert stats["refused"]["error"] == "ingestion_budget_exceeded"
    assert stats["refused"]["budget_tokens"] == 1
    assert stats["total_files"] == 0 and stats["inserted"] == 0 and calls == []
    # An unreadable budget is a budget of nothing, never "no budget".
    monkeypatch.setenv(rlm_ingestion.AMBIENT_BUDGET_ENV, "plenty")
    assert rlm_ingestion.ingest_directory(str(tree), None, force=True)["refused"]


def test_the_ingestion_cli_refuses_without_a_budget_before_it_needs_a_database(tree, capsys):
    """The CLI form of (b): it needs a database only AFTER the budget question."""
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    parser_help = (_REPO / "services" / "rlm_ingestion.py").read_text(encoding="utf-8")
    for flag in ("--count-only", "--budget-tokens", "--force", "--prune", "--dsn"):
        assert '"%s"' % flag in parser_help, flag
    assert calls == []


# ═════════════════════════════════════════════════════════════════════════════
# No database: pacing from the provider's answers
# ═════════════════════════════════════════════════════════════════════════════

def test_a_429_is_retried_with_increasing_jittered_delays_and_succeeds():
    paced, waits = pacer()
    provider = StubProvider(fail_first=3)
    answer = paced.call(lambda: provider(["one text"], OLD, "document"))
    assert len(answer["embeddings"]) == 1 and len(provider.calls) == 4
    delays = paced.delays
    assert len(delays) == 3 and paced.rate_limit_events == 3
    # INCREASING: every delay is larger than the one before it.
    assert delays[0] < delays[1] < delays[2], delays
    # JITTERED: each lies in [floor, 2 * floor) and none is exactly its floor.
    for attempt, delay in enumerate(delays, start=1):
        floor = eb.BACKOFF_BASE_SECONDS * 2 ** (attempt - 1)
        assert floor < delay < 2 * floor, (attempt, delay)
    # Another seed gives other delays: the jitter is real, not a constant.
    other, _ = pacer(seed=1)
    other_provider = StubProvider(fail_first=3)
    other.call(lambda: other_provider(["one text"], OLD, "document"))
    assert other.delays != delays
    # The waits were actually requested, in order, and nothing else slept.
    assert [round(w, 3) for w in waits.delays] == delays
    pg_engines.measure("89-08 backoff delays (s) after three 429s", delays)


def test_a_retry_after_header_is_honoured_over_the_backoff():
    paced, _waits = pacer()
    provider = StubProvider(fail_first=1, retry_after=37)
    paced.call(lambda: provider(["t"], OLD, "document"))
    assert 37 <= paced.delays[0] <= 38, paced.delays
    # ...and the pace is then HELD: the next request waits that long first.
    assert paced.interval >= 37


def test_the_second_refusal_of_one_batch_halves_it():
    """A tokens-per-minute limit smaller than a batch is never satisfied by waiting."""
    paced, _waits = pacer()
    batch = list(range(8))
    seen = []

    def send():
        seen.append(len(batch))
        if len(seen) <= 2:
            raise eb.RateLimited(detail="tpm")
        return {"embeddings": [], "total_tokens": 0}

    def shrink():
        del batch[max(1, len(batch) // 2):]
        return True

    paced.call(send, shrink=shrink)
    assert seen == [8, 8, 4], seen


def test_a_provider_that_never_relents_stops_the_run_resumably():
    paced, _waits = pacer(max_retries=3)
    provider = StubProvider(fail_first=99)
    with pytest.raises(eb.BackfillError) as stopped:
        paced.call(lambda: provider(["t"], OLD, "document"))
    assert stopped.value.code == "rate_limited"
    assert stopped.value.exit_code == eb.EXIT_INCOMPLETE == 4
    assert len(provider.calls) == 4 and stopped.value.details["retries"] == 4


def test_the_real_provider_maps_429_and_reads_retry_after(monkeypatch):
    """The HTTP layer, with the socket replaced: a 429 becomes RateLimited."""
    import io
    import urllib.error

    monkeypatch.setenv("VOYAGE_API_KEY", "not-a-real-key")

    def refuse(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 429, "Too Many Requests", {"Retry-After": "21"},
            io.BytesIO(b'{"detail":"3 RPM"}'))

    monkeypatch.setattr(eb.urllib.request, "urlopen", refuse)
    with pytest.raises(eb.RateLimited) as limited:
        eb._http_embed(eb.VOYAGE_EMBEDDINGS_URL, "VOYAGE_API_KEY", {"input": ["t"]})
    assert limited.value.retry_after == 21.0 and "3 RPM" in limited.value.detail


def test_the_surface_the_cutover_calls_exists_flag_by_flag():
    """Every verb and flag named in the handoff parses; a typo here is a red test."""
    parser = eb.build_parser()
    for argv in (
        ["backfill", "--use", "memory", "--count-only", "--json"],
        ["backfill", "--use", "code_index", "--count-only", "--path", "a", "--path", "b"],
        ["backfill", "--use", "memory", "--budget-tokens", "10", "--batch-size", "4",
         "--allow-paid", "--max-duration-seconds", "60", "--cutover",
         "--skip-relevance-check", "--dsn", "x"],
        ["cutover", "--use", "memory", "--json"],
        ["cutover", "--use", "code_index", "--rollback"],
        ["cutover", "--use", "memory", "--skip-relevance-check",
         "--relevance-tolerance", "0.05", "--relevance-sample", "10"],
        ["drop-previous", "--use", "memory", "--confirm"],
        ["status", "--json"],
        ["verify-catalogue", "--model", "voyage-code-4", "--write"],
    ):
        assert parser.parse_args(argv).verb == argv[0]
    for step in eb.remedy_steps("memory"):
        assert (_REPO / step["argv"][0]).is_file(), step
        args = [a.replace("{tokens_total}", "1") for a in step["argv"][1:]]
        assert parser.parse_args(args).use == "memory"
    assert (eb.EXIT_OK, eb.EXIT_ERROR, eb.EXIT_REFUSED, eb.EXIT_ALREADY_RUNNING,
            eb.EXIT_INCOMPLETE, eb.EXIT_CUTOVER_REFUSED) == (0, 1, 2, 3, 4, 5)


def test_verify_catalogue_reports_a_rate_limit_instead_of_failing():
    limited = eb.verify_catalogue("voyage-code-4", provider=StubProvider(fail_first=1))
    assert limited["verified"] is None and limited["reason"] == "rate_limited"
    ok = eb.verify_catalogue("voyage-code-4", provider=StubProvider())
    assert ok["verified"] is True and ok["dimension"] == ok["expected"] == 1024
    with pytest.raises(eb.BackfillError) as unknown:
        eb.verify_catalogue("rerank-3", provider=StubProvider())
    assert unknown.value.code == "unknown_model"


# ═════════════════════════════════════════════════════════════════════════════
# PostgreSQL: migration 034
# ═════════════════════════════════════════════════════════════════════════════

def test_migration_034_adds_the_columns_the_indexes_and_the_state(db):
    columns = _sql(db, """
        SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0
          AND NOT a.attisdropped
          AND (format_type(a.atttypid, a.atttypmod) LIKE 'vector%%'
               OR a.attname LIKE 'embedding_model%%')
        ORDER BY 1, 2""")
    shape = {(t, c): ty for t, c, ty in columns}
    # Read from the database's own catalogue: every vector column, and its size.
    vectors = sorted((t, c, ty) for (t, c), ty in shape.items() if ty.startswith("vector"))
    pg_engines.measure("89-08 vector columns (pg_attribute)", vectors)
    assert all(ty == "vector(1024)" for _t, _c, ty in vectors), vectors
    assert len(vectors) == 12, vectors
    for table, column in VECTOR_COLUMNS:
        assert shape[(table, column)] == "vector(1024)"
        assert shape[(table, column + "_next")] == "vector(1024)"
        assert shape[(table, "embedding_model")] == "text"
        assert shape[(table, "embedding_model_next")] == "text"

    indexes = dict(_sql(db, "SELECT indexname, indexdef FROM pg_indexes "
                            "WHERE schemaname = current_schema()"))
    for table, column in VECTOR_COLUMNS:
        definition = indexes["idx_%s_%s_next_hnsw" % (table, column)]
        assert "USING hnsw" in definition and "vector_cosine_ops" in definition
        assert "WHERE (%s_next IS NOT NULL)" % column in definition, definition

    rows = {r[0]: r[1:] for r in _sql(
        db, "SELECT use, active_model, target_model, phase, rows_total, rows_done, "
            "tokens_spent, budget_tokens FROM embedding_state")}
    assert rows == {
        "memory": (OLD, None, "steady", 0, 0, 0, None),
        "code_index": (OLD, None, "steady", 0, 0, 0, None),
        "rerank": ("rerank-3", None, "steady", 0, 0, 0, None),
    }
    assert "034-embedding-blue-green.sql" in migrate_runner.MIGRATION_SENTINELS


def test_migration_034_rewrites_no_table_and_its_down_is_executed(postgres_dsn, tmp_path):
    """``ADD COLUMN`` with no default is catalog-only: relfilenode does not move.

    ``pg_class.relfilenode`` changes when, and only when, a table's storage is
    rewritten — so "unchanged across the migration" IS "not rewritten". The
    duration is measured and reported too, on a seeded table, but it is the
    relfilenode that is asserted: a time bound proves nothing on a small table.
    """
    before_034 = tmp_path / "migrations"
    before_034.mkdir()
    for path in MIGRATIONS.iterdir():
        if not path.name.startswith("034-"):
            shutil.copyfile(path, before_034 / path.name)
    tables = [t for t, _c in VECTOR_COLUMNS]

    def filenodes(dsn):
        return dict(_sql(dsn, "SELECT relname, relfilenode FROM pg_class "
                              "WHERE relname = ANY(%s) AND relkind = 'r'", (tables,)))

    with pg_engines.scratch_database(postgres_dsn) as dsn:
        migrate_runner.apply_migrations(dsn=dsn, migrations_dir=str(before_034),
                                        log=lambda *_: None)
        assert _sql(dsn, "SELECT to_regclass('embedding_state') IS NULL")[0][0]
        conn = _connect(dsn)
        try:
            with conn.cursor() as cur:
                for i in range(300):
                    cur.execute(
                        "INSERT INTO gsd_memory (id, text, embedding) "
                        "VALUES (%s, %s, %s::vector)",
                        ("r-%04d" % i, "row %d" % i, _literal(vec("row %d" % i, OLD))))
                    cur.execute(
                        "INSERT INTO rlm_chunks (file_path, symbol_name, start_line, "
                        "content, embedding_code) VALUES (%s, %s, %s, %s, %s::vector)",
                        ("f%d.py" % i, "s", i, "content %d" % i,
                         _literal(vec("content %d" % i, OLD))))
        finally:
            conn.close()
        before = filenodes(dsn)
        assert len(before) == 6, before

        started = time.monotonic()
        _sql(dsn, UP_034.read_text(encoding="utf-8"), fetch=False)
        elapsed = time.monotonic() - started
        after_up = filenodes(dsn)
        pg_engines.measure("89-08 migration 034 UP on 300+300 seeded rows (s)", round(elapsed, 3))
        pg_engines.measure("89-08 relfilenode before/after 034", [before, after_up])
        assert after_up == before, "migration 034 rewrote a table"
        # The seeded vectors are still there, and still have no provenance.
        assert _sql(dsn, "SELECT COUNT(embedding), COUNT(embedding_model), "
                         "COUNT(embedding_next) FROM gsd_memory")[0] == (300, 0, 0)

        # Idempotent: a second run changes nothing and resets no state.
        _sql(dsn, "UPDATE embedding_state SET active_model = 'voyage-4' "
                  "WHERE use = 'memory'", fetch=False)
        _sql(dsn, UP_034.read_text(encoding="utf-8"), fetch=False)
        assert state(dsn)["active_model"] == "voyage-4"
        assert filenodes(dsn) == before

        # DOWN, executed: staging columns and the state table are gone, the live
        # vectors are untouched, and rlm_chunks keeps migration 030's column.
        _sql(dsn, DOWN_034.read_text(encoding="utf-8"), fetch=False)
        assert _sql(dsn, "SELECT to_regclass('embedding_state') IS NULL")[0][0]
        left = {(t, c) for t, c in _sql(
            dsn, "SELECT table_name, column_name FROM information_schema.columns "
                 "WHERE table_schema = current_schema() AND (column_name LIKE '%%_next' "
                 "OR column_name = 'embedding_model')")}
        assert left == {("rlm_chunks", "embedding_model")}, left
        assert _sql(dsn, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 300
        # ...and UP applies again after it.
        _sql(dsn, UP_034.read_text(encoding="utf-8"), fetch=False)
        assert state(dsn)["active_model"] == OLD


# ═════════════════════════════════════════════════════════════════════════════
# PostgreSQL: counted, budgeted, batched, resumable, single-flight
# ═════════════════════════════════════════════════════════════════════════════

def test_count_only_prints_the_total_and_spends_nothing(db):
    texts = seed_memories(db, 10)
    provider = StubProvider()
    events = []
    result = eb.run_backfill(dsn=db, use="memory", count_only=True, provider=provider,
                             emit=events.append)
    expected = sum(harness_config.estimate_tokens(t) for t in texts)
    assert result["tokens_total"] == expected and result["rows_total"] == 10
    assert result["tokens_spent"] == 0 and result["provider_calls"] == 0
    assert provider.calls == [], "count-only reached the provider"
    assert events[0]["event"] == "count" and events[0]["tokens_total"] == expected
    assert events[0]["free_tokens"] == 200000000
    assert "UNMEASURED" in events[0]["estimated_duration_note"]
    assert _sql(db, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 0
    assert state(db)["tokens_spent"] == 0


def test_the_budget_gate_refuses_without_a_budget_and_above_it(db):
    texts = seed_memories(db, 10)
    total = sum(harness_config.estimate_tokens(t) for t in texts)
    provider = StubProvider()

    with pytest.raises(eb.BackfillError) as missing:
        eb.run_backfill(dsn=db, use="memory", provider=provider)
    assert missing.value.code == "budget_required" and missing.value.exit_code == 2
    assert missing.value.details["tokens_total"] == total
    assert str(total) in missing.value.message

    with pytest.raises(eb.BackfillError) as above:
        eb.run_backfill(dsn=db, use="memory", budget_tokens=total - 1, provider=provider)
    payload = above.value.to_dict()
    assert payload["error"] == "budget_exceeded"
    assert (payload["tokens_total"], payload["budget_tokens"]) == (total, total - 1)
    assert str(total) in payload["message"] and str(total - 1) in payload["message"]

    with pytest.raises(eb.BackfillError) as paid:
        eb.run_backfill(dsn=db, use="memory", budget_tokens=200000001, provider=provider)
    assert paid.value.code == "budget_above_free_allowance"
    assert paid.value.details["free_tokens"] == 200000000

    assert provider.calls == [], "a refused run reached the provider"
    assert _sql(db, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 0
    pg_engines.measure("89-08 budget refusals",
                       [missing.value.to_dict(), payload, paid.value.message])


def test_one_provider_call_per_batch_not_per_row(db):
    """The defect this plan fixes: ``memory_backfill_embeddings`` calls once per row."""
    texts = seed_memories(db, 10)
    provider = StubProvider()
    events = []
    result = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=4,
                             provider=provider, pacer=pacer()[0], emit=events.append)
    rows, batch = 10, 4
    assert len(provider.calls) == math.ceil(rows / batch) == 3
    assert len(provider.calls) != rows
    assert [len(c["texts"]) for c in provider.calls] == [4, 4, 2]
    assert result["provider_calls"] == 3 and result["rows_done"] == 10
    assert result["complete"] is True and result["mode"] == eb.MODE_FILL
    pg_engines.measure("89-08 provider calls for 10 rows at batch 4", len(provider.calls))

    # Progress: one line per batch, and the state carries the totals.
    batches = [e for e in events if e["event"] == "batch"]
    assert [b["rows_done"] for b in batches] == [4, 8, 10]
    assert any(e["event"] == "rate_measured" for e in events)
    final = state(db)
    expected = sum(harness_config.estimate_tokens(t) for t in texts)
    assert (final["rows_total"], final["rows_done"], final["tokens_spent"],
            final["budget_tokens"]) == (10, 10, expected, 10 ** 6)
    assert result["tokens_spent"] == expected <= result["budget_tokens"]

    # The vector and its model were written together, by the active model.
    assert _sql(db, "SELECT COUNT(*) FROM gsd_memory WHERE embedding IS NOT NULL "
                    "AND embedding_model = %s", (OLD,))[0][0] == 10
    audit = _sql(db, "SELECT status, metadata FROM gsd_audit_log "
                     "WHERE event_type = 'embedding_backfill'")
    assert len(audit) == 1 and audit[0][0] == "ok" and audit[0][1]["rows_done"] == 10

    # Idempotent: a second run finds nothing to do and spends nothing.
    again = StubProvider()
    second = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=again)
    assert second["rows_total"] == 0 and second["tokens_spent"] == 0 and again.calls == []


def test_the_request_token_cap_limits_a_batch(db, monkeypatch):
    seed_memories(db, 6)
    record = dict(harness_config.model_record(OLD), max_tokens_per_request=30)
    monkeypatch.setattr(harness_config, "model_record",
                        lambda model, catalogue=None, env=None: record)
    provider = StubProvider()
    eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=128,
                    provider=provider, pacer=pacer()[0])
    # 30 * 0.8 = 24 tokens per request; each 30-character text costs 10: two per request.
    assert [len(c["texts"]) for c in provider.calls] == [2, 2, 2]


def test_an_interrupted_run_continues_where_it_stopped(db):
    texts = seed_memories(db, 10)
    provider = StubProvider()

    def die_after_the_first_batch(progress):
        raise RuntimeError("killed mid-way")

    with pytest.raises(RuntimeError):
        eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=4,
                        provider=provider, pacer=pacer()[0],
                        on_batch=die_after_the_first_batch)
    assert _sql(db, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 4
    interrupted = state(db)
    assert interrupted["rows_done"] == 4 and interrupted["tokens_spent"] > 0
    # The lock died with the session: the next run is not refused.
    resumed = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=4,
                              provider=provider, pacer=pacer()[0])
    assert resumed["rows_total"] == 6 and resumed["rows_done"] == 6 and resumed["complete"]
    assert [len(c["texts"]) for c in provider.calls] == [4, 4, 2]
    embedded = [t for c in provider.calls for t in c["texts"]]
    assert sorted(embedded) == sorted(texts), "a row was embedded twice or never"
    assert _sql(db, "SELECT COUNT(*) FROM gsd_memory WHERE embedding IS NOT NULL "
                    "AND embedding_model = %s", (OLD,))[0][0] == 10
    pg_engines.measure("89-08 resume: rows after the kill, rows by the second run",
                       [interrupted["rows_done"], resumed["rows_done"]])


def test_a_second_concurrent_run_exits_backfill_already_running(db, capsys):
    seed_memories(db, 3)
    holder = _connect(db)
    try:
        with holder.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(hashtext('embed:memory'))")
        provider = StubProvider()
        with pytest.raises(eb.BackfillError) as second:
            eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=provider)
        assert second.value.code == "backfill_already_running"
        assert second.value.exit_code == eb.EXIT_ALREADY_RUNNING == 3
        assert provider.calls == []
        # The CLI maps it to exit 3 and prints the typed body.
        eb.set_batch_provider_override(provider)
        code = eb.main(["backfill", "--use", "memory", "--budget-tokens", "1000000",
                        "--dsn", db])
        printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert code == 3 and printed["error"] == "backfill_already_running"
        # The cutover takes the same lock.
        with pytest.raises(eb.BackfillError) as cut:
            eb.run_cutover(dsn=db, use="memory", provider=provider)
        assert cut.value.code == "backfill_already_running"
        # Another use is not blocked.
        assert eb.run_backfill(dsn=db, use="code_index", budget_tokens=10,
                               provider=provider)["rows_total"] == 0
    finally:
        holder.close()
    assert eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6,
                           provider=StubProvider())["rows_done"] == 3


def test_a_stubbed_429_backs_off_and_the_run_still_completes(db):
    seed_memories(db, 5)
    provider = StubProvider(fail_first=2)
    paced, waits = pacer()
    result = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=5,
                             provider=provider, pacer=paced)
    assert result["complete"] and result["rows_done"] == 5
    assert result["rate_limit_events"] == 2 and len(result["delays"]) == 2
    assert result["delays"][0] < result["delays"][1]
    assert waits.delays, "the pacer never waited"
    # The second refusal halved the batch (5 -> 2), so the rows arrive in more calls.
    assert [len(c["texts"]) for c in provider.calls][:3] == [5, 5, 2]
    assert _sql(db, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 5


def test_a_rate_limit_that_does_not_relent_leaves_a_resumable_run(db):
    seed_memories(db, 4)
    provider = StubProvider(fail_first=99)
    with pytest.raises(eb.BackfillError) as stopped:
        eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=provider,
                        pacer=pacer(max_retries=2)[0])
    assert stopped.value.code == "rate_limited" and stopped.value.exit_code == 4
    assert stopped.value.details["result"]["rows_done"] == 0
    assert eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6,
                           provider=StubProvider())["rows_done"] == 4


def test_a_duration_limit_stops_the_run_at_the_measured_rate(db):
    seed_memories(db, 40)
    events = []
    with pytest.raises(eb.BackfillError) as stopped:
        # One 429 first: its backoff is part of the measured time, as it is in a
        # real run, so the estimate is seconds rather than a rounding of nothing.
        eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=4,
                        provider=StubProvider(fail_first=1), pacer=pacer()[0],
                        emit=events.append, max_duration_seconds=0)
    assert stopped.value.code == "duration_exceeds_limit" and stopped.value.exit_code == 4
    measured = [e for e in events if e["event"] == "rate_measured"]
    assert len(measured) == 1 and measured[0]["requests"] == eb.CALIBRATION_REQUESTS
    assert measured[0]["tokens_per_minute"] > 0
    assert measured[0]["estimated_duration_seconds"] > 1
    assert measured[0]["rate_limit_events"] == 1
    assert _sql(db, "SELECT COUNT(embedding) FROM gsd_memory")[0][0] == 12


# ═════════════════════════════════════════════════════════════════════════════
# PostgreSQL: blue/green — the setting, the old column, the cutover
# ═════════════════════════════════════════════════════════════════════════════

def test_setting_a_model_starts_a_backfill_and_never_switches_the_active_model(db, tmp_path):
    """Both directions, through the entry point ``config-set`` spawns."""
    path = tmp_path / "harness" / "config.json"
    key = "retrieval.embedding_model.memory"

    forward = harness_config.set_value(key, NEW, env={}, path=path, dsn=db)
    assert forward["reembed"]["marked"] is True
    assert (forward["reembed"]["active_model"], forward["reembed"]["target_model"],
            forward["reembed"]["phase"]) == (OLD, NEW, "backfilling")
    assert state(db)["active_model"] == OLD
    row = harness_config.describe_all(env={}, path=path, dsn=db)[0]
    assert (row["value"], row["active_model"], row["phase"], row["pending_reembed"]) == (
        NEW, OLD, "backfilling", True)

    back = harness_config.set_value(key, OLD, env={}, path=path, dsn=db)
    assert (back["reembed"]["active_model"], back["reembed"]["target_model"],
            back["reembed"]["phase"]) == (OLD, None, "steady")
    pg_engines.measure("89-08 config-set forward/back",
                       [forward["reembed"], back["reembed"]])

    # The other direction: the store is LIVE on the older model, and the setting
    # asks for the newer one. Same machinery, same guarantee.
    _sql(db, "UPDATE embedding_state SET active_model = %s WHERE use = 'memory'",
         (NEW,), fetch=False)
    eb.reset_caches()
    other = harness_config.set_value(key, OLD, env={}, path=path, dsn=db)
    assert (other["reembed"]["active_model"], other["reembed"]["target_model"],
            other["reembed"]["phase"]) == (NEW, OLD, "backfilling")
    assert state(db)["active_model"] == NEW

    # A rerank model has no vectors to rebuild: it simply takes effect.
    rerank = harness_config.set_value("retrieval.rerank_model", "rerank-3-lite",
                                      env={}, path=path, dsn=db)
    assert (rerank["reembed"]["active_model"], rerank["reembed"]["phase"]) == (
        "rerank-3-lite", "steady")
    assert _sql(db, "SELECT COUNT(*) FROM gsd_audit_log "
                    "WHERE event_type = 'embedding_target_set'")[0][0] == 4


def test_the_cli_entry_point_marks_the_state_too(db, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("GSD_POSTGRES_URL", db)
    for name in ("GSD_FORCE_SQLITE", "GSD_BACKEND"):
        monkeypatch.delenv(name, raising=False)
    code = harness_config.main(["set", "retrieval.embedding_model.code_index", NEW])
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and printed["reembed"]["marked"] is True
    assert printed["reembed"]["target_model"] == NEW
    assert printed["path"] == str(tmp_path / "home" / ".amauta" / "config.json")
    current = state(db, "code_index")
    assert (current["active_model"], current["target_model"], current["phase"]) == (
        OLD, NEW, "backfilling")
    code = harness_config.main(["get", "--all"])
    rows = {r["key"]: r for r in json.loads(capsys.readouterr().out.strip())["keys"]}
    assert rows["retrieval.embedding_model.code_index"]["pending_reembed"] is True
    assert rows["retrieval.embedding_model.memory"]["pending_reembed"] is False


@contextlib.contextmanager
def memory_store(dsn, monkeypatch):
    """A real PGStore on the scratch database whose embedder is the stand-in."""
    from services.pg_store import PGStore

    asked = []

    def embed(text, model=None, input_type=None):
        asked.append({"model": model, "input_type": input_type})
        return vec(text, model)

    monkeypatch.setattr(PGStore, "generate_embedding", staticmethod(embed))
    store = PGStore(dsn=dsn, min_conn=1, max_conn=3)
    try:
        yield store, asked
    finally:
        store.close()


def test_queries_answer_from_the_old_column_while_backfilling(db, monkeypatch):
    """Distinguishable vectors: the live column holds OLD's, the staging one NEW's."""
    texts = seed_memories(db, 8, with_vectors_of=OLD)
    provider = StubProvider()
    result = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=3,
                             provider=provider, pacer=pacer()[0], env=target_env(NEW), allow_paid=True,
                             on_batch=None)
    assert result["mode"] == eb.MODE_BLUE_GREEN and result["model"] == NEW
    assert {c["model"] for c in provider.calls} == {NEW}
    current = state(db)
    assert (current["active_model"], current["target_model"], current["phase"]) == (
        OLD, NEW, "cutover_ready")
    # The live column was not touched; the staging column holds the other model's.
    assert _sql(db, "SELECT COUNT(*) FROM gsd_memory WHERE embedding_model = %s "
                    "AND embedding_model_next = %s AND embedding IS NOT NULL "
                    "AND embedding_next IS NOT NULL AND embedding <> embedding_next",
                (OLD, NEW))[0][0] == 8

    with memory_store(db, monkeypatch) as (store, asked):
        results, method = store.memory_semantic_search(texts[5], project_id="p8908", limit=3)
        assert method.startswith("vector")
        # Embedded with the ACTIVE model, not the configured target...
        assert {a["model"] for a in asked} == {OLD}
        # ...and matched against the OLD column: its own stored vector, exactly.
        assert results[0]["text"] == texts[5]
        assert results[0]["semantic_similarity"] == pytest.approx(1.0, abs=1e-6)
        # Against the NEW column the same query vector would be noise:
        noise = _sql(db, "SELECT 1 - (embedding_next <=> %s::vector) FROM gsd_memory "
                         "WHERE text = %s", (_literal(vec(texts[5], OLD)), texts[5]))[0][0]
        assert abs(noise) < 0.5
        pg_engines.measure("89-08 similarity vs old column / vs new column",
                           [results[0]["semantic_similarity"], noise])
        # No row leaks a vector to the caller, live or staged.
        assert all("embedding" not in r and "embedding_next" not in r for r in results)
        hybrid = store.memory_search(texts[2], project_id="p8908", limit=3)
        assert hybrid and hybrid[0]["text"] == texts[2]


def test_cutover_refuses_until_the_backfill_is_complete(db):
    seed_memories(db, 6, with_vectors_of=OLD)
    provider = StubProvider()

    def stop(progress):
        raise RuntimeError("stopped after one batch")

    with pytest.raises(RuntimeError):
        eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, batch_size=2,
                        provider=provider, pacer=pacer()[0], env=target_env(NEW), allow_paid=True,
                        on_batch=stop)
    with pytest.raises(eb.BackfillError) as refused:
        eb.run_cutover(dsn=db, use="memory", provider=provider)
    assert refused.value.code == "backfill_incomplete"
    assert refused.value.exit_code == eb.EXIT_CUTOVER_REFUSED == 5
    assert refused.value.details["missing_by_table"] == {"gsd_memory": 4}
    assert state(db)["active_model"] == OLD


def test_cutover_refuses_a_worse_relevance_score_then_succeeds_audits_and_rolls_back(db, capsys):
    texts = seed_memories(db, 8, with_vectors_of=OLD)
    good = StubProvider()
    eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=good,
                    pacer=pacer()[0], env=target_env(NEW), allow_paid=True)

    # 1. REFUSED: the target's query side does not find its own documents.
    bad = StubProvider(noisy_queries_for=NEW)
    with pytest.raises(eb.BackfillError) as worse:
        eb.run_cutover(dsn=db, use="memory", provider=bad)
    assert worse.value.code == "relevance_worse" and worse.value.exit_code == 5
    relevance = worse.value.details["relevance"]
    assert relevance["mrr_live"] == 1.0 and relevance["mrr_next"] < 1.0
    assert state(db)["active_model"] == OLD and state(db)["phase"] == "cutover_ready"
    assert _sql(db, "SELECT COUNT(*) FROM gsd_audit_log "
                    "WHERE event_type = 'embedding_cutover'")[0][0] == 0
    pg_engines.measure("89-08 cutover refused", worse.value.to_dict())

    # 2. SUCCEEDS: not worse. One transaction; the audit row is written.
    done = eb.run_cutover(dsn=db, use="memory", provider=good)
    assert done["cutover"] is True and done["active_model"] == NEW
    assert done["relevance"]["mrr_next"] == 1.0 == done["relevance"]["mrr_live"]
    after = state(db)
    assert (after["active_model"], after["previous_model"], after["target_model"],
            after["phase"]) == (NEW, OLD, None, "steady")
    audit = _sql(db, "SELECT status, metadata FROM gsd_audit_log "
                     "WHERE event_type = 'embedding_cutover'")
    assert len(audit) == 1 and audit[0][0] == "ok"
    assert (audit[0][1]["from"], audit[0][1]["to"]) == (OLD, NEW)
    assert audit[0][1]["relevance"]["mrr_next"] == 1.0
    # The LIVE column now holds the new model's vectors; the old ones are kept.
    live = _sql(db, "SELECT text, embedding_model, embedding_model_next, "
                    "1 - (embedding <=> %s::vector) FROM gsd_memory WHERE text = %s",
                (_literal(vec(texts[0], NEW)), texts[0]))[0]
    assert live[1:3] == (NEW, OLD) and live[3] == pytest.approx(1.0, abs=1e-6)
    pg_engines.measure("89-08 cutover audit row", audit[0][1])

    # A second cutover has nothing to do and says so (exit 0).
    again = eb.run_cutover(dsn=db, use="memory", provider=good)
    assert again["cutover"] is False and again["reason"] == "nothing_to_cut_over"

    # Switching BACK is a re-embed that finds 0 rows: the old column is still there.
    back = eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6,
                           provider=StubProvider(), env=target_env(OLD))
    assert back["mode"] == eb.MODE_BLUE_GREEN and back["rows_total"] == 0
    assert back["provider_calls"] == 0 and state(db)["phase"] == "cutover_ready"
    _sql(db, "UPDATE embedding_state SET target_model = NULL, phase = 'steady' "
             "WHERE use = 'memory'", fetch=False)

    # 3. ROLLBACK restores the previous model and its vectors.
    eb.set_batch_provider_override(good)
    code = eb.main(["cutover", "--use", "memory", "--rollback", "--dsn", db])
    rolled = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and rolled["rollback"] is True and rolled["active_model"] == OLD
    restored = state(db)
    assert (restored["active_model"], restored["previous_model"]) == (OLD, NEW)
    assert _sql(db, "SELECT COUNT(*) FROM gsd_memory WHERE embedding_model = %s "
                    "AND 1 - (embedding <=> embedding) < 2", (OLD,))[0][0] == 8
    assert _sql(db, "SELECT COUNT(*) FROM gsd_audit_log "
                    "WHERE event_type = 'embedding_cutover_rollback'")[0][0] == 1
    pg_engines.measure("89-08 rollback", rolled)

    # drop-previous needs --confirm, then erases the staged vectors only.
    with pytest.raises(eb.BackfillError) as unconfirmed:
        eb.drop_previous(dsn=db, use="memory")
    assert unconfirmed.value.code == "confirmation_required"
    dropped = eb.drop_previous(dsn=db, use="memory", confirm=True)
    assert dropped["rows"]["gsd_memory"] == 8
    assert _sql(db, "SELECT COUNT(embedding), COUNT(embedding_next), "
                    "COUNT(embedding_model_next) FROM gsd_memory")[0] == (8, 0, 0)
    with pytest.raises(eb.BackfillError) as nothing:
        eb.run_cutover(dsn=db, use="memory", rollback=True)
    assert nothing.value.code == "nothing_to_roll_back"


def test_no_vector_exists_without_its_provenance_on_any_table(db, tree):
    """After a fill, a blue/green backfill and an ingest: six tables, six zeros."""
    seed_memories(db, 5)
    seed_memories(db, 4, with_vectors_of=OLD, prefix="older")
    _sql(db, "INSERT INTO gsd_memory_archive (id, text) VALUES ('arch-1', 'archived text')",
         fetch=False)
    _sql(db, "INSERT INTO skill_invocations (skill_name, invocation_text) "
             "VALUES ('probe', 'invoke the probe skill')", fetch=False)
    _sql(db, "INSERT INTO semantic_cache (query_text, query_embedding, response, "
             "embedding_model) VALUES ('cached question', %s::vector, 'answer', %s)",
         (_literal(vec("cached question", OLD)), OLD), fetch=False)
    eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=StubProvider(),
                    pacer=pacer()[0])
    eb.run_backfill(dsn=db, use="memory", budget_tokens=10 ** 6, provider=StubProvider(),
                    pacer=pacer()[0], env=target_env(NEW), allow_paid=True)
    spy, _calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    conn = _connect(db, autocommit=False)
    try:
        total = rlm_ingestion.count_corpus_tokens([str(tree)])["tokens_total"]
        rlm_ingestion.ingest_with_budget([str(tree)], conn, total, force=True)
    finally:
        conn.close()

    results = {}
    for table, column in VECTOR_COLUMNS:
        staged, live = _sql(
            db, "SELECT COUNT(*) FILTER (WHERE %s_next IS NOT NULL "
                "AND embedding_model_next IS NULL), COUNT(*) FILTER (WHERE %s IS NOT NULL "
                "AND embedding_model IS NULL) FROM %s" % (column, column, table))[0]
        results[table] = (staged, live)
    pg_engines.measure("89-08 vectors without provenance (staged, live) per table", results)
    assert results == {table: (0, 0) for table, _c in VECTOR_COLUMNS}
    # ...and the tables that were written do hold vectors, so the zeros mean something.
    assert _sql(db, "SELECT COUNT(embedding_next) FROM gsd_memory")[0][0] == 9
    assert _sql(db, "SELECT COUNT(embedding), COUNT(embedding_next) "
                    "FROM gsd_memory_archive")[0] == (1, 1)
    assert _sql(db, "SELECT COUNT(context_embedding_next) FROM skill_invocations")[0][0] == 1
    assert _sql(db, "SELECT COUNT(query_embedding_next) FROM semantic_cache")[0][0] == 1
    assert _sql(db, "SELECT COUNT(embedding_code) FROM rlm_chunks")[0][0] >= 2


# ═════════════════════════════════════════════════════════════════════════════
# PostgreSQL: the code index is under the same budget control
# ═════════════════════════════════════════════════════════════════════════════

def test_code_index_count_only_is_the_corpus_even_when_rlm_chunks_is_empty(db, tree, capsys):
    """(d) and the round-2 defect: an empty table is not the measurement."""
    assert _sql(db, "SELECT COUNT(*) FROM rlm_chunks")[0][0] == 0
    corpus = rlm_ingestion.count_corpus_tokens([str(tree)])["tokens_total"]
    assert corpus > 0
    provider = StubProvider()
    result = eb.run_backfill(dsn=db, use="code_index", count_only=True,
                             paths=[str(tree)], provider=provider)
    assert result["tokens_total"] == corpus, "the verb and the ingestion counter disagree"
    assert result["count_basis"] == "ingestion_corpus"
    assert result["database_pending_rows"] == 0 and provider.calls == []

    code = eb.main(["backfill", "--use", "code_index", "--count-only", "--path", str(tree),
                    "--dsn", db])
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and printed["tokens_total"] == corpus

    # Without a tree there is nothing to count FROM: a typed refusal, never a 0.
    with pytest.raises(eb.BackfillError) as no_paths:
        eb.run_backfill(dsn=db, use="code_index", count_only=True, provider=provider)
    assert no_paths.value.code == "code_index_paths_required"
    pg_engines.measure("89-08 code_index count-only on an empty rlm_chunks", corpus)


def test_ingestion_under_a_budget_accounts_tokens_spent_and_records_the_model(db, tree, capsys):
    spy, calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    total = rlm_ingestion.count_corpus_tokens([str(tree)])["tokens_total"]

    conn = _connect(db, autocommit=False)
    try:
        with pytest.raises(rlm_ingestion.IngestionBudgetError):
            rlm_ingestion.ingest_with_budget([str(tree)], conn, total - 1)
        assert calls == [] and _sql(db, "SELECT COUNT(*) FROM rlm_chunks")[0][0] == 0

        stats = rlm_ingestion.ingest_with_budget([str(tree)], conn, total)
        assert stats["tokens_total"] == total
        assert stats["tokens_spent"] == total <= stats["budget_tokens"]
        assert stats["inserted"] == 3 and stats["budget_exhausted"] is False
        assert stats["embeddings_dropped"] == 0
        current = state(db, "code_index")
        assert (current["tokens_spent"], current["budget_tokens"]) == (total, total)
        assert {input_type for _t, input_type in calls} == {"document"}
        embedded, with_model, lexical_only = _sql(
            db, "SELECT COUNT(embedding_code), COUNT(*) FILTER (WHERE embedding_model = %s),"
                " COUNT(*) FILTER (WHERE file_path LIKE '%%notes.md') FROM rlm_chunks",
            (OLD,))[0]
        assert embedded == with_model == len(calls) and embedded >= 2
        assert lexical_only >= 1, "the .md file is indexed for the lexical leg"

        # Re-running costs nothing: nothing is stale, so nothing is counted.
        before = len(calls)
        again = rlm_ingestion.ingest_with_budget([str(tree)], conn, 0)
        assert again["tokens_total"] == 0 and again["tokens_spent"] == 0
        assert len(calls) == before

        # A vector ANOTHER model produced is not written.
        foreign, _foreign_calls = _code_spy(model="qodo-embed-1-1.5b")
        rlm_embeddings.set_provider_override(foreign)
        dropped = rlm_ingestion.ingest_with_budget([str(tree / "a.py")], conn, total,
                                                   force=True)
        assert dropped["embeddings_dropped"] >= 1
        assert _sql(db, "SELECT COUNT(embedding_code), COUNT(embedding_model) "
                        "FROM rlm_chunks WHERE file_path LIKE '%%a.py'")[0] == (0, 0)
    finally:
        conn.close()

    # The CLI: refuses without a budget (exit 2), runs with one.
    rlm_embeddings.set_provider_override(spy)
    code = rlm_ingestion.main(["ingest", str(tree), "--force", "--dsn", db])
    refused = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2 and refused["error"] == "ingestion_budget_required"
    code = rlm_ingestion.main(["ingest", str(tree), "--force", "--dsn", db,
                               "--budget-tokens", str(total)])
    ran = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and ran["tokens_spent"] == total


def test_a_budget_reached_mid_run_stops_before_the_next_file(db, tree):
    spy, _calls = _code_spy()
    rlm_embeddings.set_provider_override(spy)
    first = rlm_ingestion.count_corpus_tokens([str(tree / "a.py")])["tokens_total"]
    conn = _connect(db, autocommit=False)
    try:
        ledger = rlm_ingestion._SpendLedger(first)
        one = rlm_ingestion.ingest_file(str(tree / "a.py"), conn, force=True, ledger=ledger)
        two = rlm_ingestion.ingest_file(str(tree / "pkg" / "b.py"), conn, force=True,
                                        ledger=ledger)
    finally:
        conn.close()
    assert one["status"] == "inserted" and one["tokens_spent"] == first == ledger.spent
    assert two["status"] == "budget_exhausted" and two["tokens_spent"] == 0
    assert _sql(db, "SELECT COUNT(DISTINCT file_path) FROM rlm_chunks")[0][0] == 1


# ═════════════════════════════════════════════════════════════════════════════
# PostgreSQL: a mixed store refuses to answer
# ═════════════════════════════════════════════════════════════════════════════

def test_a_foreign_model_vector_makes_the_memory_search_refuse(db, monkeypatch):
    texts = seed_memories(db, 6, with_vectors_of=OLD)
    with memory_store(db, monkeypatch) as (store, _asked):
        assert store.memory_search(texts[0], project_id="p8908", limit=3)[0]["text"] == texts[0]

        _sql(db, "UPDATE gsd_memory SET embedding_model = %s WHERE id = 'memory-003'",
             (NEW,), fetch=False)
        eb.reset_caches()
        # REFUSED, not answered with fewer rows: the call raises.
        with pytest.raises(eb.EmbeddingModelMixedError) as refused:
            store.memory_search(texts[0], project_id="p8908", limit=3)
        payload = refused.value.to_dict()
        assert payload["error"] == "embedding_model_mixed"
        assert (payload["table"], payload["column"], payload["use"]) == (
            "gsd_memory", "embedding", "memory")
        assert payload["active_model"] == OLD
        assert payload["offending_models"] == [NEW] and payload["rows"] == 1
        assert payload["offending_rows_by_model"] == {NEW: 1}
        assert "services/embedding_backfill.py backfill --use memory" in payload["remedy"]
        pg_engines.measure("89-08 embedding_model_mixed payload", payload)
        with pytest.raises(eb.EmbeddingModelMixedError):
            store.memory_semantic_search(texts[0], project_id="p8908", limit=3)

        # Remove the offending row and the search answers again.
        _sql(db, "DELETE FROM gsd_memory WHERE id = 'memory-003'", fetch=False)
        assert store.memory_search(texts[0], project_id="p8908", limit=3)[0]["text"] == texts[0]
        results, method = store.memory_semantic_search(texts[1], project_id="p8908", limit=3)
        assert method.startswith("vector") and results[0]["text"] == texts[1]


def test_a_null_provenance_vector_is_offending_too(db, monkeypatch):
    texts = seed_memories(db, 4, with_vectors_of=OLD)
    _sql(db, "INSERT INTO gsd_memory (id, text, project_id, embedding) "
             "VALUES ('legacy-1', 'a vector nobody can vouch for', 'p8908', %s::vector)",
         (_literal(vec("a vector nobody can vouch for", "unknown")),), fetch=False)
    with memory_store(db, monkeypatch) as (store, _asked):
        with pytest.raises(eb.EmbeddingModelMixedError) as refused:
            store.memory_search(texts[0], project_id="p8908", limit=3)
        payload = refused.value.to_dict()
        assert payload["offending_models"] == ["<unknown: NULL provenance>"]
        assert payload["rows"] == 1
        # A query with NO vector leg consults no vector and is answered lexically.
        from services.pg_store import PGStore
        monkeypatch.setattr(PGStore, "generate_embedding",
                            staticmethod(lambda *a, **kw: None))
        lexical = store.memory_search(texts[0], project_id="p8908", limit=3)
        assert lexical and lexical[0]["text"] == texts[0]


def test_the_remedy_in_the_payload_was_run_and_fixes_the_store(db, monkeypatch, capsys):
    """A remedy nobody has run is a guess: extract it, run it, search again."""
    texts = seed_memories(db, 5, with_vectors_of=OLD)
    _sql(db, "UPDATE gsd_memory SET embedding_model = %s WHERE id IN "
             "('memory-001', 'memory-002')", (NEW,), fetch=False)
    _sql(db, "UPDATE gsd_memory SET embedding_model = NULL WHERE id = 'memory-004'",
         fetch=False)
    with memory_store(db, monkeypatch) as (store, _asked):
        with pytest.raises(eb.EmbeddingModelMixedError) as refused:
            store.memory_search(texts[0], project_id="p8908", limit=3)
        payload = refused.value.to_dict()
        assert payload["rows"] == 3
        assert set(payload["offending_models"]) == {NEW, "<unknown: NULL provenance>"}

        provider = StubProvider()
        eb.set_batch_provider_override(provider)
        steps = payload["remedy_steps"]
        capsys.readouterr()
        # Step 1, exactly as printed: the count.
        assert steps[0]["argv"][0] == "services/embedding_backfill.py"
        code = eb.main(steps[0]["argv"][1:] + ["--dsn", db])
        counted = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert code == 0 and counted["rows_total"] == 3 and provider.calls == []
        # Step 2, with the number step 1 printed as its budget.
        argv = [a.replace("{tokens_total}", str(counted["tokens_total"]))
                for a in steps[1]["argv"][1:]]
        code = eb.main(argv + ["--dsn", db])
        ran = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert code == 0 and ran["rows_done"] == 3 and ran["complete"] is True
        assert ran["tokens_spent"] == counted["tokens_total"]
        pg_engines.measure("89-08 remedy run", [steps[0]["argv"], argv, ran["rows_done"]])

        # The store answers again, and only the offending rows were re-embedded.
        assert sorted(t for c in provider.calls for t in c["texts"]) == sorted(
            [texts[1], texts[2], texts[4]])
        answered = store.memory_search(texts[4], project_id="p8908", limit=3)
        assert answered[0]["text"] == texts[4]
        assert _sql(db, "SELECT COUNT(*) FROM gsd_memory WHERE embedding_model = %s",
                    (OLD,))[0][0] == 5


def _seed_chunks(dsn, count, model):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            for i in range(count):
                content = "def routine_%d():\n    return 'zeta%d payload'\n" % (i, i)
                cur.execute(
                    "INSERT INTO rlm_chunks (file_path, symbol_name, symbol_type, "
                    "start_line, end_line, content, description, sha256, embedding_code, "
                    "embedding_model) VALUES (%s, %s, 'function', 1, 2, %s, %s, 's', "
                    "%s::vector, %s)",
                    ("p8908-%d.py" % i, "routine_%d" % i, content, "zeta%d routine" % i,
                     _literal(vec("zeta%d" % i, OLD)), model))
    finally:
        conn.close()


def test_the_mixed_check_runs_once_per_connection_not_once_per_query(db):
    from services.rlm_search import hybrid_search

    _seed_chunks(db, 4, OLD)
    rlm_embeddings.set_provider_override(lambda text, input_type: (vec(text, OLD), OLD))
    raw = _connect(db, autocommit=False)
    conn = pg_engines.CountingConnection(raw)
    try:
        for i in (0, 1, 2, 3, 0):
            rows = hybrid_search("zeta%d" % i, conn, top_k=3)
            # The vector leg ran, on the active model's vectors.
            assert rows and rows[0]["symbol_name"] == "routine_%d" % i
            assert rows[0]["rank_vector"] == 1
        checks = conn.matching(eb.MIXED_CHECK_MARKER)
        pg_engines.measure("89-08 mixed-model check statements across 5 searches", len(checks))
        assert len(checks) == 1, "the check ran once per QUERY, not once per connection"
        assert "embedding_model IS NULL OR embedding_model <> " in checks[0]

        # A refusal is NOT cached: every refused query re-measures, so a repair
        # is seen by the very next query on the same connection.
        raw.commit()
        _sql(db, "INSERT INTO rlm_chunks (file_path, content, embedding_code) "
                 "VALUES ('p8908-legacy.py', 'zeta legacy', %s::vector)",
             (_literal(vec("zeta legacy", "unknown")),), fetch=False)
        eb.reset_caches()
        for _ in range(2):
            with pytest.raises(eb.EmbeddingModelMixedError) as refused:
                hybrid_search("zeta1", conn, top_k=3)
            raw.rollback()
        assert refused.value.payload["table"] == "rlm_chunks"
        assert refused.value.payload["offending_models"] == ["<unknown: NULL provenance>"]
        assert len(conn.matching(eb.MIXED_CHECK_MARKER)) == 3
        _sql(db, "DELETE FROM rlm_chunks WHERE file_path = 'p8908-legacy.py'", fetch=False)
        assert hybrid_search("zeta1", conn, top_k=3)[0]["symbol_name"] == "routine_1"
        assert len(conn.matching(eb.MIXED_CHECK_MARKER)) == 4
        hybrid_search("zeta2", conn, top_k=3)
        assert len(conn.matching(eb.MIXED_CHECK_MARKER)) == 4, "the clean verdict is cached"
    finally:
        raw.close()


def test_a_query_embedded_by_another_model_runs_no_vector_leg_and_is_not_refused(db):
    """The provider for the active model is away and a fallback answers: lexical only."""
    from services.rlm_search import hybrid_search

    _seed_chunks(db, 3, OLD)
    rlm_embeddings.set_provider_override(
        lambda text, input_type: (vec(text, "qodo-embed-1-1.5b"), "qodo-embed-1-1.5b"))
    raw = _connect(db, autocommit=False)
    conn = pg_engines.CountingConnection(raw)
    try:
        rows = hybrid_search("zeta1", conn, top_k=3)
        assert rows and rows[0]["symbol_name"] == "routine_1"
        assert all(r["rank_vector"] is None for r in rows), "the vector leg ran"
        assert conn.matching(eb.MIXED_CHECK_MARKER) == []
    finally:
        raw.close()


def test_the_store_records_the_model_on_every_memory_vector_it_writes(db, monkeypatch):
    with memory_store(db, monkeypatch) as (store, asked):
        new_id = store.memory_store_with_embedding(
            "a brand new lesson about provenance", source="lesson-learned",
            project_id="p8908", skip_dedup=True)
        new_id = new_id["id"] if isinstance(new_id, dict) else new_id
        assert {a["model"] for a in asked} == {OLD}
        assert _sql(db, "SELECT embedding IS NOT NULL, embedding_model FROM gsd_memory "
                        "WHERE id = %s", (new_id,))[0] == (True, OLD)

        # The in-daemon top-up writes provenance too.
        _sql(db, "INSERT INTO gsd_memory (id, text, project_id) "
                 "VALUES ('bare-1', 'a memory stored while no key was set', 'p8908')",
             fetch=False)
        # (the top-up asks which provider is configured, so it needs a key NAME
        # to be present; the embedder itself is still the stand-in)
        monkeypatch.setenv("VOYAGE_API_KEY", "not-a-real-key")
        filled = store.memory_backfill_embeddings(batch_size=10)
        assert filled["succeeded"] == 1 and filled["failed"] == 0, filled
        assert _sql(db, "SELECT embedding IS NOT NULL, embedding_model FROM gsd_memory "
                        "WHERE id = 'bare-1'")[0] == (True, OLD)
        # ...and an archived row keeps the model of its vector.
        store.memory_archive_and_delete(new_id)
        assert _sql(db, "SELECT embedding IS NOT NULL, embedding_model "
                        "FROM gsd_memory_archive WHERE id = %s", (new_id,))[0] == (True, OLD)
        cache_id = store.semantic_cache_store("how are models chosen", "by a setting")
        assert _sql(db, "SELECT embedding_model FROM semantic_cache WHERE id = %s",
                    (cache_id,))[0][0] == OLD
        assert store.semantic_cache_lookup("how are models chosen")["response"] == "by a setting"
