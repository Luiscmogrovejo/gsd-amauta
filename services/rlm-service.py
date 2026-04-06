#!/usr/bin/env python3
"""
GSD-Amauta RLM Service — Retrieval-augmented context engine.

HTTP service on localhost:18798 that chunks files by code boundaries,
scores relevance against queries, and returns top-K chunks for injection
into Claude Code's context.

Based on MIT CSAIL RLM paper (arXiv:2512.24601v1). Simplified for local use:
no LLM calls from service (Claude Code IS the LLM), just retrieval + chunking + scoring.

Usage:
    python3 services/rlm-service.py start   # Background
    python3 services/rlm-service.py stop    # Stop
    python3 services/rlm-service.py status  # Check
    python3 services/rlm-service.py run     # Foreground

Endpoints:
    GET  /health                Health check
    POST /chunk                 Chunk a file into code-aware segments
    POST /search                Search files for relevant chunks
    POST /query                 Query a directory for relevant context
"""

import http.server
import json
import math
import os
import re
import signal

# ── Load .env file (project root) ─────────────────────────────────────────────
def _load_dotenv():
    for candidate in [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"),
        "/srv/amauta/.env",
    ]:
        if os.path.isfile(candidate):
            with open(candidate) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip().strip("'\"")
                    if key and key not in os.environ:
                        os.environ[key] = val
            break

_load_dotenv()
import sys
import time
from collections import OrderedDict
from pathlib import Path
from socketserver import ThreadingMixIn
import logging

# ── Structured Logging ─────────────────────────────────────────────────────────
_log_level = os.environ.get("AMAUTA_LOG_LEVEL", "INFO").upper()
_log_format = os.environ.get("AMAUTA_LOG_FORMAT", "text").lower()

class _JsonFormatter(logging.Formatter):
    """JSON log format for structured log aggregation."""
    def format(self, record):
        return json.dumps({
            "ts": self.formatTime(record), "level": record.levelname,
            "logger": record.name, "msg": record.getMessage(),
        })

_handler = logging.StreamHandler(sys.stderr)
if _log_format == "json":
    _handler.setFormatter(_JsonFormatter())
else:
    _handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
logging.basicConfig(level=getattr(logging, _log_level, logging.INFO), handlers=[_handler])
log = logging.getLogger("amauta.rlm")

# ═══════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════

HOST = "127.0.0.1"
PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
MAX_CHUNK_CHARS = int(os.environ.get("RLM_MAX_CHUNK_CHARS", "8000"))
DEFAULT_TOP_K = int(os.environ.get("RLM_DEFAULT_TOP_K", "10"))
CACHE_MAX_SIZE = int(os.environ.get("RLM_CACHE_SIZE", "200"))
CACHE_MAX_BYTES = int(os.environ.get("RLM_CACHE_MAX_MB", "512")) * 1024 * 1024  # 512MB default
PID_FILE = Path(__file__).resolve().parent / "rlm-service.pid"

# File extensions we know how to chunk
CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs",
    ".sql", ".sh", ".bash", ".zsh",
    ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h",
    ".css", ".scss", ".less",
}
MARKDOWN_EXTENSIONS = {".md", ".mdx", ".markdown"}
TEXT_EXTENSIONS = {".txt", ".log", ".csv", ".env", ".toml", ".yaml", ".yml", ".json", ".xml"}

# Directories to skip during directory scanning
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "target", ".tox",
    "coverage", ".nyc_output", ".pytest_cache",
}

# Sensitive paths that should never be served (path traversal protection)
_BLOCKED_PATHS = {"/etc/shadow", "/etc/passwd", "/etc/master.passwd"}
_BLOCKED_PREFIXES = ("/etc/", "/proc/", "/sys/", "/dev/")

def _is_safe_path(filepath: str) -> bool:
    """Reject requests for system files outside of project directories."""
    resolved = os.path.realpath(os.path.expanduser(filepath))
    if resolved in _BLOCKED_PATHS:
        return False
    for prefix in _BLOCKED_PREFIXES:
        if resolved.startswith(prefix):
            return False
    # Block hidden dirs in root (e.g. /root/.ssh)
    parts = Path(resolved).parts
    if len(parts) >= 3 and parts[1] == "root":
        return False
    return True

# ═══════════════════════════════════════════════════════
# LRU Cache for Chunked Files
# ═══════════════════════════════════════════════════════

