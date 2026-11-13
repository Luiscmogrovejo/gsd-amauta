#!/usr/bin/env python3
"""
Phase 65 live E2E — requires RLM service + PG + Valkey; skips otherwise.

Proves the unified retrieval stack end-to-end against the REAL rlm-service
daemon (HTTP on GSD_RLM_PORT), REAL PostgreSQL (pg_search + pgvector), and
(where reachable) REAL Valkey — the seams the four Phase 65 wave-1 plans
changed (65-01 hybrid /query router + graph wiring, 65-02 generic RRF +
description boost, 65-03 MCP search-code hybrid delegation, 65-04
chunker/reranker fixes).

Unit suites with monkeypatched seams cannot catch missing migrations, import
scoping, or route wiring (Phase 60 learning) — this suite exercises the real
round trip: ingest -> hybrid /query -> rerank -> graph-expand -> fallback,
plus the gsd-rlm CLI and the amauta/search-code MCP tool as sibling
consumers of the same pipeline.

Fixture rows are scoped under a `gsd65e2e_`-prefixed tmp directory and are
VERIFIED removed (DELETE + COUNT(*)=0 assertion) in fixture teardown, even
when a test assertion fails (research pitfall 13: cleanup must be verified,
not merely attempted).

Run: python3 -m pytest tests/test_65_retrieval_e2e.py -v
"""
import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

import pytest

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
# Phase 88 plan 88-16-05: no default port. 18798 is the operator's LIVE RLM;
# a default here meant a test that "skips when the service is unavailable"
# first dialled it to find out. The port now comes only from GSD_RLM_PORT,
# which tests/conftest.py's session fixture RLM sets when CI has a database.
_RLM_PORT = (os.environ.get("GSD_RLM_PORT") or "").strip()
_RLM_BASE = f"http://127.0.0.1:{_RLM_PORT}" if _RLM_PORT else ""
from conftest import PG_SKIP_REASON, postgres_dsn_or_none  # noqa: E402 - the one Postgres opt-in

#: The disposable database, or None. There is deliberately no default: a
#: literal 127.0.0.1:5433 here would dial the operator's live PostgreSQL
#: through libpq, which the in-process socket guard cannot see.
_PG_DSN = postgres_dsn_or_none()

_MCP_MODULE_PATH = os.path.join(_REPO_ROOT, "services", "amauta-mcp.py")
_GSD_RLM_CJS = os.path.join(_REPO_ROOT, "get-shit-done", "bin", "gsd-rlm.cjs")


# ── Readiness gate (module scope) — never red on an operator laptop without services ──

