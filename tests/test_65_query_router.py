#!/usr/bin/env python3
"""Tests for the Phase 65 / RETR-01 /query router in services/rlm-service.py.

Verifies:
1. PG-down still returns non-empty results via the explicit legacy in-memory
   scan fallback (the RETR-01 tested no-empty-result criterion).
2. The hybrid branch (PG available, hybrid_search non-empty) returns
   engine="hybrid_rrf_reranked" and normalized+hybrid fields together.
3. An empty hybrid_search result falls through to the legacy scan.
4. Any exception inside the hybrid pipeline never surfaces as a 500 --
   falls through to the legacy scan instead.
5. _normalize_hybrid_chunks unit behavior (reranker_score wins over
   rrf_score, 3-decimal rounding, None start_line/end_line default to 0).
6. /search's hybrid branch is normalized too (sibling-consumer regression).

Run: python3 -m pytest tests/test_65_query_router.py -v
"""
import importlib.util
import json
import os
import threading
import urllib.error
import urllib.request
from unittest.mock import MagicMock

import pytest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

_RLM_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py"
)


def _load_rlm_module():
    """Load rlm-service.py via importlib (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location("rlm_service_65_router", _RLM_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def rlm_mod():
    return _load_rlm_module()


@pytest.fixture(scope="module")
def server(rlm_mod):
    """Serve RLMHandler on an ephemeral port in a daemon thread."""
    srv = rlm_mod.ThreadedHTTPServer(("127.0.0.1", 0), rlm_mod.RLMHandler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}"
    srv.shutdown()
    srv.server_close()


def post(base_url, path, body):
    """POST helper via urllib -- returns (status, parsed_json)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class TestQueryRouterLegacyFallback:
    """Test 1 -- THE RETR-01 tested criterion."""

    def test_pg_down_falls_back_to_legacy_scan_with_results(
        self, rlm_mod, server, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(rlm_mod, "_get_pg_conn", lambda: None)

        target = tmp_path / "zz.py"
        target.write_text("def zz_target_fn():\n    return 7\n")

        status, data = post(
            server, "/query", {"query": "zz_target_fn", "directory": str(tmp_path)}
        )

        assert status == 200
        assert data["ok"] is True
        assert len(data["results"]) > 0
        assert data["engine"] == "legacy_in_memory_fallback"
        assert "index_size" not in data


class TestQueryRouterHybridBranch:
    def test_hybrid_branch_engine_and_normalization(
        self, rlm_mod, server, monkeypatch, tmp_path
    ):
        fake_pg = MagicMock()
        monkeypatch.setattr(rlm_mod, "_get_pg_conn", lambda: fake_pg)

        import services.rlm_graph as rlm_graph
        import services.rlm_ingestion as rlm_ingestion
        import services.rlm_reranker as rlm_reranker
        import services.rlm_search as rlm_search

        monkeypatch.setattr(
            rlm_ingestion,
            "ingest_directory",
            lambda directory, pg_conn: {
                "total_files": 3, "inserted": 0, "skipped": 3, "errors": 0,
            },
        )

        fake_row = {
            "id": 1,
            "file_path": "/some/file.py",
            "symbol_name": "foo_fn",
            "symbol_type": "function",
            "start_line": 1,
            "end_line": 5,
            "content": "def foo_fn(): pass",
            "description": "",
            "dependencies": [],
            "dependents": [],
            "rrf_score": 0.42,
            "rank_bm25": 1,
            "rank_vector": 2,
        }
        monkeypatch.setattr(
            rlm_search,
            "hybrid_search",
            lambda query, pg_conn, top_k, file_filter: [dict(fake_row)],
        )
        monkeypatch.setattr(
            rlm_reranker, "rerank", lambda query, chunks, top_k: chunks[:top_k]
        )

        def fake_expand(chunks, cache):
            for c in chunks:
                c["graph_callers"] = ["caller_a"]
                c["graph_callees"] = []
            return chunks

        monkeypatch.setattr(rlm_graph, "expand_chunks_with_graph", fake_expand)

        status, data = post(
            server, "/query", {"query": "foo_fn", "directory": str(tmp_path)}
        )

        assert status == 200
        assert data["engine"] == "hybrid_rrf_reranked"
        r0 = data["results"][0]
        # Hybrid fields preserved
        assert r0["file_path"] == "/some/file.py"
        assert r0["rrf_score"] == 0.42
        assert r0["graph_callers"] == ["caller_a"]
        # Compat fields added
        assert r0["filepath"] == "/some/file.py"
        assert r0["label"] == "foo_fn"
        assert r0["text"] == "def foo_fn(): pass"
        assert r0["char_count"] == len("def foo_fn(): pass")
        assert r0["relevance_score"] > 0

    def test_hybrid_empty_falls_through_to_legacy(
        self, rlm_mod, server, monkeypatch, tmp_path
    ):
        fake_pg = MagicMock()
        monkeypatch.setattr(rlm_mod, "_get_pg_conn", lambda: fake_pg)

        import services.rlm_ingestion as rlm_ingestion
        import services.rlm_search as rlm_search

        monkeypatch.setattr(
            rlm_ingestion,
            "ingest_directory",
            lambda directory, pg_conn: {
                "total_files": 1, "inserted": 0, "skipped": 1, "errors": 0,
            },
        )
        monkeypatch.setattr(
            rlm_search, "hybrid_search", lambda query, pg_conn, top_k, file_filter: []
        )

        target = tmp_path / "yy.py"
        target.write_text("def yy_target_fn():\n    return 1\n")

        status, data = post(
            server, "/query", {"query": "yy_target_fn", "directory": str(tmp_path)}
        )

        assert status == 200
        assert data["ok"] is True
        assert len(data["results"]) > 0
        assert data["engine"] == "legacy_in_memory_fallback"

    def test_hybrid_exception_never_500s(
        self, rlm_mod, server, monkeypatch, tmp_path
    ):
        fake_pg = MagicMock()
        monkeypatch.setattr(rlm_mod, "_get_pg_conn", lambda: fake_pg)

        import services.rlm_ingestion as rlm_ingestion
        import services.rlm_search as rlm_search

        monkeypatch.setattr(
            rlm_ingestion,
            "ingest_directory",
            lambda directory, pg_conn: {
                "total_files": 1, "inserted": 0, "skipped": 1, "errors": 0,
            },
        )

        def boom(*args, **kwargs):
            raise RuntimeError("hybrid pipeline exploded")

        monkeypatch.setattr(rlm_search, "hybrid_search", boom)

        target = tmp_path / "xx.py"
        target.write_text("def xx_target_fn():\n    return 2\n")

        status, data = post(
            server, "/query", {"query": "xx_target_fn", "directory": str(tmp_path)}
        )

        assert status == 200
        assert data["ok"] is True
        assert data["engine"] == "legacy_in_memory_fallback"
        assert len(data["results"]) > 0


class TestNormalizeHybridChunksUnit:
    def test_normalize_hybrid_chunks_unit(self, rlm_mod):
        rows = [
            {
                "file_path": "/a.py",
                "symbol_name": "foo",
                "content": "x",
                "reranker_score": 0.9123,
                "rrf_score": 0.1,
            },
            {
                "file_path": "/b.py",
                "symbol_name": "bar",
                "content": "y",
                "rrf_score": 0.55555,
                "start_line": None,
                "end_line": None,
            },
        ]
        result = rlm_mod._normalize_hybrid_chunks(rows)

        # reranker_score wins over rrf_score when both are present
        assert result[0]["relevance_score"] == round(0.9123, 3)
        # rrf_score used when reranker_score is absent
        assert result[1]["relevance_score"] == round(0.55555, 3)
        # None start_line/end_line default to 0
        assert result[1]["start_line"] == 0
        assert result[1]["end_line"] == 0


class TestSearchEndpointNormalization:
    """Test 6 -- sibling-consumer regression (RETR-01's /search fix)."""

    def test_search_endpoint_normalizes_hybrid_results(
        self, rlm_mod, server, monkeypatch, tmp_path
    ):
        fake_pg = MagicMock()
        monkeypatch.setattr(rlm_mod, "_get_pg_conn", lambda: fake_pg)

        import services.rlm_graph as rlm_graph
        import services.rlm_reranker as rlm_reranker
        import services.rlm_search as rlm_search

        fake_row = {
            "id": 2,
            "file_path": "/some/other.py",
            "symbol_name": "bar_fn",
            "symbol_type": "function",
            "start_line": 1,
            "end_line": 4,
            "content": "def bar_fn(): pass",
            "description": "",
            "dependencies": [],
            "dependents": [],
            "rrf_score": 0.3,
            "rank_bm25": 2,
            "rank_vector": 1,
        }
        monkeypatch.setattr(
            rlm_search,
            "hybrid_search",
            lambda query, pg_conn, top_k, file_filter: [dict(fake_row)],
        )
        monkeypatch.setattr(
            rlm_reranker, "rerank", lambda query, chunks, top_k: chunks[:top_k]
        )
        monkeypatch.setattr(
            rlm_graph, "expand_chunks_with_graph", lambda chunks, cache: chunks
        )

        target = tmp_path / "target.py"
        target.write_text("def bar_fn(): pass\n")

        status, data = post(server, "/search", {"query": "bar_fn", "paths": [str(target)]})

        assert status == 200
        assert data["engine"] == "hybrid_rrf_reranked"
        r0 = data["results"][0]
        assert "filepath" in r0
        assert "label" in r0
        assert "text" in r0
        assert r0["filepath"] == "/some/other.py"
        assert r0["label"] == "bar_fn"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