class ChunkCache:
    """LRU cache for file chunks, keyed by (filepath, mtime)."""

    def __init__(self, max_size=200):
        self._cache = OrderedDict()
        self._max_size = max_size
        self._current_bytes = 0

    def get(self, filepath, mtime):
        key = (filepath, mtime)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def put(self, filepath, mtime, chunks):
        key = (filepath, mtime)
        if key in self._cache:
            # Subtract old size before updating
            old_chunks = self._cache[key]
            self._current_bytes -= sum(len(c.get("text", "")) for c in old_chunks) * 2
            self._cache.move_to_end(key)
        else:
            if len(self._cache) >= self._max_size:
                _, evicted = self._cache.popitem(last=False)
                self._current_bytes -= sum(len(c.get("text", "")) for c in evicted) * 2
        # Estimate memory usage and evict if over limit
        entry_size = sum(len(c.get("text", "")) for c in chunks) * 2  # rough char→bytes estimate
        while self._current_bytes + entry_size > CACHE_MAX_BYTES and self._cache:
            _, evicted = self._cache.popitem(last=False)
            self._current_bytes -= sum(len(c.get("text", "")) for c in evicted) * 2
        self._current_bytes += entry_size
        self._cache[key] = chunks

    def clear(self):
        self._cache.clear()
        self._current_bytes = 0

    @property
    def size(self):
        return len(self._cache)


CHUNK_CACHE = ChunkCache(max_size=CACHE_MAX_SIZE)


# ═══════════════════════════════════════════════════════
# Persistent Mtime Index (cross-restart incremental indexing)
# ═══════════════════════════════════════════════════════

class MtimeIndex:
    """Persistent file modification time index.

    Stores {filepath: mtime} in a JSON file so we can skip unchanged files
    across service restarts. The ChunkCache handles in-memory caching;
    this handles the cross-restart case.
    """

    def __init__(self, index_path=None):
        self._path = index_path or os.path.join(
            os.environ.get("GSD_DATA_DIR", os.path.expanduser("~/.amauta/data")),
            "rlm-index.json",
        )
        self._index = {}
        self._load()

    def _load(self):
        """Load index from disk."""
        try:
            if os.path.exists(self._path):
                with open(self._path, "r") as f:
                    self._index = json.load(f)
        except (json.JSONDecodeError, OSError):
            self._index = {}

    def _save(self):
        """Persist index to disk."""
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(self._path, "w") as f:
                json.dump(self._index, f)
        except OSError as e:
            log.warning("mtime_index_save_failed error=%s", str(e))

    def is_changed(self, filepath):
        """Check if file has changed since last index."""
        try:
            current_mtime = os.stat(filepath).st_mtime
        except OSError:
            return True  # File gone or unreadable -- treat as changed
        stored_mtime = self._index.get(filepath)
        return stored_mtime is None or current_mtime != stored_mtime

    def update(self, filepath):
        """Record current mtime for a file."""
        try:
            self._index[filepath] = os.stat(filepath).st_mtime
        except OSError:
            pass

    def prune(self, existing_files):
        """Remove entries for files that no longer exist."""
        stale = [fp for fp in self._index if fp not in existing_files]
        for fp in stale:
            del self._index[fp]
        if stale:
            log.debug("mtime_index_pruned count=%d", len(stale))

    def save_if_dirty(self):
        """Persist to disk (call after batch updates)."""
        self._save()

    @property
    def size(self):
        return len(self._index)


MTIME_INDEX = MtimeIndex()


# ═══════════════════════════════════════════════════════
# Code-Aware Chunking
# ═══════════════════════════════════════════════════════

def chunk_file(filepath, max_chars=None):
    """
    Read and chunk a file by code-aware boundaries.
    Returns list of dicts: {text, start_line, end_line, label, filepath}
    """
    max_chars = max_chars or MAX_CHUNK_CHARS
    filepath = str(filepath)

    try:
        stat = os.stat(filepath)
        mtime = stat.st_mtime
    except OSError:
        return []

    # Check cache
    cached = CHUNK_CACHE.get(filepath, mtime)
    if cached is not None:
        log.debug("cache_%s path=%s", "hit", filepath)
        return cached

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return []

    if not content.strip():
        return []

    ext = Path(filepath).suffix.lower()

    if ext in {".py"}:
        chunks = _chunk_python(content, filepath, max_chars)
    elif ext in {".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs"}:
        chunks = _chunk_javascript(content, filepath, max_chars)
    elif ext in {".sql"}:
        chunks = _chunk_sql(content, filepath, max_chars)
    elif ext in MARKDOWN_EXTENSIONS:
        chunks = _chunk_markdown(content, filepath, max_chars)
    else:
        chunks = _chunk_generic(content, filepath, max_chars)

    # Cache results
    log.debug("cache_%s path=%s", "miss", filepath)
    CHUNK_CACHE.put(filepath, mtime, chunks)
    return chunks


