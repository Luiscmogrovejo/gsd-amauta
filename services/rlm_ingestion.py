#!/usr/bin/env python3
"""
RLM ingestion engine for GSD-Amauta -- Phase 27 / RLM-01, RLM-02, RLM-03.

Provides lazy on-demand ingestion of code files into rlm_chunks:
  1. SHA-256 staleness check -- skip unchanged files
  2. AST-aware chunking (tree-sitter) or legacy fixed-char fallback
  3. Caveman description generation per chunk
  4. Embedding generation (Voyage Code 3 or Qodo-Embed or None)
  5. Upsert into rlm_chunks by (file_path, symbol_name, start_line)

Called by:
  - rlm-service.py /search endpoint (lazy on first query touching a file)
  - gsd-tools reindex [path] CLI command (explicit full rescan)

IMPORTANT: Startup does NOT trigger ingestion -- would add 10+ seconds for large codebases.
"""

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger("amauta.rlm_ingestion")

# File extensions handled by AST chunker (vs legacy fallback).
# Phase 69: single-sourced from services.ast_chunker -- a hardcoded duplicate
# here previously drifted out of sync and silently skipped the Kotlin/Swift/
# Go/Rust/Java mobile-stack grammars at the skip gate below. Do NOT wrap this
# import in try/except: if services.ast_chunker cannot import, ingest_file's
# own `from services.ast_chunker import ...` (below, at call time) is already
# broken and must fail loudly, not silently degrade (Phase 60/65 learning).
from services.ast_chunker import AST_CODE_EXTENSIONS as AST_EXTENSIONS

# Extensions that get BM25 only (no embeddings, no dependency graph edges)
LEGACY_EXTENSIONS = {
    ".md", ".mdx", ".sql", ".yaml", ".yml", ".json", ".sh", ".bash",
    ".txt", ".log", ".csv", ".env", ".toml",
}

# Directories to skip during directory scan
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "target", ".tox",
    "coverage", ".nyc_output", ".pytest_cache",
}


def file_sha256(filepath: str) -> str:
    """Compute SHA-256 hex digest of a file's contents."""
    h = hashlib.sha256()
    try:
        with open(filepath, "rb") as f:
            for block in iter(lambda: f.read(65536), b""):
                h.update(block)
    except OSError:
        return ""
    return h.hexdigest()


def is_stale(filepath: str, pg_conn) -> bool:
    """
    Check if any rlm_chunks rows for this file have a different sha256 than the current file.
    Returns True if file is new or has changed (needs re-ingestion).
    Returns False if file content matches stored sha256 (skip re-ingestion).
    """
    current_sha = file_sha256(filepath)
    if not current_sha:
        return True  # Unreadable file -- treat as stale

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT sha256 FROM rlm_chunks WHERE file_path = %s LIMIT 1",
            (str(os.path.abspath(filepath)),)
        )
        row = cur.fetchone()

    if row is None:
        return True  # Not yet indexed
    stored_sha = row[0].strip()  # CHAR(64) may have trailing spaces
    return stored_sha != current_sha


def _embedding_to_pg(embedding: Optional[list]) -> Optional[str]:
    """
    Convert a Python list of floats to a pgvector literal string.
    pgvector format: '[f1,f2,...,f1024]'
    Returns None if embedding is None (BM25-only path).
    """
    if embedding is None:
        return None
    return "[" + ",".join(str(f) for f in embedding) + "]"


