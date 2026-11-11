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


#: Cached per-connection result of "does rlm_chunks have migration 030's
#: columns?" so the probe runs once, not once per file per query.
_HAS_029_COLUMNS = {}


def _has_stat_columns(pg_conn) -> bool:
    """True when migration 030 (file_mtime/file_size/embedding_model) is applied."""
    key = id(pg_conn)
    if key in _HAS_029_COLUMNS:
        return _HAS_029_COLUMNS[key]
    present = False
    try:
        with pg_conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM information_schema.columns
                WHERE table_name = 'rlm_chunks'
                  AND column_name IN ('file_mtime', 'file_size', 'embedding_model')
            """)
            row = cur.fetchone()
            # isinstance guard: unit tests drive this through a fake cursor
            # that answers every query with the same canned row.
            present = bool(row) and isinstance(row[0], int) and row[0] == 3
    except Exception as e:
        log.debug("rlm_029_probe_failed error=%s", str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
    if len(_HAS_029_COLUMNS) > 32:
        _HAS_029_COLUMNS.clear()
    _HAS_029_COLUMNS[key] = present
    return present


def file_stat(filepath: str):
    """``(mtime, size)`` for *filepath*, or ``(None, None)`` if unreadable."""
    try:
        info = os.stat(filepath)
        return float(info.st_mtime), int(info.st_size)
    except OSError:
        return None, None


def is_stale(filepath: str, pg_conn) -> bool:
    """
    Check whether *filepath* needs re-ingestion.

    Returns True if the file is new or has changed, False when the stored
    chunks are up to date.

    rlm-service.py's /query handler calls ingest_directory() on EVERY query,
    which called this for every file in the tree, which SHA-256'd every byte
    of every file — the full hash of the whole codebase, per query. Migration
    029 stores the source file's mtime and size at ingest time, so the common
    case (nothing touched) now short-circuits on a stat() and never opens the
    file. The hash is still the authority: it runs whenever mtime/size differ
    or are unknown, so a content change with a preserved mtime is still
    caught by the hash on the next genuine stat difference, and `force=True`
    (gsd-tools reindex) bypasses the check entirely.
    """
    abs_path = str(os.path.abspath(filepath))
    has_stat = _has_stat_columns(pg_conn)
    mtime, size = file_stat(abs_path)

    columns = "sha256, file_mtime, file_size" if has_stat else "sha256, NULL, NULL"
    try:
        with pg_conn.cursor() as cur:
            cur.execute(
                f"SELECT {columns} FROM rlm_chunks WHERE file_path = %s LIMIT 1",
                (abs_path,),
            )
            row = cur.fetchone()
    except Exception as e:
        log.debug("is_stale_query_failed path=%s error=%s", filepath, str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
        return True

    if row is None:
        return True  # Not yet indexed

    # Tolerate a short row: a pre-029 database answers the two NULL literals,
    # but a caller-supplied fake connection may hand back just (sha,).
    stored_sha = row[0]
    stored_mtime = row[1] if len(row) > 1 else None
    stored_size = row[2] if len(row) > 2 else None
    # Cheap short-circuit: same mtime AND same size => unchanged, skip the hash.
    if (has_stat and mtime is not None and stored_mtime is not None
            and stored_size is not None
            and int(stored_size) == size
            and abs(float(stored_mtime) - mtime) < 1e-6):
        return False

    current_sha = file_sha256(abs_path)
    if not current_sha:
        return True  # Unreadable file -- treat as stale
    return (stored_sha or "").strip() != current_sha


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
        "chunks_deleted": 0,
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
    from services.rlm_embeddings import INPUT_TYPE_DOCUMENT, embed_code

    # Determine if this is a code file (embeddings enabled)
    embed_eligible = ext in AST_EXTENSIONS
    has_stat = _has_stat_columns(pg_conn)
    mtime, size = file_stat(filepath)

    #: rlm_chunks.id of every chunk written in this pass. Anything else still
    #: carrying this file_path is a leftover from a previous version of the
    #: file and is deleted below.
    written_ids = []

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
                embedding_model = None
                if embed_eligible:
                    try:
                        embedded = embed_code(
                            chunk.get("content", chunk.get("text", "")),
                            input_type=INPUT_TYPE_DOCUMENT,
                        )
                        if embedded is not None:
                            raw_embedding, embedding_model = embedded
                            embedding = _embedding_to_pg(raw_embedding)
                    except Exception as e:
                        log.debug("embed_failed path=%s symbol=%s error=%s",
                                  filepath, chunk.get("symbol_name", ""), str(e))

                symbol_name = chunk.get("symbol_name", chunk.get("label", ""))
                start_line = chunk.get("start_line", 0)

                extra_columns = ""
                extra_placeholders = ""
                extra_updates = ""
                extra_values = ()
                if has_stat:
                    extra_columns = ", embedding_model, file_mtime, file_size"
                    extra_placeholders = ", %s, %s, %s"
                    extra_updates = (
                        ", embedding_model = EXCLUDED.embedding_model"
                        ", file_mtime = EXCLUDED.file_mtime"
                        ", file_size = EXCLUDED.file_size"
                    )
                    extra_values = (embedding_model, mtime, size)

                # Upsert by (file_path, symbol_name, start_line)
                cur.execute(f"""
                    INSERT INTO rlm_chunks
                        (file_path, symbol_name, symbol_type, start_line, end_line,
                         content, description, sha256, dependencies, dependents,
                         embedding_code, updated_at{extra_columns})
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector,
                            NOW(){extra_placeholders})
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
                        updated_at     = NOW(){extra_updates}
                    RETURNING id
                """, (
                    filepath,
                    symbol_name,
                    chunk.get("symbol_type", "legacy"),
                    start_line,
                    chunk.get("end_line", 0),
                    chunk.get("content", chunk.get("text", "")),
                    description,
                    sha,
                    chunk.get("dependencies", []),
                    chunk.get("dependents", []),
                    embedding,
                ) + extra_values)
                returned = cur.fetchone()
                if returned:
                    written_ids.append(returned[0])
                inserted += 1

            # Delete this file's stale chunks.
            #
            # The upsert key is (file_path, symbol_name, start_line), so a
            # renamed function, a deleted function, or ANY edit that shifts a
            # symbol's starting line leaves the previous row behind forever.
            # Over a few hundred edits the index fills with chunks whose
            # content no longer exists in the file, and BM25 happily returns
            # them. Every row still carrying this file_path that was not
            # written in this pass is by definition stale.
            if written_ids:
                cur.execute(
                    "DELETE FROM rlm_chunks "
                    "WHERE file_path = %s AND id <> ALL(%s)",
                    (filepath, written_ids),
                )
                deleted = cur.rowcount
                result["chunks_deleted"] = deleted if deleted and deleted > 0 else 0
                if result["chunks_deleted"]:
                    log.info("ingest_pruned_stale path=%s chunks=%d",
                             filepath, result["chunks_deleted"])
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


def prune_missing_files(dir_path: str, pg_conn, seen_paths=None) -> int:
    """Delete chunks for files that no longer exist under *dir_path*.

    Nothing ever removed a deleted file's chunks: ``is_stale`` only looks at
    files that still exist, so renaming or deleting a source file left its
    whole chunk set in the index to be returned by BM25 forever.

    Existence is checked with ``os.path.isfile`` against the paths recorded in
    rlm_chunks rather than against *seen_paths*, so a file the current scan
    skipped (unsupported extension, inside a SKIP_DIR) is not mistaken for a
    deletion. Returns the number of rows deleted.
    """
    dir_path = str(os.path.abspath(dir_path))
    prefix = dir_path.rstrip(os.sep)
    try:
        with pg_conn.cursor() as cur:
            # Exact match OR a child path. A bare `LIKE prefix%` would also
            # match a sibling directory whose name starts with this one.
            cur.execute(
                "SELECT DISTINCT file_path FROM rlm_chunks "
                "WHERE file_path = %s OR file_path LIKE %s",
                (prefix, prefix + os.sep + "%"),
            )
            indexed = [row[0] for row in cur.fetchall()]
            missing = [p for p in indexed if not os.path.isfile(p)]
            if not missing:
                return 0
            cur.execute(
                "DELETE FROM rlm_chunks WHERE file_path = ANY(%s)", (missing,)
            )
            deleted = cur.rowcount or 0
        pg_conn.commit()
        if deleted:
            log.info("prune_missing_files dir=%s files=%d chunks=%d",
                     dir_path, len(missing), deleted)
        return deleted
    except Exception as e:
        log.warning("prune_missing_files_failed dir=%s error=%s", dir_path, str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
        return 0


def ingest_directory(dir_path: str, pg_conn, force: bool = False,
                     prune: bool = False) -> dict:
    """
    Recursively ingest all supported files in a directory.
    Skips SKIP_DIRS. Used by 'gsd-tools reindex [path]'.

    Args:
        prune: also remove chunks for files that no longer exist under
               *dir_path*. Defaults to False because rlm-service.py's /query
               handler calls this on EVERY query, often against a narrow
               subtree — deleting "missing" files there would be a per-query
               scan and a chance to drop chunks for a file that is merely
               temporarily unreadable. The explicit /reindex pass sets it
               True. Per-file stale-chunk deletion happens in ingest_file
               regardless.

    Returns {total_files, inserted, skipped, errors, error_files,
             chunks_deleted, files_pruned}.
    """
    dir_path = str(os.path.abspath(dir_path))
    all_extensions = AST_EXTENSIONS | LEGACY_EXTENSIONS
    stats = {
        "total_files": 0,
        "inserted": 0,
        "skipped": 0,
        "errors": 0,
        "error_files": [],
        "chunks_deleted": 0,
        "files_pruned": 0,
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
            stats["chunks_deleted"] += res.get("chunks_deleted", 0)
            if res["status"] == "inserted":
                stats["inserted"] += 1
            elif res["status"] == "error":
                stats["errors"] += 1
                stats["error_files"].append(fpath)
            else:
                stats["skipped"] += 1

    if prune:
        pruned = prune_missing_files(dir_path, pg_conn)
        stats["files_pruned"] = pruned
        stats["chunks_deleted"] += pruned

    log.info(
        "ingest_directory_done dir=%s files=%d inserted=%d skipped=%d errors=%d "
        "chunks_deleted=%d",
        dir_path, stats["total_files"], stats["inserted"], stats["skipped"],
        stats["errors"], stats["chunks_deleted"],
    )
    return stats