def _make_chunk(text, start_line, end_line, label, filepath):
    """Create a chunk dict."""
    return {
        "text": text,
        "start_line": start_line,
        "end_line": end_line,
        "label": label,
        "filepath": filepath,
        "char_count": len(text),
    }


def _split_oversized(text, start_line, label, filepath, max_chars):
    """Split text that exceeds max_chars into sub-chunks."""
    if len(text) <= max_chars:
        end_line = start_line + text.count("\n")
        return [_make_chunk(text, start_line, end_line, label, filepath)]

    chunks = []
    lines = text.split("\n")
    current = []
    current_chars = 0
    current_start = start_line

    for i, line in enumerate(lines):
        line_with_nl = line + "\n"
        if current_chars + len(line_with_nl) > max_chars and current:
            chunk_text = "\n".join(current)
            end = current_start + len(current) - 1
            chunks.append(_make_chunk(chunk_text, current_start, end, f"{label} (part {len(chunks)+1})", filepath))
            current = []
            current_chars = 0
            current_start = start_line + i

        current.append(line)
        current_chars += len(line_with_nl)

    if current:
        chunk_text = "\n".join(current)
        end = current_start + len(current) - 1
        chunks.append(_make_chunk(chunk_text, current_start, end, f"{label} (part {len(chunks)+1})" if len(chunks) > 0 else label, filepath))

    return chunks


# ─── Python Chunker ──────────────────────────────────

# Patterns that start a new Python block
_PY_BLOCK_RE = re.compile(
    r"^(class\s+\w+|def\s+\w+|async\s+def\s+\w+|@\w+)",
    re.MULTILINE,
)

def _chunk_python(content, filepath, max_chars):
    """Chunk Python by class/function boundaries."""
    lines = content.split("\n")
    chunks = []
    current_lines = []
    current_label = "module-header"
    current_start = 1

    for i, line in enumerate(lines, 1):
        stripped = line.lstrip()
        # New top-level def/class (not indented or decorator)
        if (stripped.startswith(("class ", "def ", "async def ")) and
                (not line[0].isspace() or line[0] == "@")):
            # Save previous block
            if current_lines:
                text = "\n".join(current_lines)
                chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

            # Extract label
            match = re.match(r"(class|def|async\s+def)\s+(\w+)", stripped)
            current_label = f"{match.group(1)} {match.group(2)}" if match else stripped[:50]
            current_lines = [line]
            current_start = i
        elif (not line[0:1].isspace() and stripped.startswith("@") and not current_lines):
            # Decorator at module level before a function
            current_lines = [line]
            current_start = i
        else:
            current_lines.append(line)

    # Last block
    if current_lines:
        text = "\n".join(current_lines)
        chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

    return chunks


# ─── JavaScript/TypeScript Chunker ───────────────────

_JS_BLOCK_RE = re.compile(
    r"^(export\s+)?(default\s+)?(function\s+\w+|class\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|export\s+\{)",
    re.MULTILINE,
)

def _chunk_javascript(content, filepath, max_chars):
    """Chunk JS/TS by function/class/export boundaries."""
    lines = content.split("\n")
    chunks = []
    current_lines = []
    current_label = "module-header"
    current_start = 1
    brace_depth = 0

    for i, line in enumerate(lines, 1):
        stripped = line.lstrip()

        # Track brace depth for knowing when we're at top level
        for ch in line:
            if ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth = max(0, brace_depth - 1)

        # New top-level declaration
        is_top_level = not line[0:1].isspace() or brace_depth <= 1
        is_block_start = bool(_JS_BLOCK_RE.match(stripped))

        if is_top_level and is_block_start and current_lines:
            text = "\n".join(current_lines)
            chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

            # Extract label
            match = re.match(r"(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+(\w+)", stripped)
            current_label = f"{match.group(1)} {match.group(2)}" if match else stripped[:50]
            current_lines = [line]
            current_start = i
        else:
            current_lines.append(line)

    if current_lines:
        text = "\n".join(current_lines)
        chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

    return chunks


