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

Phase 89 plan 89-08 (RET-05, B2) -- ingestion is an EMBEDDING SPEND, and the bulk
of it: it embeds inline, per chunk. It is therefore under the same three controls
as services/embedding_backfill.py:

  * ``count_corpus_tokens(paths)`` -- the ONE implementation of "how many tokens
    would embedding this corpus cost". Same directory walk, same SKIP_DIRS, same
    eligibility rule (``ext in AST_EXTENSIONS``), same chunker and the same
    ``content[:8192]`` truncation as ``ingest_file``, and not one embedding call.
    ``embeddings backfill --use code_index --count-only`` calls it.
  * ``ingest_with_budget(paths, conn, budget_tokens)`` -- refuses to start
    without a budget (``ingestion_budget_required``) and above it
    (``ingestion_budget_exceeded``, naming both numbers).
  * ``tokens_spent`` -- accounted per file, returned in the stats, and written to
    ``embedding_state`` (use ``code_index``) in the file's own transaction, so a
    run that dies half way has a known spend.

CLI: ``rlm_ingestion.py ingest <path>... [--count-only] [--budget-tokens N]
[--force] [--prune] [--dsn DSN]``. Exit 0 done, 2 refused, 4 incomplete, 1 error.

In-process callers that pass no budget (the RLM service's lazy per-query
ingestion) keep working; set ``GSD_RLM_INGEST_BUDGET_TOKENS`` in that process to
hold them to a budget too -- above it the call ingests NOTHING and says so in its
stats (``refused``).
"""

import argparse
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

log = logging.getLogger("amauta.rlm_ingestion")

if __name__ == "__main__" and not __package__:  # launched as a script (plan 89-08 CLI)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# File extensions handled by AST chunker (vs legacy fallback).
# Phase 69: single-sourced from services.ast_chunker -- a hardcoded duplicate
# here previously drifted out of sync and silently skipped the Kotlin/Swift/
# Go/Rust/Java mobile-stack grammars at the skip gate below. Do NOT wrap this
# import in try/except: if services.ast_chunker cannot import, ingest_file's
# own `from services.ast_chunker import ...` (below, at call time) is already
# broken and must fail loudly, not silently degrade (Phase 60/65 learning).
from services.ast_chunker import AST_CODE_EXTENSIONS as AST_EXTENSIONS
# One owner for the directory-prefix LIKE pattern (plan 89-07): on Windows
# `os.sep` IS the LIKE escape character, so `prefix + os.sep + "%"` bound a
# pattern that matched nothing. rlm_search imports nothing from here, so this
# direction is acyclic.
from services.rlm_search import beneath_patterns
# Plan 89-08: the store's ACTIVE model, the token estimator and the spend record.
# embedding_backfill imports this module only inside a function, so this
# direction is acyclic too.
from services import embedding_backfill, harness_config

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


#: The embedder sends ``text[:8192]`` (services/rlm_embeddings.py), so that is
#: what a chunk costs and what the counter measures.
EMBED_TRUNCATION_CHARS = 8192

#: Environment variable holding a budget for in-process callers that pass none.
AMBIENT_BUDGET_ENV = "GSD_RLM_INGEST_BUDGET_TOKENS"

ELIGIBILITY_RULE = (
    "a file is embedded when its extension is in AST_EXTENSIONS "
    "(embed_eligible = ext in AST_EXTENSIONS); LEGACY_EXTENSIONS files are "
    "indexed for the lexical leg only and cost nothing; any other extension is "
    "not ingested at all"
)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2
EXIT_INCOMPLETE = 4


class IngestionBudgetError(Exception):
    """A typed refusal of an ingestion run, in embedding_backfill's own form.

    Args:
        code: ``ingestion_budget_required`` or ``ingestion_budget_exceeded``.
        message: one sentence naming the numbers.
        details: ``tokens_total``, ``budget_tokens`` and the counted corpus.
    """

    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def to_dict(self):
        """Returns: dict ``{"error": code, "message": ..., ...details}``."""
        payload = {"error": self.code, "message": self.message}
        payload.update(self.details)
        return payload


class _SpendLedger:
    """Tokens spent by one ingestion run, against an optional budget."""

    def __init__(self, budget_tokens=None):
        self.budget_tokens = budget_tokens
        self.spent = 0

    def would_exceed(self, tokens):
        return self.budget_tokens is not None and self.spent + tokens > self.budget_tokens


def chunk_text(chunk) -> str:
    """The text of *chunk* that is stored and embedded (one definition, two readers)."""
    return chunk.get("content", chunk.get("text", ""))


def chunk_embed_tokens(chunk) -> int:
    """Estimated tokens embedding *chunk* costs: 0 for a blank one (never sent)."""
    text = chunk_text(chunk)
    if not text or not text.strip():
        return 0
    return harness_config.estimate_tokens(text[:EMBED_TRUNCATION_CHARS])


def chunks_for_file(filepath: str) -> list:
    """Chunk *filepath* exactly as ingestion stores it.

    AST-aware for code, the legacy chunker otherwise and as the fallback when the
    AST parse yields nothing. Used by ``ingest_file`` AND by the token counter, so
    the count cannot drift from what is ingested.

    Raises:
        Exception: whatever the chunker raises; the caller decides.
    """
    from services.ast_chunker import chunk_file_ast, legacy_chunker, is_code_file
    if is_code_file(filepath):
        chunks = chunk_file_ast(filepath)
        if chunks:
            return chunks
        # AST parse failed or empty -- fall back to legacy
        log.debug("ingest_ast_empty_fallback path=%s", filepath)
    chunks = legacy_chunker(filepath)
    for c in chunks:
        c.setdefault("symbol_type", "legacy")
        c.setdefault("symbol_name", c.get("label", ""))
        c.setdefault("dependencies", [])
        c.setdefault("dependents", [])
        c.setdefault("file_path", filepath)
    return chunks


def iter_corpus_files(path: str):
    """Yield every file ingestion would visit under *path* (a file or a directory).

    The one walk: ``ingest_directory`` and ``count_corpus_tokens`` both use it.
    """
    path = str(os.path.abspath(path))
    all_extensions = AST_EXTENSIONS | LEGACY_EXTENSIONS
    if os.path.isfile(path):
        if Path(path).suffix.lower() in all_extensions:
            yield path
        return
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for fname in files:
            if Path(fname).suffix.lower() in all_extensions:
                yield os.path.join(root, fname)


def count_corpus_tokens(paths, pg_conn=None, only_stale=False) -> dict:
    """How many tokens embedding the corpus under *paths* would cost. Spends nothing.

    Resolves the corpus exactly as ingestion does and makes NO embedding call.
    Only ELIGIBLE files count (see :data:`ELIGIBILITY_RULE`).

    Args:
        paths: files and/or directories.
        pg_conn: with ``only_stale=True``, files whose stored chunks are up to
            date contribute 0 -- what an incremental run would really spend.
        only_stale: see ``pg_conn``. The default counts the whole corpus and
            needs no database.

    Returns:
        dict: ``{tokens_total, files_supported, files_eligible, files_ineligible,
        files_unreadable, chunks_eligible, truncation_chars, eligibility_rule,
        token_estimate, trees: [{path, tokens, files_eligible, chunks_eligible}]}``.

    Example:
        >>> count_corpus_tokens([])["tokens_total"]
        0
    """
    if isinstance(paths, (str, os.PathLike)):
        paths = [paths]
    totals = {"tokens_total": 0, "files_supported": 0, "files_eligible": 0,
              "files_ineligible": 0, "files_unreadable": 0, "chunks_eligible": 0}
    trees = []
    for path in paths:
        tree = {"path": str(os.path.abspath(path)), "tokens": 0,
                "files_eligible": 0, "chunks_eligible": 0}
        for fpath in iter_corpus_files(path):
            totals["files_supported"] += 1
            if Path(fpath).suffix.lower() not in AST_EXTENSIONS:
                totals["files_ineligible"] += 1
                continue
            if only_stale and pg_conn is not None and not is_stale(fpath, pg_conn):
                continue
            try:
                chunks = chunks_for_file(fpath)
            except Exception as e:
                log.debug("count_chunk_failed path=%s error=%s", fpath, str(e))
                totals["files_unreadable"] += 1
                continue
            tokens = [chunk_embed_tokens(c) for c in chunks]
            tree["files_eligible"] += 1
            tree["chunks_eligible"] += sum(1 for t in tokens if t)
            tree["tokens"] += sum(tokens)
        totals["tokens_total"] += tree["tokens"]
        totals["files_eligible"] += tree["files_eligible"]
        totals["chunks_eligible"] += tree["chunks_eligible"]
        trees.append(tree)
    totals.update({
        "truncation_chars": EMBED_TRUNCATION_CHARS,
        "eligibility_rule": ELIGIBILITY_RULE,
        "token_estimate": "ceil(characters / 3) per chunk, an over-count by design",
        "only_stale": bool(only_stale and pg_conn is not None),
        "trees": trees,
    })
    return totals


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


def ingest_file(filepath: str, pg_conn, force: bool = False, ledger=None) -> dict:
    """
    Ingest a single file into rlm_chunks.

    Returns a result dict: {filepath, status, chunks_inserted, chunks_skipped,
    tokens_spent, embeddings_dropped, error}
    Status values: 'inserted', 'skipped' (up-to-date), 'error',
    'budget_exhausted' (plan 89-08: embedding this file would pass the run's
    budget; nothing was written and the walk stops)

    Plan 89-08: on a store with embedding_state, a chunk is embedded with the
    store's ACTIVE code-index model and a vector any OTHER model produced is not
    written (the row keeps its text and the lexical leg; `embeddings_dropped`
    counts them). Writing it would put two embedding spaces in one column, which
    is the state every vector query is then refused for.

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
        "tokens_spent": 0,
        "embeddings_dropped": 0,
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
        chunks = chunks_for_file(filepath)
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

    # Plan 89-08: the model this store's vectors are written with. None = the
    # store has no embedding_state (pre-034, or a stand-in connection): the
    # pre-034 behaviour, configured model with the local fallback.
    write_model = (embedding_backfill.active_model_for(
        pg_conn, harness_config.USE_CODE_INDEX) if embed_eligible else None)

    # The budget is checked per FILE, before anything is written for it, so a
    # run never stops with half a file's chunks embedded.
    if embed_eligible and ledger is not None:
        file_tokens = sum(chunk_embed_tokens(c) for c in chunks)
        if ledger.would_exceed(file_tokens):
            result["status"] = "budget_exhausted"
            result["error"] = "budget_exhausted"
            return result
    file_spent = 0

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
                        if write_model is None:
                            embedded = embed_code(
                                chunk_text(chunk), input_type=INPUT_TYPE_DOCUMENT)
                        else:
                            embedded = embed_code(
                                chunk_text(chunk), input_type=INPUT_TYPE_DOCUMENT,
                                model=write_model)
                        if embedded is not None:
                            file_spent += chunk_embed_tokens(chunk)
                            raw_embedding, embedding_model = embedded
                            if write_model is not None and embedding_model != write_model:
                                # Another model answered: not written.
                                result["embeddings_dropped"] += 1
                                embedding_model = None
                            else:
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
                    chunk_text(chunk),
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
            # tokens_spent, in the SAME transaction as the chunks it paid for.
            if file_spent and write_model is not None:
                cur.execute(
                    "UPDATE embedding_state SET tokens_spent = tokens_spent + %s, "
                    "updated_at = NOW() WHERE use = %s",
                    (file_spent, harness_config.USE_CODE_INDEX))
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
    result["tokens_spent"] = file_spent
    if ledger is not None:
        ledger.spent += file_spent
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
    prefix = dir_path.rstrip("/\\")
    try:
        with pg_conn.cursor() as cur:
            # Exact match OR a child path. A bare `LIKE prefix%` would also
            # match a sibling directory whose name starts with this one.
            cur.execute(
                "SELECT DISTINCT file_path FROM rlm_chunks "
                "WHERE file_path = %s OR file_path LIKE %s OR file_path LIKE %s",
                tuple([prefix] + beneath_patterns(prefix)),
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


def _ambient_budget():
    """The budget for callers that pass none, from the environment; None when unset."""
    raw = (os.environ.get(AMBIENT_BUDGET_ENV) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        log.error("ingest_ambient_budget_invalid value_is_not_an_integer env=%s",
                  AMBIENT_BUDGET_ENV)
        return 0  # an unreadable budget is a budget of nothing, never "no budget"


def check_budget(paths, pg_conn, budget_tokens, force=False) -> dict:
    """Count what a run over *paths* would spend and refuse it above the budget.

    Returns:
        dict: the count (``count_corpus_tokens``' result).

    Raises:
        IngestionBudgetError: ``ingestion_budget_required`` when *budget_tokens*
            is None; ``ingestion_budget_exceeded`` when the count is larger.
    """
    count = count_corpus_tokens(paths, pg_conn=pg_conn, only_stale=not force)
    total = count["tokens_total"]
    if budget_tokens is None:
        raise IngestionBudgetError(
            "ingestion_budget_required",
            "ingesting these trees would embed about %d tokens; it does not start "
            "without --budget-tokens" % total,
            tokens_total=total, budget_tokens=None, corpus=count)
    if total > budget_tokens:
        raise IngestionBudgetError(
            "ingestion_budget_exceeded",
            "the counted total is %d tokens and the budget is %d tokens; nothing "
            "was ingested" % (total, budget_tokens),
            tokens_total=total, budget_tokens=budget_tokens, corpus=count)
    return count


def ingest_with_budget(paths, pg_conn, budget_tokens, force: bool = False,
                       prune: bool = False) -> dict:
    """Ingest *paths* under a token budget: counted first, refused above it.

    Args:
        paths: files and/or directories.
        pg_conn: psycopg2 connection.
        budget_tokens: the most this run may spend. REQUIRED.
        force: re-ingest unchanged files too.
        prune: remove chunks of files that no longer exist (directories only).

    Returns:
        dict: summed ``ingest_directory`` stats plus ``tokens_total`` (counted),
        ``tokens_spent``, ``budget_tokens`` and ``budget_exhausted``.

    Raises:
        IngestionBudgetError: before anything is written.
    """
    if isinstance(paths, (str, os.PathLike)):
        paths = [paths]
    count = check_budget(paths, pg_conn, budget_tokens, force=force)
    ledger = _SpendLedger(budget_tokens)
    if embedding_backfill.active_model_for(pg_conn, harness_config.USE_CODE_INDEX):
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE embedding_state SET started_at = NOW(), tokens_spent = 0, "
                    "budget_tokens = %s, updated_at = NOW() WHERE use = %s",
                    (budget_tokens, harness_config.USE_CODE_INDEX))
            pg_conn.commit()
        except Exception as e:
            log.warning("ingest_state_reset_failed error=%s", type(e).__name__)
            try:
                pg_conn.rollback()
            except Exception:
                pass
    total = {"total_files": 0, "inserted": 0, "skipped": 0, "errors": 0,
             "error_files": [], "chunks_deleted": 0, "files_pruned": 0,
             "embeddings_dropped": 0, "budget_exhausted": False}
    for path in paths:
        if total["budget_exhausted"]:
            break
        stats = _ingest_tree(str(path), pg_conn, force=force, prune=prune, ledger=ledger)
        for key in ("total_files", "inserted", "skipped", "errors", "chunks_deleted",
                    "files_pruned", "embeddings_dropped"):
            total[key] += stats.get(key, 0)
        total["error_files"].extend(stats.get("error_files", []))
        total["budget_exhausted"] = bool(stats.get("budget_exhausted"))
    total.update({"tokens_total": count["tokens_total"], "tokens_spent": ledger.spent,
                  "budget_tokens": budget_tokens})
    return total


def ingest_directory(dir_path: str, pg_conn, force: bool = False,
                     prune: bool = False, budget_tokens=None) -> dict:
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

        budget_tokens: plan 89-08 -- the most this call may spend. Counted
               first; above it ``IngestionBudgetError`` is raised and nothing is
               ingested. When omitted, ``GSD_RLM_INGEST_BUDGET_TOKENS`` (if
               set) is the budget, and a call above it ingests nothing and
               returns ``refused`` in its stats instead of raising, because the
               callers that pass no budget are the service's query path.

    Returns {total_files, inserted, skipped, errors, error_files,
             chunks_deleted, files_pruned, tokens_spent, embeddings_dropped,
             budget_exhausted[, refused]}.
    """
    if budget_tokens is not None:
        check_budget([dir_path], pg_conn, budget_tokens, force=force)
        return _ingest_tree(dir_path, pg_conn, force=force, prune=prune,
                            ledger=_SpendLedger(budget_tokens))
    ambient = _ambient_budget()
    if ambient is not None:
        try:
            check_budget([dir_path], pg_conn, ambient, force=force)
        except IngestionBudgetError as refusal:
            log.warning("ingest_refused_by_ambient_budget code=%s tokens_total=%s "
                        "budget_tokens=%s", refusal.code,
                        refusal.details.get("tokens_total"), ambient)
            stats = _empty_stats()
            payload = refusal.to_dict()
            payload.pop("corpus", None)
            stats["refused"] = payload
            return stats
        return _ingest_tree(dir_path, pg_conn, force=force, prune=prune,
                            ledger=_SpendLedger(ambient))
    return _ingest_tree(dir_path, pg_conn, force=force, prune=prune,
                        ledger=_SpendLedger(None))


def _empty_stats() -> dict:
    return {
        "total_files": 0,
        "inserted": 0,
        "skipped": 0,
        "errors": 0,
        "error_files": [],
        "chunks_deleted": 0,
        "files_pruned": 0,
        "tokens_spent": 0,
        "embeddings_dropped": 0,
        "budget_exhausted": False,
    }


def _ingest_tree(dir_path: str, pg_conn, force: bool = False,
                 prune: bool = False, ledger=None) -> dict:
    """The walk itself: every supported file under *dir_path* (or the one file)."""
    dir_path = str(os.path.abspath(dir_path))
    stats = _empty_stats()
    for fpath in iter_corpus_files(dir_path):
        stats["total_files"] += 1
        res = ingest_file(fpath, pg_conn, force=force, ledger=ledger)
        stats["chunks_deleted"] += res.get("chunks_deleted", 0)
        stats["tokens_spent"] += res.get("tokens_spent", 0)
        stats["embeddings_dropped"] += res.get("embeddings_dropped", 0)
        if res["status"] == "inserted":
            stats["inserted"] += 1
        elif res["status"] == "budget_exhausted":
            stats["total_files"] -= 1
            stats["budget_exhausted"] = True
            break
        elif res["status"] == "error":
            stats["errors"] += 1
            stats["error_files"].append(fpath)
        else:
            stats["skipped"] += 1

    if prune and os.path.isdir(dir_path) and not stats["budget_exhausted"]:
        pruned = prune_missing_files(dir_path, pg_conn)
        stats["files_pruned"] = pruned
        stats["chunks_deleted"] += pruned

    log.info(
        "ingest_directory_done dir=%s files=%d inserted=%d skipped=%d errors=%d "
        "chunks_deleted=%d tokens_spent=%d",
        dir_path, stats["total_files"], stats["inserted"], stats["skipped"],
        stats["errors"], stats["chunks_deleted"], stats["tokens_spent"],
    )
    return stats


def main(argv=None):
    """CLI: ``ingest <path>... [--count-only] [--budget-tokens N] [--force] [--prune]``.

    Prints one JSON document. ``--count-only`` needs no database and makes no
    embedding call. Without ``--count-only`` a budget is required.

    Returns:
        int: 0 done, 2 refused (budget), 4 incomplete (errors or budget
        exhausted mid-run), 1 internal error.
    """
    parser = argparse.ArgumentParser(
        prog="rlm_ingestion", description="Ingest source trees into the code index, "
        "under a token budget (RET-05).")
    sub = parser.add_subparsers(dest="verb", required=True)
    p_ingest = sub.add_parser("ingest")
    p_ingest.add_argument("paths", nargs="+")
    p_ingest.add_argument("--count-only", action="store_true")
    p_ingest.add_argument("--budget-tokens", type=int, default=None)
    p_ingest.add_argument("--force", action="store_true")
    p_ingest.add_argument("--prune", action="store_true")
    p_ingest.add_argument("--dsn", default=None)
    p_ingest.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    def out(payload):
        sys.stdout.write(json.dumps(payload, sort_keys=True, default=str) + "\n")
        sys.stdout.flush()

    conn = None
    try:
        if args.count_only:
            out(dict(count_corpus_tokens(args.paths), event="result", count_only=True,
                     tokens_spent=0))
            return EXIT_OK
        dsn = embedding_backfill._resolve_dsn(args.dsn)  # noqa: SLF001 - one resolver
        conn = embedding_backfill._connect(dsn)  # noqa: SLF001
        stats = ingest_with_budget(args.paths, conn, args.budget_tokens,
                                   force=args.force, prune=args.prune)
        out(dict(stats, event="result"))
        if stats["budget_exhausted"] or stats["errors"]:
            return EXIT_INCOMPLETE
        return EXIT_OK
    except IngestionBudgetError as refusal:
        payload = refusal.to_dict()
        payload.pop("corpus", None)
        out(payload)
        return EXIT_REFUSED
    except embedding_backfill.BackfillError as refusal:
        out(refusal.to_dict())
        return refusal.exit_code
    except Exception as exc:  # typed body; the trace goes to the log
        log.exception("rlm_ingestion_cli_failed")
        out({"error": "internal_error", "message": type(exc).__name__})
        return EXIT_ERROR
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