def ingest_file(filepath: str, pg_conn, force: bool = False) -> dict:
    """
    Ingest a single file into rlm_chunks.

    Returns a result dict: {filepath, status, chunks_inserted, chunks_skipped, error}
    Status values: 'inserted', 'skipped' (up-to-date), 'error'

    Steps:
    1. SHA-256 staleness check (skip if up-to-date, unless force=True)
    2. Chunk file: AST-aware for code, legacy for non-code
    3. Generate caveman description per chunk
    4. Generate embedding per chunk (None if no model available)
    5. Upsert into rlm_chunks via ON CONFLICT DO UPDATE
    """
    filepath = str(os.path.abspath(filepath))
    result = {
        "filepath": filepath,
        "status": "skipped",
        "chunks_inserted": 0,
        "chunks_skipped": 0,
        "error": None,
    }

    if not os.path.isfile(filepath):
        result["status"] = "error"
        result["error"] = "file_not_found"
        return result

    ext = Path(filepath).suffix.lower()

    # Skip unknown extensions
    if ext not in AST_EXTENSIONS and ext not in LEGACY_EXTENSIONS:
        result["status"] = "skipped"
        result["chunks_skipped"] = 0
        return result

    # Staleness check
    if not force and not is_stale(filepath, pg_conn):
        result["status"] = "skipped"
        return result

    # Compute SHA-256 for this ingestion run
    sha = file_sha256(filepath)

    # Chunk the file
    try:
        from services.ast_chunker import chunk_file_ast, legacy_chunker, is_code_file
        if is_code_file(filepath):
            chunks = chunk_file_ast(filepath)
            if not chunks:
                # AST parse failed or empty -- fall back to legacy
                log.debug("ingest_ast_empty_fallback path=%s", filepath)
                chunks = legacy_chunker(filepath)
                # Mark as legacy type
                for c in chunks:
                    c.setdefault("symbol_type", "legacy")
                    c.setdefault("symbol_name", c.get("label", ""))
                    c.setdefault("dependencies", [])
                    c.setdefault("dependents", [])
                    c.setdefault("file_path", filepath)
        else:
            chunks = legacy_chunker(filepath)
            for c in chunks:
                c.setdefault("symbol_type", "legacy")
                c.setdefault("symbol_name", c.get("label", ""))
                c.setdefault("dependencies", [])
                c.setdefault("dependents", [])
                c.setdefault("file_path", filepath)
    except Exception as e:
        log.error("ingest_chunk_failed path=%s error=%s", filepath, str(e))
        result["status"] = "error"
        result["error"] = str(e)
        return result

    if not chunks:
        result["status"] = "skipped"
        return result

    # Generate descriptions and embeddings; upsert
    from services.caveman_descriptions import describe_chunk
    from services.rlm_embeddings import generate_code_embedding

    # Determine if this is a code file (embeddings enabled)
    embed_eligible = ext in AST_EXTENSIONS

    inserted = 0
    try:
        with pg_conn.cursor() as cur:
            for chunk in chunks:
                description = ""
                try:
                    description = describe_chunk(chunk)
                except Exception as e:
                    log.debug("describe_chunk_failed path=%s error=%s", filepath, str(e))

                embedding = None
                if embed_eligible:
                    try:
                        raw_embedding = generate_code_embedding(
                            chunk.get("content", chunk.get("text", ""))
                        )
                        embedding = _embedding_to_pg(raw_embedding)
                    except Exception as e:
                        log.debug("embed_failed path=%s symbol=%s error=%s",
                                  filepath, chunk.get("symbol_name", ""), str(e))

                # Upsert by (file_path, symbol_name, start_line)
                cur.execute("""
                    INSERT INTO rlm_chunks
                        (file_path, symbol_name, symbol_type, start_line, end_line,
                         content, description, sha256, dependencies, dependents,
                         embedding_code, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector, NOW())
                    ON CONFLICT (file_path, symbol_name, start_line)
                    DO UPDATE SET
                        symbol_type    = EXCLUDED.symbol_type,
                        end_line       = EXCLUDED.end_line,
                        content        = EXCLUDED.content,
                        description    = EXCLUDED.description,
                        sha256         = EXCLUDED.sha256,
                        dependencies   = EXCLUDED.dependencies,
                        dependents     = EXCLUDED.dependents,
                        embedding_code = EXCLUDED.embedding_code,
                        updated_at     = NOW()
                """, (
                    filepath,
                    chunk.get("symbol_name", chunk.get("label", "")),
                    chunk.get("symbol_type", "legacy"),
                    chunk.get("start_line", 0),
                    chunk.get("end_line", 0),
                    chunk.get("content", chunk.get("text", "")),
                    description,
                    sha,
                    chunk.get("dependencies", []),
                    chunk.get("dependents", []),
                    embedding,
                ))
                inserted += 1
        pg_conn.commit()
    except Exception as e:
        log.error("ingest_upsert_failed path=%s error=%s", filepath, str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
        result["status"] = "error"
        result["error"] = str(e)
        return result

    result["status"] = "inserted"
    result["chunks_inserted"] = inserted
    log.info("ingest_done path=%s chunks=%d sha=%s", filepath, inserted, sha[:8])
    return result


def ingest_directory(dir_path: str, pg_conn, force: bool = False) -> dict:
    """
    Recursively ingest all supported files in a directory.
    Skips SKIP_DIRS. Used by 'gsd-tools reindex [path]'.

    Returns {total_files, inserted, skipped, errors, error_files}.
    """
    dir_path = str(os.path.abspath(dir_path))
    all_extensions = AST_EXTENSIONS | LEGACY_EXTENSIONS
    stats = {
        "total_files": 0,
        "inserted": 0,
        "skipped": 0,
        "errors": 0,
        "error_files": [],
    }

    for root, dirs, files in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for fname in files:
            ext = Path(fname).suffix.lower()
            if ext not in all_extensions:
                continue
            fpath = os.path.join(root, fname)
            stats["total_files"] += 1
            res = ingest_file(fpath, pg_conn, force=force)
            if res["status"] == "inserted":
                stats["inserted"] += 1
            elif res["status"] == "error":
                stats["errors"] += 1
                stats["error_files"].append(fpath)
            else:
                stats["skipped"] += 1

    log.info(
        "ingest_directory_done dir=%s files=%d inserted=%d skipped=%d errors=%d",
        dir_path, stats["total_files"], stats["inserted"], stats["skipped"], stats["errors"],
    )
    return stats