# ─── SQL Chunker ─────────────────────────────────────

_SQL_BLOCK_RE = re.compile(
    r"^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|WITH|SELECT|GRANT|REVOKE|BEGIN|COMMIT)\b",
    re.IGNORECASE | re.MULTILINE,
)

def _chunk_sql(content, filepath, max_chars):
    """Chunk SQL by statement boundaries."""
    # Split on semicolons that end statements
    statements = re.split(r";\s*\n", content)
    chunks = []
    line_offset = 1

    for stmt in statements:
        stmt = stmt.strip()
        if not stmt:
            line_offset += 1
            continue

        # Extract label from first keyword
        match = re.match(r"(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|WITH|SELECT)\s+\w*\s*(\w+)?", stmt, re.IGNORECASE)
        label = f"{match.group(0)[:60]}" if match else stmt[:50]

        chunks.extend(_split_oversized(stmt + ";", line_offset, label, filepath, max_chars))
        line_offset += stmt.count("\n") + 1

    return chunks


# ─── Markdown Chunker ────────────────────────────────

def _chunk_markdown(content, filepath, max_chars):
    """Chunk Markdown by heading boundaries."""
    lines = content.split("\n")
    chunks = []
    current_lines = []
    current_label = "frontmatter"
    current_start = 1
    in_frontmatter = False

    for i, line in enumerate(lines, 1):
        # Frontmatter handling
        if i == 1 and line.strip() == "---":
            in_frontmatter = True
            current_lines.append(line)
            continue
        if in_frontmatter:
            current_lines.append(line)
            if line.strip() == "---":
                in_frontmatter = False
            continue

        # Heading starts new chunk
        heading_match = re.match(r"^(#{1,4})\s+(.+)", line)
        if heading_match:
            if current_lines:
                text = "\n".join(current_lines)
                chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

            current_label = heading_match.group(2).strip()[:60]
            current_lines = [line]
            current_start = i
        else:
            current_lines.append(line)

    if current_lines:
        text = "\n".join(current_lines)
        chunks.extend(_split_oversized(text, current_start, current_label, filepath, max_chars))

    return chunks


# ─── Generic Chunker ─────────────────────────────────

def _chunk_generic(content, filepath, max_chars):
    """Chunk by blank-line-separated paragraphs, respecting max size."""
    paragraphs = re.split(r"\n\s*\n", content)
    chunks = []
    current = []
    current_chars = 0
    current_start = 1
    line_offset = 1

    for para in paragraphs:
        para = para.strip()
        if not para:
            line_offset += 1
            continue

        para_chars = len(para)
        if current_chars + para_chars > max_chars and current:
            text = "\n\n".join(current)
            end = current_start + text.count("\n")
            chunks.append(_make_chunk(text, current_start, end, f"block@{current_start}", filepath))
            current = []
            current_chars = 0
            current_start = line_offset

        current.append(para)
        current_chars += para_chars
        line_offset += para.count("\n") + 2  # +2 for the blank line

    if current:
        text = "\n\n".join(current)
        end = current_start + text.count("\n")
        chunks.append(_make_chunk(text, current_start, end, f"block@{current_start}", filepath))

    return chunks


# ═══════════════════════════════════════════════════════
# Relevance Scoring
# ═══════════════════════════════════════════════════════

