#!/usr/bin/env python3
"""
Dependency graph for GSD-Amauta RLM — Phase 27 / RLM-06.

Builds a NetworkX DiGraph from rlm_chunks.dependencies entries.
Nodes: symbol_name values (functions, classes, methods).
Edges: symbol_name -> dependency (calls, imports, inherits).
Stores adjacency lists in Valkey as JSON at key rlm:graph:{symbol_name}.
PageRank identifies architectural hub files (top-20).

Build trigger: called from rlm_ingestion.ingest_file() after upsert.
Storage: Valkey only (ephemeral — acceptable; rebuilt on service restart or explicit reindex).
Key prefix: rlm:graph: (distinct from rlm:rerank: prefix used by reranker).
"""

import json
import logging
import os
from typing import Optional

log = logging.getLogger("amauta.rlm_graph")

GRAPH_KEY_PREFIX = "rlm:graph:"
GRAPH_HUBFILES_KEY = "rlm:graph:__hub_files__"
GRAPH_TTL = 3600  # 1 hour — rebuilt incrementally

try:
    import networkx as nx
    HAS_NETWORKX = True
except ImportError:
    HAS_NETWORKX = False
    log.warning("networkx_not_installed — dependency graph disabled")


def build_graph_from_pg(pg_conn) -> Optional[object]:
    """
    Build a NetworkX DiGraph from all rlm_chunks rows in PostgreSQL.

    Nodes: all symbol_names.
    Edges: symbol_name -> each dependency in dependencies[].

    Returns the DiGraph, or None if networkx unavailable.
    """
    if not HAS_NETWORKX:
        return None

    try:
        with pg_conn.cursor() as cur:
            cur.execute("""
                SELECT symbol_name, dependencies, file_path
                FROM rlm_chunks
                WHERE symbol_name IS NOT NULL AND symbol_name != ''
            """)
            rows = cur.fetchall()
    except Exception as e:
        log.warning("build_graph_query_failed error=%s", str(e))
        return None

    G = nx.DiGraph()
    for symbol_name, deps, file_path in rows:
        G.add_node(symbol_name, file_path=file_path or "")
        if deps:
            for dep in deps:
                if dep and dep.strip():
                    G.add_edge(symbol_name, dep.strip())

    log.info("graph_built nodes=%d edges=%d", G.number_of_nodes(), G.number_of_edges())
    return G


def store_graph_in_valkey(G, cache_client) -> int:
    """
    Store adjacency lists from NetworkX DiGraph into Valkey.

    For each node, stores key rlm:graph:{symbol_name} as JSON:
      {callers: [<predecessors>], callees: [<successors>], file_path: "..."}

    Also computes PageRank and stores top-20 hub files at rlm:graph:__hub_files__.

    Returns count of nodes stored.
    """
    if G is None or cache_client is None:
        return 0

    stored = 0
    for node in G.nodes():
        callers = list(G.predecessors(node))
        callees = list(G.successors(node))
        file_path = G.nodes[node].get("file_path", "")
        adjacency = {
            "callers": callers[:50],   # Cap to avoid oversized values
            "callees": callees[:50],
            "file_path": file_path,
        }
        key = f"{GRAPH_KEY_PREFIX}{node}"
        try:
            cache_client.set(key, json.dumps(adjacency), ex=GRAPH_TTL)
            stored += 1
        except Exception as e:
            log.debug("graph_store_failed node=%s error=%s", node, str(e))

    # Compute PageRank and store top-20 hub files
    try:
        pagerank = nx.pagerank(G, alpha=0.85, max_iter=100)
        # Aggregate PageRank by file_path
        file_pr: dict = {}
        for node, pr in pagerank.items():
            fp = G.nodes[node].get("file_path", "unknown")
            file_pr[fp] = file_pr.get(fp, 0.0) + pr
        top_files = sorted(file_pr.items(), key=lambda x: -x[1])[:20]
        hub_files = [{"file_path": fp, "pagerank": round(pr, 6)} for fp, pr in top_files]
        cache_client.set(GRAPH_HUBFILES_KEY, json.dumps(hub_files), ex=GRAPH_TTL)
        log.info("pagerank_hub_files top=%s", hub_files[0]["file_path"] if hub_files else "none")
    except Exception as e:
        log.warning("pagerank_failed error=%s", str(e))

    log.info("graph_stored_to_valkey nodes=%d", stored)
    return stored


def get_neighbors(symbol_name: str, cache_client) -> dict:
    """
    Retrieve 1-hop neighbors of a symbol from Valkey.

    Returns dict: {callers: [...], callees: [...], file_path: "..."}.
    Returns empty dict if symbol not in graph or Valkey unavailable.
    """
    if cache_client is None:
        return {}
    key = f"{GRAPH_KEY_PREFIX}{symbol_name}"
    try:
        val = cache_client.get(key)
        if val is None:
            return {}
        return json.loads(val)
    except Exception as e:
        log.debug("get_neighbors_failed symbol=%s error=%s", symbol_name, str(e))
        return {}


def expand_chunks_with_graph(chunks: list, cache_client) -> list:
    """
    Expand retrieved chunks with 1-hop dependency graph neighbors.

    For each retrieved chunk, checks if callers or callees are in the graph.
    Adds metadata fields: 'graph_callers', 'graph_callees' to each chunk.

    Returns augmented chunks list (same order, additional fields added).
    """
    if cache_client is None:
        for chunk in chunks:
            chunk["graph_callers"] = []
            chunk["graph_callees"] = []
        return chunks

    for chunk in chunks:
        symbol_name = chunk.get("symbol_name", "")
        neighbors = get_neighbors(symbol_name, cache_client) if symbol_name else {}
        chunk["graph_callers"] = neighbors.get("callers", [])[:10]
        chunk["graph_callees"] = neighbors.get("callees", [])[:10]

    return chunks


def get_hub_files(cache_client) -> list:
    """Return top-20 hub files by PageRank. Returns [] if unavailable."""
    if cache_client is None:
        return []
    try:
        val = cache_client.get(GRAPH_HUBFILES_KEY)
        if val is None:
            return []
        return json.loads(val)
    except Exception:
        return []


def rebuild_graph(pg_conn, cache_client) -> dict:
    """
    Full graph rebuild: query all rlm_chunks, build DiGraph, store to Valkey.
    Called by /reindex endpoint and on service startup (non-blocking).

    Returns {nodes, edges, stored, hub_files_count}.
    """
    G = build_graph_from_pg(pg_conn)
    if G is None:
        return {"nodes": 0, "edges": 0, "stored": 0, "hub_files_count": 0}
    stored = store_graph_in_valkey(G, cache_client)
    hubs = get_hub_files(cache_client)
    return {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "stored": stored,
        "hub_files_count": len(hubs),
    }


def _get_cache_client():
    """Return a redis-py client connected to Valkey, or None if unavailable."""
    try:
        import redis
        client = redis.Redis(
            host=os.environ.get("REDIS_HOST", "127.0.0.1"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
            socket_timeout=1,
        )
        client.ping()
        return client
    except Exception:
        return None
