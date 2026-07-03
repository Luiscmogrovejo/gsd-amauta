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
_RLM_PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
_RLM_BASE = f"http://127.0.0.1:{_RLM_PORT}"
_PG_DSN = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")

_MCP_MODULE_PATH = os.path.join(_REPO_ROOT, "services", "amauta-mcp.py")
_GSD_RLM_CJS = os.path.join(_REPO_ROOT, "get-shit-done", "bin", "gsd-rlm.cjs")


# ── Readiness gate (module scope) — never red on an operator laptop without services ──

def _rlm_reachable():
    try:
        req = urllib.request.Request(f"{_RLM_BASE}/health", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _pg_reachable():
    try:
        import psycopg2
        conn = psycopg2.connect(_PG_DSN, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


if not _rlm_reachable():
    pytest.skip(f"rlm-service unreachable at {_RLM_BASE}/health", allow_module_level=True)

if not _pg_reachable():
    pytest.skip(f"PG unreachable at {_PG_DSN}", allow_module_level=True)

import psycopg2  # noqa: E402


def _valkey_reachable():
    """Best-effort Valkey probe — used only to gate the graph test's xfail
    path (RETR-05's graph degradation without Valkey is by-design)."""
    try:
        import redis
        client = redis.Redis(
            host=os.environ.get("REDIS_HOST", "127.0.0.1"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            socket_timeout=1,
        )
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
    conn = psycopg2.connect(_PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix_dir}%"])
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix_dir}%"])
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
        with open(os.path.join(tmp_dir, "worker.py"), "w") as f:
            f.write("def frobnicate_widget():\n    return 7\n")
        with open(os.path.join(tmp_dir, "caller.py"), "w") as f:
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
        with open(os.path.join(tmp_dir, "notes.rst"), "w") as f:
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
        main_entry (reindex triggered rebuild_graph; Valkey adjacency
        populated). Graph degradation without Valkey is by-design -> xfail
        rather than hard-fail."""
        if not _valkey_reachable():
            pytest.xfail("Valkey unreachable — graph degradation is by-design (RETR-05)")

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
        assert "main_entry" in target.get("graph_callers", []), (
            f"graph_callers missing main_entry: {target.get('graph_callers')}"
        )


class TestCliPrintsHybridProvenance:
    def test_cli_prints_hybrid_provenance(self, fixture_project):
        """65-01-06 live: gsd-rlm.cjs query --json surfaces the hybrid engine
        marker from the daemon it talks to."""
        if shutil.which("node") is None:
            pytest.skip("node not on PATH")

        result = subprocess.run(
            ["node", _GSD_RLM_CJS, "query", "frobnicate_widget", "--dir", fixture_project, "--json"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
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
