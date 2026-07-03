#!/usr/bin/env python3
"""
Phase 69 live E2E — 5-language AST chunk parity through the unified /query;
requires rlm-service (restarted post-Wave-1) + PG; skips when services are
down.

Proves the five Wave-1 grammars (ASTG-01/02: Kotlin, Swift, Go, Rust, Java)
landed ON the unified Phase 65 retrieval stack, not a third path: for each
language, a fixture file with a named symbol is ingested via /reindex and a
symbol query retrieves its defining chunk end-to-end through /query with
hybrid provenance (65-05 fixture + verified COUNT=0 cleanup precedent).

A stale rlm-service daemon (still running pre-Wave-1 code cached in
sys.modules) is detected by a dedicated preflight test and reported as an
orchestrator-owned restart requirement — never silently skipped and never
misreported as a grammar bug.

Fixture rows are scoped under a `gsd69e2e_`-prefixed tmp directory and are
VERIFIED removed (DELETE + COUNT(*)=0 assertion) in fixture teardown, even
when a test assertion fails (research pitfall 13: cleanup must be verified,
not merely attempted).

Run: python3 -m pytest tests/test_69_ast_parity_e2e.py -v
"""
import json
import os
import shutil
import tempfile
import urllib.error
import urllib.request

import pytest

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")

_RLM_PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
_RLM_BASE = f"http://127.0.0.1:{_RLM_PORT}"
_PG_DSN = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")


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