def score_chunks(chunks, query, top_k=None):
    """
    Score chunks against a query using BM25 with label boost and position penalty.
    Returns chunks sorted by relevance score (descending).
    """
    top_k = top_k or DEFAULT_TOP_K
    if not query or not chunks:
        return chunks[:top_k]

    # Tokenize query into terms
    terms = _tokenize(query)
    if not terms:
        return chunks[:top_k]

    # Pre-tokenize all chunks once (avoids O(n*m) retokenization)
    n_docs = len(chunks)
    chunk_token_sets = [_tokenize(c["text"]) for c in chunks]
    chunk_token_lists = [_tokenize_list(c["text"]) for c in chunks]

    # BM25: compute document frequency per query term
    doc_freq = {}
    for term in terms:
        count = sum(1 for token_set in chunk_token_sets if term in token_set)
        doc_freq[term] = count

    # BM25: compute average document length (in tokens)
    doc_lengths = [len(ts) for ts in chunk_token_sets]
    avgdl = sum(doc_lengths) / max(1, len(doc_lengths))

    # Compute max end_line across all chunks (proxy for total file lines)
    max_end_line = max((c.get("end_line", 1) for c in chunks), default=1)

    scored = []
    for i, chunk in enumerate(chunks):
        score = _compute_score(chunk, terms, doc_freq, n_docs, max_end_line,
                               avgdl, doc_lengths[i], chunk_token_lists[i])
        scored.append((score, chunk))

    # Sort by score descending, then by start_line ascending for stability
    scored.sort(key=lambda x: (-x[0], x[1]["start_line"]))

    result = []
    for score, chunk in scored[:top_k]:
        chunk_copy = dict(chunk)
        chunk_copy["relevance_score"] = round(score, 3)
        result.append(chunk_copy)

    return result


def _split_identifiers(text):
    """Pre-process text to split camelCase and snake_case identifiers into words.
    getUserProfile -> get User Profile
    get_user_profile -> get user profile
    HTMLParser -> HTML Parser
    """
    # Split camelCase: insert space before uppercase letters that follow lowercase
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    # Split sequences of uppercase followed by uppercase+lowercase (e.g., HTMLParser -> HTML Parser)
    text = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', text)
    # Replace underscores with spaces
    text = text.replace('_', ' ')
    return text


def _tokenize(text):
    """Extract lowercase word tokens from text, splitting camelCase and snake_case."""
    text = _split_identifiers(text)
    return set(re.findall(r"\b[a-zA-Z]\w{2,}\b", text.lower()))


def _tokenize_list(text):
    """Extract lowercase word tokens as a list (preserves duplicates for TF counting)."""
    text = _split_identifiers(text)
    return re.findall(r"\b[a-zA-Z]\w{2,}\b", text.lower())


# BM25 parameters
BM25_K1 = 1.5   # Term frequency saturation — higher = more weight to repeated terms
BM25_B = 0.75   # Length normalization — 0 = no normalization, 1 = full normalization


def _compute_score(chunk, query_terms, doc_freq, n_docs, total_lines=1,
                   avgdl=1.0, doc_len=1, chunk_token_list=None):
    """
    Compute relevance score for a chunk using BM25.
    BM25 adds term frequency saturation and document length normalization
    over basic term matching, which improves ranking for mixed-size code chunks.
    """
    text = chunk["text"].lower()
    label = chunk.get("label", "")
    label_tokens = _tokenize(label)

    score = 0.0

    for term in query_terms:
        # Term frequency in this chunk's text (word-boundary aware via token list)
        tf = chunk_token_list.count(term) if chunk_token_list else text.count(term)
        if tf == 0 and term not in label_tokens:
            continue

        # BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        df = doc_freq.get(term, 0)
        idf = math.log((n_docs - df + 0.5) / (df + 0.5) + 1)

        # BM25 TF with length normalization:
        # (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
        dl = max(1, doc_len)
        avg = max(1.0, avgdl)
        tf_score = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avg))

        term_score = tf_score * idf

        # Label boost: 2x if term appears in the chunk label (function/class name)
        if term in label_tokens:
            term_score *= 2.0

        score += term_score

    # Position penalty: later chunks in a file score lower (-0.1 per depth).
    tl = max(1, total_lines)
    depth_ratio = min(1.0, chunk.get("start_line", 0) / tl)
    score = score * (1 - 0.1 * depth_ratio)

    return score


# ═══════════════════════════════════════════════════════
# Directory Scanner
# ═══════════════════════════════════════════════════════

def scan_directory(dir_path, extensions=None, max_files=500):
    """
    Recursively find files in a directory matching given extensions.
    Skips common build/dependency directories.
    """
    all_exts = extensions or (CODE_EXTENSIONS | MARKDOWN_EXTENSIONS | TEXT_EXTENSIONS)
    files = []
    dir_path = Path(dir_path)

    if not dir_path.is_dir():
        return files

    for root, dirs, filenames in os.walk(str(dir_path)):
        # Skip unwanted directories
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]

        for fname in filenames:
            if len(files) >= max_files:
                return files
            ext = Path(fname).suffix.lower()
            if ext in all_exts:
                files.append(os.path.join(root, fname))

    return files


