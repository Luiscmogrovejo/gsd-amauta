#!/usr/bin/env python3
"""
Dependency graph for GSD-Amauta RLM — Phase 27 / RLM-06.

Builds a NetworkX DiGraph from rlm_chunks.dependencies entries.
Nodes: symbol_name values (functions, classes, methods).
Edges: symbol_name -> dependency (calls, imports, inherits).
Stores adjacency lists in Valkey as JSON at key rlm:graph:{symbol_name}.
PageRank identifies architectural hub files (top-20).

Build triggers: rlm-service.py startup (non-blocking), /reindex completion,
and /query post-ingest when new chunks were inserted.
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
    Edges: symbol_name -> resolved dependency, ONLY when the raw dependency
    string (a bare call/import name, e.g. "helper") resolves to a known
    symbol_name -- either an exact match, or a unique match via the
    last-dotted-segment suffix map (e.g. "helper" -> "Cls.helper" when that
    is the only symbol ending in ".helper"). Ambiguous or unresolved deps are
    counted and logged once per build; self-edges are skipped.

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

    # First pass: collect all known symbol names + a suffix map keyed by the
    # last "." segment (e.g. "Cls.helper" registers under "helper").
    symbol_set = set()
    suffix_map: dict = {}
    for symbol_name, _deps, _file_path in rows:
        symbol_set.add(symbol_name)
        suffix = symbol_name.rsplit(".", 1)[-1]
        suffix_map.setdefault(suffix, []).append(symbol_name)

    G = nx.DiGraph()
    resolved_count = 0
    unresolved_count = 0
    ambiguous_count = 0

    for symbol_name, deps, file_path in rows:
        G.add_node(symbol_name, file_path=file_path or "")
        if not deps:
            continue
        for dep in deps:
            if not dep or not dep.strip():
                continue
            dep = dep.strip()

            resolved = None
            if dep in symbol_set:
                resolved = dep
            else:
                candidates = suffix_map.get(dep)
                if candidates and len(candidates) == 1:
                    resolved = candidates[0]
                elif candidates and len(candidates) > 1:
                    ambiguous_count += 1
                    continue

            if resolved is None:
                unresolved_count += 1
                continue

            if resolved == symbol_name:
                continue  # skip self-edges

            resolved_count += 1
            G.add_edge(symbol_name, resolved)

    log.info(
        "graph_edges_resolved resolved=%d unresolved=%d ambiguous=%d",
        resolved_count, unresolved_count, ambiguous_count,
    )
    log.info("graph_built nodes=%d edges=%d", G.number_of_nodes(), G.number_of_edges())
    return G


def update_dependents_in_pg(G, pg_conn) -> int:
    """
    Reverse-pass: for every node with at least one predecessor (caller),
    write the sorted, capped (50) predecessor list into rlm_chunks.dependents
    via UPDATE ... WHERE symbol_name = %s. Commits once at the end.

    Returns the count of symbols updated. Never raises -- rolls back and
    returns 0 on any exception (log.warning).
    """
    if G is None or pg_conn is None:
        return 0

    updated = 0
    try:
        with pg_conn.cursor() as cur:
            for node in G.nodes():
                predecessors = sorted(G.predecessors(node))
                if not predecessors:
                    continue
                capped = predecessors[:50]
                cur.execute(
                    "UPDATE rlm_chunks SET dependents = %s WHERE symbol_name = %s",
                    (capped, node),
                )
                updated += 1
        pg_conn.commit()
        return updated
    except Exception as e:
        log.warning("update_dependents_failed error=%s", str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
        return 0


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
    Full graph rebuild: query all rlm_chunks, build DiGraph, store to Valkey,
    reverse-pass dependents into PG.
    Called by rlm-service.py startup (non-blocking), /reindex completion,
    and /query post-ingest when new chunks were inserted.

    Returns {nodes, edges, stored, hub_files_count, dependents_updated}.
    """
    G = build_graph_from_pg(pg_conn)
    if G is None:
        return {"nodes": 0, "edges": 0, "stored": 0, "hub_files_count": 0, "dependents_updated": 0}
    stored = store_graph_in_valkey(G, cache_client)
    hubs = get_hub_files(cache_client)
    dependents_updated = update_dependents_in_pg(G, pg_conn)
    return {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "stored": stored,
        "hub_files_count": len(hubs),
        "dependents_updated": dependents_updated,
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