# Hard-import (never skip): if tree_sitter_kotlin is missing in THIS
# interpreter, Wave-1's grammar install regressed — that is a real failure,
# not an environment-unreachable condition.
import tree_sitter_kotlin  # noqa: E402,F401


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
    with the same predicate and assert 0 — verified cleanup, not attempted
    (65-05/pitfall-13 precedent)."""
    conn = psycopg2.connect(_PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix_dir}%"])
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix_dir}%"])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"gsd69e2e_ cleanup failed to verify for {prefix_dir}: {remaining} rows remain"
    finally:
        conn.close()


# ── Fixtures ─────────────────────────────────────────────────────────────────

# language -> (relative_path, symbol) contract, per the plan.
_LANGUAGE_FIXTURES = {
    "kotlin": ("wear/FrobWear.kt", "frobnicateKotlinWear"),
    "swift": ("Frob.swift", "frobnicateSwiftGadget"),
    "go": ("frob.go", "FrobnicateGoGadget"),
    "rust": ("frob.rs", "frobnicate_rust_gadget"),
    "java": ("Frob.java", "frobnicateJavaGadget"),
}

_FIXTURE_SOURCES = {
    "wear/FrobWear.kt": (
        "package com.gsd.wear\n\n"
        "fun frobnicateKotlinWear(): Int {\n"
        "    return 69\n"
        "}\n"
    ),
    "Frob.swift": (
        "func frobnicateSwiftGadget() -> Int {\n"
        "    return 69\n"
        "}\n"
    ),
    "frob.go": (
        "package frob\n\n"
        "func FrobnicateGoGadget() int {\n"
        "    return 69\n"
        "}\n"
    ),
    "frob.rs": (
        "pub fn frobnicate_rust_gadget() -> i32 {\n"
        "    69\n"
        "}\n"
    ),
    "Frob.java": (
        "public class FrobJavaGadget {\n"
        "    public static int frobnicateJavaGadget() {\n"
        "        return 69;\n"
        "    }\n"
        "}\n"
    ),
}


@pytest.fixture(scope="module")
def fixture_project():
    """Five-language fixture project: one Kotlin (under wear/), Swift, Go,
    Rust, and Java file, each defining a globally-unique named symbol
    (ASTG-03 parity contract)."""
    tmp_dir = tempfile.mkdtemp(prefix="gsd69e2e_")
    try:
        os.makedirs(os.path.join(tmp_dir, "wear"), exist_ok=True)
        for rel_path, source in _FIXTURE_SOURCES.items():
            full_path = os.path.join(tmp_dir, rel_path)
            with open(full_path, "w") as f:
                f.write(source)

        # Longer timeout than the query calls: /reindex triggers a full
        # rebuild_graph() over the whole shared codebase index (10k+ nodes)
        # and this daemon may be concurrently serving other live traffic.
        status, data = _post("/reindex", {"path": tmp_dir, "force": True}, timeout=90)
        assert status == 200 and data.get("ok") is True, f"fixture reindex failed: {data}"

        yield tmp_dir
    finally:
        try:
            _verified_cleanup(tmp_dir)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _pg_ast_chunk_count(fixture_dir, like_suffix):
    """Count rlm_chunks rows under fixture_dir matching like_suffix whose
    symbol_type is a real AST symbol_type (never 'legacy' -- the
    rlm_ingestion.py default for the non-AST fallback path)."""
    conn = psycopg2.connect(_PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM rlm_chunks "
                "WHERE file_path LIKE %s AND symbol_type != 'legacy'",
                [f"{fixture_dir}%{like_suffix}"],
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


# ── Tests ────────────────────────────────────────────────────────────────────

class TestStaleDaemonPreflight:
    def test_kotlin_fixture_ingested_as_ast_chunk_not_legacy(self, fixture_project):
        """Preflight: an AST chunk (symbol_type != 'legacy') must exist for
        the .kt fixture after /reindex. If it does not, the running
        rlm-service predates Wave 1 (cached services.ast_chunker /
        services.rlm_ingestion modules in sys.modules) — this is an
        orchestrator-owned restart requirement, NOT a grammar bug. The
        remaining parity tests in this module depend on this evidence."""
        ast_chunk_count = _pg_ast_chunk_count(fixture_project, "FrobWear.kt")
        assert ast_chunk_count > 0, (
            "No AST chunk (symbol_type != 'legacy') found for the Kotlin "
            "fixture after /reindex. The running rlm-service daemon is "
            "STALE — it predates the Wave-1 grammar install and is still "
            "serving cached services.ast_chunker / services.rlm_ingestion "
            "modules from before Phase 69. This is an orchestrator-owned "
            "RESTART requirement (see 69-02-PLAN.md RESTART POINT), not a "
            "grammar failure. Restart rlm-service and re-run this suite."
        )


def _assert_parity(fixture_project, language):
    rel_path, symbol = _LANGUAGE_FIXTURES[language]
    status, data = _post(
        "/query", {"query": symbol, "directory": fixture_project, "top_k": 10}
    )
    assert status == 200
    assert data.get("ok") is True, f"query failed for {language}: {data}"

    engine = data.get("engine", "")
    assert str(engine).startswith("hybrid"), (
        f"expected hybrid engine marker for {language}, got: {engine}"
    )

    results = data.get("results", [])
    assert results, f"expected non-empty results for {language} query {symbol!r}: {data}"

    match = next(
        (
            r for r in results
            if symbol in (r.get("symbol_name") or r.get("label") or "")
            and str(r.get("filepath") or r.get("file_path") or "").endswith(rel_path)
        ),
        None,
    )
    assert match is not None, (
        f"defining chunk for {language} symbol {symbol!r} (file {rel_path}) "
        f"not found in results: {results}"
    )

    if language == "kotlin":
        filepath = str(match.get("filepath") or match.get("file_path") or "")
        assert "/wear/" in filepath, (
            f"expected Kotlin fixture retrieved from a wear/ subdirectory, got: {filepath}"
        )


class TestKotlinSymbolQueryParity:
    def test_kotlin_symbol_query_retrieves_defining_chunk(self, fixture_project):
        _assert_parity(fixture_project, "kotlin")


class TestSwiftSymbolQueryParity:
    def test_swift_symbol_query_retrieves_defining_chunk(self, fixture_project):
        _assert_parity(fixture_project, "swift")


class TestGoSymbolQueryParity:
    def test_go_symbol_query_retrieves_defining_chunk(self, fixture_project):
        _assert_parity(fixture_project, "go")


class TestRustSymbolQueryParity:
    def test_rust_symbol_query_retrieves_defining_chunk(self, fixture_project):
        _assert_parity(fixture_project, "rust")


class TestJavaSymbolQueryParity:
    def test_java_symbol_query_retrieves_defining_chunk(self, fixture_project):
        _assert_parity(fixture_project, "java")


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