# ═══════════════════════════════════════════════════════
# HTTP Server
# ═══════════════════════════════════════════════════════

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class RLMHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        if os.environ.get("GSD_DEBUG"):
            super().log_message(format, *args)

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    MAX_BODY_SIZE = 50 * 1024 * 1024  # 50 MB

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        if length > self.MAX_BODY_SIZE:
            self._send_json({"error": f"Request body too large ({length} bytes, max {self.MAX_BODY_SIZE})"}, 413)
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON body"}, 400)
            return None

    # ─── GET ─────────────────────────────────────────

    def do_GET(self):
        path = self.path.rstrip("/")

        if path == "/health":
            self._send_json({
                "status": "ok",
                "service": "rlm-service",
                "port": PORT,
                "cache_size": CHUNK_CACHE.size,
                "cache_max": CACHE_MAX_SIZE,
                "max_chunk_chars": MAX_CHUNK_CHARS,
                "pid": os.getpid(),
                "index_size": MTIME_INDEX.size,
            })
            return

        if path == "/cache/stats":
            self._send_json({
                "chunk_cache_size": CHUNK_CACHE.size,
                "chunk_cache_max": CACHE_MAX_SIZE,
                "mtime_index_size": MTIME_INDEX.size,
            })
            return

        self._send_json({"error": f"Unknown GET route: {path}"}, 404)

    # ─── POST ────────────────────────────────────────

    def do_POST(self):
        path = self.path.rstrip("/")
        body = self._read_body()
        if body is None:
            return  # Error response already sent by _read_body

        if path == "/chunk":
            self._handle_chunk(body)
        elif path == "/search":
            self._handle_search(body)
        elif path == "/query":
            self._handle_query(body)
        elif path == "/cache/clear":
            CHUNK_CACHE.clear()
            self._send_json({"ok": True, "message": "Cache cleared"})
        else:
            self._send_json({"error": f"Unknown POST route: {path}"}, 404)

    def _handle_chunk(self, body):
        """
        POST /chunk
        Body: { "filepath": "/path/to/file", "max_chars": 8000 }
        Returns: { "chunks": [...], "total": N, "filepath": "..." }
        """
        filepath = body.get("filepath")
        if not filepath:
            self._send_json({"error": "filepath required"}, 400)
            return

        if not _is_safe_path(filepath):
            self._send_json({"error": "Access denied: path is outside allowed scope"}, 403)
            return

        filepath = os.path.expanduser(filepath)
        if not os.path.isfile(filepath):
            self._send_json({"error": f"File not found: {filepath}"}, 404)
            return

        max_chars = body.get("max_chars", MAX_CHUNK_CHARS)
        chunks = chunk_file(filepath, max_chars)

        self._send_json({
            "ok": True,
            "filepath": filepath,
            "chunks": chunks,
            "total": len(chunks),
        })

    def _handle_search(self, body):
        """
        POST /search
        Body: {
            "query": "search terms",
            "paths": ["/path/to/file1", "/path/to/file2"],
            "top_k": 10,
            "max_chars": 8000
        }
        Returns: { "results": [...], "total_chunks": N, "query": "..." }
        """
        query = body.get("query")
        paths = body.get("paths", [])
        top_k = body.get("top_k", DEFAULT_TOP_K)
        max_chars = body.get("max_chars", MAX_CHUNK_CHARS)

        if not query:
            self._send_json({"error": "query required"}, 400)
            return
        if not paths:
            self._send_json({"error": "paths required"}, 400)
            return

        t0 = time.time()
        all_chunks = []
        for p in paths:
            if not _is_safe_path(p):
                continue
            p = os.path.expanduser(p)
            if os.path.isfile(p):
                all_chunks.extend(chunk_file(p, max_chars))

        results = score_chunks(all_chunks, query, top_k)
        elapsed_ms = round((time.time() - t0) * 1000, 1)

        self._send_json({
            "ok": True,
            "query": query,
            "results": results,
            "total_chunks": len(all_chunks),
            "returned": len(results),
            "elapsed_ms": elapsed_ms,
        })

    def _handle_query(self, body):
        """
        POST /query
        Body: {
            "query": "search terms",
            "directory": "/path/to/project",
            "top_k": 10,
            "max_chars": 8000,
            "extensions": [".py", ".js"],
            "max_files": 500
        }
        Returns: { "results": [...], "files_scanned": N, "total_chunks": N }
        """
        query = body.get("query")
        directory = body.get("directory")
        top_k = body.get("top_k", DEFAULT_TOP_K)
        max_chars = body.get("max_chars", MAX_CHUNK_CHARS)
        extensions = body.get("extensions")
        max_files = body.get("max_files", 500)

        if not query:
            self._send_json({"error": "query required"}, 400)
            return
        if not directory:
            self._send_json({"error": "directory required"}, 400)
            return

        log.debug("rlm_query query=%r top_k=%d", query[:50], top_k)
        if not _is_safe_path(directory):
            self._send_json({"error": "Access denied: path is outside allowed scope"}, 403)
            return
        directory = os.path.expanduser(directory)
        if not os.path.isdir(directory):
            self._send_json({"error": f"Directory not found: {directory}"}, 404)
            return

        t0 = time.time()

        # Convert extension list to set if provided
        ext_set = None
        if extensions:
            ext_set = set(extensions)

        files = scan_directory(directory, ext_set, max_files)

        # Incremental indexing: only re-chunk changed files
        existing_set = set(files)
        MTIME_INDEX.prune(existing_set)

        all_chunks = []
        changed_count = 0
        cached_count = 0
        for f in files:
            if MTIME_INDEX.is_changed(f):
                chunks = chunk_file(f, max_chars)
                MTIME_INDEX.update(f)
                changed_count += 1
            else:
                # File hasn't changed -- still need chunks from cache
                chunks = chunk_file(f, max_chars)  # ChunkCache handles the actual skip
                cached_count += 1
            all_chunks.extend(chunks)

        MTIME_INDEX.save_if_dirty()

        results = score_chunks(all_chunks, query, top_k)
        elapsed_ms = round((time.time() - t0) * 1000, 1)

        self._send_json({
            "ok": True,
            "query": query,
            "directory": directory,
            "results": results,
            "files_scanned": len(files),
            "files_changed": changed_count,
            "files_cached": cached_count,
            "total_chunks": len(all_chunks),
            "returned": len(results),
            "elapsed_ms": elapsed_ms,
            "index_size": MTIME_INDEX.size,
        })