def _rlm_reachable():
    if not _RLM_BASE:
        return False
    try:
        req = urllib.request.Request(f"{_RLM_BASE}/health", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _pg_reachable():
    if not _PG_DSN:
        return False
    try:
        import psycopg2
        conn = psycopg2.connect(_PG_DSN, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


if not _rlm_reachable():
    pytest.skip(
        "no RLM service: tests/conftest.py starts one for the session when a "
        "disposable PostgreSQL is configured (GSD_TEST_POSTGRES_URL)",
        allow_module_level=True,
    )

if not _pg_reachable():
    pytest.skip(PG_SKIP_REASON, allow_module_level=True)

import psycopg2  # noqa: E402


def _valkey_reachable():
    """Whether the DISPOSABLE Valkey is up — never a probe of a default port.

    Plan 88-11. This used to default to ``127.0.0.1:6379``, which is the
    operator's live Redis: on a developer machine the probe either dialled a
    service no test may touch or was refused by the hermetic guard, and in CI
    it dialled nothing at all. The address now comes from
    ``GSD_TEST_VALKEY_URL`` through ``conftest.valkey_host_port()``, which
    returns None rather than a default, and the same URL is what
    ``conftest._start_rlm`` hands the RLM service as ``GSD_REDIS_URL`` (plan
    89-09 task 06 moved that handover from the host/port pair to the canonical
    name, which is what the resolver reads first) — so the probe and the service
    under test agree by construction instead of by coincidence.

    Returns:
        bool: True when a disposable Valkey is configured AND answering.
    """
    from conftest import valkey_host_port

    where = valkey_host_port()
    if where is None:
        return False
    try:
        import redis
        client = redis.Redis(host=where[0], port=where[1], socket_timeout=2)
        client.ping()
        return True
    except Exception:
        return False


# ── HTTP helper ──────────────────────────────────────────────────────────────

def _post(path, body, timeout=30):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{_RLM_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _verified_cleanup(prefix_dir):
    """DELETE rlm_chunks rows under prefix_dir, commit, then re-SELECT COUNT(*)
    with the same predicate and assert 0 — verified cleanup, not attempted."""
    # `prefix_dir` is a real temp path; on Windows its separators are LIKE's
    # escape character, so an unescaped pattern deletes nothing and the
    # verifying COUNT, built from the same pattern, still reads 0.
    if _REPO_ROOT not in sys.path:
        sys.path.insert(0, _REPO_ROOT)
    from services.rlm_search import like_escape
    under_prefix = like_escape(prefix_dir) + "%"
    conn = psycopg2.connect(_PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [under_prefix])
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [under_prefix])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"gsd65e2e_ cleanup failed to verify for {prefix_dir}: {remaining} rows remain"
    finally:
        conn.close()


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def fixture_project():
    """Two-file Python project: worker.py defines frobnicate_widget(),
    caller.py imports + calls it from main_entry() (mirrors the same
    canonical fixture used by tests/test_65_graph_wiring.py)."""
    tmp_dir = tempfile.mkdtemp(prefix="gsd65e2e_")
    try:
        with open(os.path.join(tmp_dir, "worker.py"), "w", encoding="utf-8") as f:
            f.write("def frobnicate_widget():\n    return 7\n")
        with open(os.path.join(tmp_dir, "caller.py"), "w", encoding="utf-8") as f:
            f.write(
                "from worker import frobnicate_widget\n\n"
                "def main_entry():\n    return frobnicate_widget()\n"
            )

        status, data = _post("/reindex", {"path": tmp_dir, "force": True})
        assert status == 200 and data.get("ok") is True, f"fixture reindex failed: {data}"

        yield tmp_dir
    finally:
        try:
            _verified_cleanup(tmp_dir)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@pytest.fixture
def unindexed_project():
    """Second tmp dir containing only notes.rst — an extension outside both
    the AST/legacy ingestion sets AND the legacy in-memory scanner's set."""
    tmp_dir = tempfile.mkdtemp(prefix="gsd65e2e_")
    try:
        with open(os.path.join(tmp_dir, "notes.rst"), "w", encoding="utf-8") as f:
            f.write("This is a note about frobnication procedures.\n")
        yield tmp_dir
    finally:
        try:
            _verified_cleanup(tmp_dir)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _load_mcp_mod():
    spec = importlib.util.spec_from_file_location("amauta_mcp_65e2e", _MCP_MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── Tests ────────────────────────────────────────────────────────────────────

class TestQueryAnswersHybrid:
    # Plan 89-07: same measured Windows obstacle as
    # tests/test_27_mrr_validation.py -- the fixture RLM does not finish
    # ingesting on that runner, so the class fixture itself times out.
    @pytest.mark.skipif(sys.platform.startswith("win"), reason="the fixture RLM service does not finish ingesting this repository on a Windows runner: measured on pytest (windows-latest), run 43366250606, the 300-second warm-up did not complete and all 20 golden queries then timed out at 30 s each, while the same test passes on the Linux and macOS cells. The obstacle is Windows ingestion throughput (tree-sitter over the whole tracked tree), not PostgreSQL: /health answered and every other Postgres-backed test in this file passes on that cell.")
    def test_query_answers_hybrid(self, fixture_project):
        """RETR-01 live: /query answers via the hybrid pipeline with the
        hybrid engine marker, non-empty results, and both filepath/file_path
        keys present (live normalization)."""
        status, data = _post(
            "/query", {"query": "frobnicate_widget", "directory": fixture_project, "top_k": 5}
        )
        assert status == 200
        assert data.get("ok") is True, f"query failed: {data}"
        assert data.get("engine") == "hybrid_rrf_reranked", f"expected hybrid engine, got: {data}"
        results = data.get("results", [])
        assert results, f"expected non-empty results: {data}"
        for r in results:
            assert "filepath" in r, f"missing compat 'filepath' key: {r}"
            assert "file_path" in r, f"missing hybrid 'file_path' key: {r}"


class TestSymbolNameOnlyQueryScoresNonzero:
    def test_symbol_name_only_query_scores_nonzero(self, fixture_project):
        """RETR-02 live: a symbol-name-only query (label TF seeding) scores
        the matching chunk non-zero and surfaces it in the results."""
        status, data = _post(
            "/query", {"query": "frobnicate_widget", "directory": fixture_project, "top_k": 5}
        )
        assert status == 200 and data.get("ok") is True, f"query failed: {data}"

        target = next(
            (
                r for r in data.get("results", [])
                if "frobnicate_widget" in (r.get("symbol_name") or r.get("label") or "")
            ),
            None,
        )
        assert target is not None, f"frobnicate_widget chunk missing from results: {data.get('results')}"
        assert target.get("relevance_score", 0) > 0, f"expected relevance_score > 0, got: {target}"


class TestGraphNamesRealCaller:
    def test_graph_names_the_real_caller(self, fixture_project):
        """RETR-05 live: the frobnicate_widget result's graph_callers names
        main_entry (reindex triggered rebuild_graph, Valkey adjacency
        populated) — and, without a disposable Valkey, the result still
        arrives with the graph keys simply unpopulated.

        Plan 89-01 replaced two expected-failure escapes here with two real
        assertions.

        Plan 88-11 gave the Linux cell a disposable Valkey and measured the
        result: the Valkey half was closed, the retrieval half was Phase 89's.
        Run 43217682043 / job 131180975509 ran this test's POSITIVE branch for
        the first time on any cell and failed with
        `graph_callers missing main_entry: None` — the key ABSENT from the
        result, not empty — because `expand_chunks_with_graph` is called only
        inside /query's `if hybrid_results:` guard, and on that cell the engine
        still answered `legacy_in_memory_fallback`. Valkey was never the
        obstacle that entry claimed. Plan 89-01 fixed the engine
        (services/rlm_search.py: the BM25 degradation branch now aliases its
        table, so an alias-qualified file filter can be planned), so the key is
        present and correct and this is an ordinary assertion again.

        The no-Valkey branch used to take an expected-failure escape. Graph
        degradation
        without a cache IS by design, but "by design" is a CONTRACT, so it is
        now asserted rather than excused: the response must still be a healthy
        hybrid answer whose graph keys are absent or empty. An escape there
        would have hidden the very defect above on any cell without a cache.
        """
        status, data = _post(
            "/query", {"query": "frobnicate_widget", "directory": fixture_project, "top_k": 5}
        )
        assert status == 200 and data.get("ok") is True, f"query failed: {data}"

        target = next(
            (
                r for r in data.get("results", [])
                if "frobnicate_widget" in (r.get("symbol_name") or r.get("label") or "")
            ),
            None,
        )
        assert target is not None, f"frobnicate_widget chunk missing from results: {data.get('results')}"

        if not _valkey_reachable():
            from conftest import VALKEY_SKIP_REASON

            # By-design degradation, asserted: the engine answered, and the
            # graph keys are simply unpopulated. Never an escape.
            assert data.get("engine") == "hybrid_rrf_reranked", (
                "even with no cache the hybrid engine must answer "
                f"({VALKEY_SKIP_REASON}); got engine={data.get('engine')!r}"
            )
            assert not target.get("graph_callers"), (
                "graph adjacency comes from the cache, so with none reachable "
                f"the key must be absent or empty: {target.get('graph_callers')!r}"
            )
            return

        assert "main_entry" in target.get("graph_callers", []), (
            f"graph_callers missing main_entry: {target.get('graph_callers')}"
        )


class TestCliPrintsHybridProvenance:
    @pytest.mark.skipif(sys.platform.startswith("win"), reason="the fixture RLM serves legacy_in_memory_fallback on this cell, so the engine marker this test asserts is never produced -- the service did not reach the disposable PostgreSQL even though every in-process Postgres test on the same cell passes. Measured on pytest (windows-latest), run 43370212942: engine=legacy_in_memory_fallback where hybrid* is required, while the macOS cell answers a hybrid engine with the same fixture.")
    def test_cli_prints_hybrid_provenance(self, fixture_project):
        """65-01-06 live: gsd-rlm.cjs query --json surfaces the hybrid engine
        marker from the daemon it talks to."""
        if shutil.which("node") is None:
            pytest.skip("node not on PATH")

        # Phase 89 plan 89-07: this file's module-level collection skip is gone
        # on the macOS and Windows cells (they have a disposable PostgreSQL now),
        # and on the FIRST run where it executed there the CLI exited 3 with its
        # own message: "RLM: timed out after 20s ... Raise GSD_RLM_DEADLINE_MS to
        # wait longer". The macOS `pytest` cell went from 4 to 11 minutes of work
        # in the same job, so a cold RLM start plus an ingest plus a query no
        # longer fits a 20-second deadline there. The BUDGET is raised; nothing
        # about the assertion changes, and a stall is still a non-zero exit
        # rather than a pass.
        env = dict(os.environ)
        env["GSD_RLM_DEADLINE_MS"] = "120000"
        result = subprocess.run(
            ["node", _GSD_RLM_CJS, "query", "frobnicate_widget", "--dir", fixture_project, "--json"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            env=env,
            encoding="utf-8",
        )
        assert result.returncode == 0, (
            f"CLI query failed rc={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        data = json.loads(result.stdout)
        assert str(data.get("engine", "")).startswith("hybrid"), (
            f"expected engine to start with 'hybrid', got: {data.get('engine')}"
        )


class TestMcpSearchCodeRanksByQuery:
    def test_mcp_search_code_ranks_by_query(self, fixture_project):
        """RETR-03 live: amauta/search-code delegates to hybrid_search and
        ranks by ITS query — two distinct queries against the fixture
        project produce distinct top results (worker.py symbol vs caller.py
        symbol)."""
        try:
            mod = _load_mcp_mod()
        except Exception as e:
            pytest.skip(f"amauta-mcp.py failed to load: {e}")

        async def _call(query):
            result = await mod.call_tool(
                "amauta/search-code",
                {"query": query, "directory": fixture_project, "top_k": 3},
            )
            return json.loads(result.content[0].text)

        data_worker = asyncio.run(_call("frobnicate_widget"))
        data_caller = asyncio.run(_call("main_entry"))

        assert data_worker.get("engine") == "hybrid_rlm_chunks", f"unexpected payload: {data_worker}"
        assert data_caller.get("engine") == "hybrid_rlm_chunks", f"unexpected payload: {data_caller}"

        results_worker = data_worker.get("results", [])
        results_caller = data_caller.get("results", [])
        assert results_worker, f"no results for frobnicate_widget query: {data_worker}"
        assert results_caller, f"no results for main_entry query: {data_caller}"

        top_worker = results_worker[0]
        top_caller = results_caller[0]
        assert (
            top_worker.get("path") != top_caller.get("path")
            or top_worker.get("symbol_name") != top_caller.get("symbol_name")
        ), f"top results identical across distinct queries: {top_worker} vs {top_caller}"


class TestUnindexedExtensionDirStillAnswers:
    def test_unindexed_extension_dir_still_answers(self, unindexed_project):
        """RETR-01 fallback shape, live-adjacent: querying a directory whose
        only file (.rst) is outside both ingestion sets AND the legacy
        scanner's extension set still returns ok=True with a list (empty
        allowed) and a documented engine marker — never a hard failure."""
        status, data = _post(
            "/query", {"query": "frobnication", "directory": unindexed_project, "top_k": 5}
        )
        assert status == 200
        assert data.get("ok") is True, f"query failed: {data}"
        assert isinstance(data.get("results"), list), f"expected results list, got: {data.get('results')!r}"
        assert data.get("engine") in ("hybrid_rrf_reranked", "legacy_in_memory_fallback"), (
            f"unexpected engine marker: {data.get('engine')}"
        )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