# ═══════════════════════════════════════════════════════
# Daemon Lifecycle (same pattern as amauta-daemon.py)
# ═══════════════════════════════════════════════════════

def start_server(foreground=False):
    if not foreground:
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text().strip())
                os.kill(pid, 0)
                print(f"RLM service already running (PID {pid})")
                return
            except (ProcessLookupError, ValueError):
                PID_FILE.unlink(missing_ok=True)

    server = ThreadedHTTPServer((HOST, PORT), RLMHandler)
    PID_FILE.write_text(str(os.getpid()))

    def shutdown_handler(signum, frame):
        log.info("rlm_shutdown")
        print("\nShutting down RLM service...")
        server.shutdown()
        PID_FILE.unlink(missing_ok=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    log.info("rlm_started port=%d", PORT)
    print(f"RLM service listening on {HOST}:{PORT}")
    print(f"  Max chunk: {MAX_CHUNK_CHARS} chars")
    print(f"  Cache max: {CACHE_MAX_SIZE} entries")
    print(f"  PID file: {PID_FILE}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        PID_FILE.unlink(missing_ok=True)


def stop_server():
    if not PID_FILE.exists():
        print("RLM service not running (no PID file)")
        return
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to PID {pid}")
        PID_FILE.unlink(missing_ok=True)
    except ProcessLookupError:
        print("RLM service not running (stale PID file)")
        PID_FILE.unlink(missing_ok=True)
    except ValueError:
        print("Invalid PID file")
        PID_FILE.unlink(missing_ok=True)


def check_status():
    if not PID_FILE.exists():
        print("RLM service not running")
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)
        print(f"RLM service running (PID {pid}) on {HOST}:{PORT}")
        return True
    except (ProcessLookupError, ValueError):
        print("RLM service not running (stale PID file)")
        PID_FILE.unlink(missing_ok=True)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: rlm-service.py {start|stop|status|run}")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "start":
        if os.fork() == 0:
            os.setsid()
            start_server(foreground=False)
        else:
            print("RLM service starting in background...")
    elif cmd == "run":
        start_server(foreground=True)
    elif cmd == "stop":
        stop_server()
    elif cmd == "status":
        sys.exit(0 if check_status() else 1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
