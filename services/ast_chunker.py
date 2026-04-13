#!/usr/bin/env python3
"""
AST-aware code chunker for GSD-Amauta RLM -- Phase 27 / RLM-01.

Uses tree-sitter to extract complete functions, classes, and methods as chunks.
Each chunk boundary is an AST node boundary -- no partial function definitions.

Supported languages: Python, JavaScript, TypeScript, CJS
  (all use tree-sitter grammars confirmed present in Phase 26).
Fallback: Non-code files use legacy_chunker (fixed-char split from rlm-service.py).

Metadata schema per chunk:
  {file_path, symbol_name, symbol_type, start_line, end_line,
   content, dependencies, dependents, text, label, filepath, char_count}
"""

import logging
import os
from pathlib import Path

log = logging.getLogger("amauta.ast_chunker")

# Language targets supported by tree-sitter AST walker
AST_CODE_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".cjs", ".mjs"}

# Node types to extract as top-level symbols per language
_PY_SYMBOL_TYPES = {
    "function_definition",
    "async_function_definition",
    "class_definition",
    "decorated_definition",
}
_JS_SYMBOL_TYPES = {
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "method_definition",
    "arrow_function",
    "export_statement",
    "lexical_declaration",
}


def is_code_file(filepath: str) -> bool:
    """Return True if the file should be processed by tree-sitter AST walker."""
    ext = Path(filepath).suffix.lower()
    return ext in AST_CODE_EXTENSIONS


def _load_parser(ext: str):
    """
    Load and return a (parser, language_name) tuple for the given file extension.
    Uses tree-sitter 0.23.x API (Parser takes Language as constructor arg).
    Returns (None, None) if the grammar cannot be loaded.
    """
    from tree_sitter import Language, Parser

    ext = ext.lower()
    try:
        if ext == ".py":
            import tree_sitter_python as ts_lang
            language = Language(ts_lang.language())
            lang_name = "python"
        elif ext in {".js", ".cjs", ".mjs", ".jsx"}:
            import tree_sitter_javascript as ts_lang
            language = Language(ts_lang.language())
            lang_name = "javascript"
        elif ext in {".ts"}:
            import tree_sitter_typescript as ts_lang
            language = Language(ts_lang.language_typescript())
            lang_name = "typescript"
        elif ext == ".tsx":
            import tree_sitter_typescript as ts_lang
            language = Language(ts_lang.language_tsx())
            lang_name = "typescript"
        else:
            return None, None
    except ImportError as e:
        log.warning("ast_chunker_import_failed ext=%s error=%s", ext, str(e))
        return None, None
    except Exception as e:
        log.warning("ast_chunker_language_init_failed ext=%s error=%s", ext, str(e))
        return None, None

    try:
        parser = Parser(language)
    except Exception as e:
        log.warning("ast_chunker_parser_init_failed ext=%s error=%s", ext, str(e))
        return None, None

    return parser, lang_name


def _extract_symbol_name(node, source_bytes: bytes) -> str:
    """
    Extract the symbol name from an AST node.
    Looks for an 'identifier' or 'name' child node.
    Falls back to a position-based placeholder for anonymous nodes.
    """
    for child in node.children:
        if child.type in ("identifier", "name"):
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
    # Arrow functions and anonymous expressions: use position
    return f"<{node.type}@L{node.start_point[0] + 1}>"


def _extract_dependencies(node, source_bytes: bytes, lang: str) -> list:
    """
    Extract dependency names (imports and function calls) from a node's subtree.
    Returns a deduplicated list of at most 20 dependency strings.
    """
    deps = []

    def walk(n):
        if lang == "python":
            if n.type == "import_from_statement":
                for child in n.children:
                    if child.type == "dotted_name":
                        deps.append(
                            source_bytes[child.start_byte:child.end_byte]
                            .decode("utf-8", errors="replace")
                        )
            elif n.type == "call":
                fn = n.child_by_field_name("function")
                if fn:
                    deps.append(
                        source_bytes[fn.start_byte:fn.end_byte]
                        .decode("utf-8", errors="replace")[:64]
                    )
        elif lang in ("javascript", "typescript"):
            if n.type == "import_statement":
                src = n.child_by_field_name("source")
                if src:
                    deps.append(
                        source_bytes[src.start_byte:src.end_byte]
                        .decode("utf-8", errors="replace")
                        .strip("'\"")
                    )
            elif n.type == "call_expression":
                fn = n.child_by_field_name("function")
                if fn:
                    deps.append(
                        source_bytes[fn.start_byte:fn.end_byte]
                        .decode("utf-8", errors="replace")[:64]
                    )
        for child in n.children:
            walk(child)

    walk(node)

    # Deduplicate while preserving order, limit to 20
    seen = set()
    result = []
    for d in deps:
        if d and d not in seen and len(result) < 20:
            seen.add(d)
            result.append(d)
    return result


def _extract_top_level_symbols(root_node, source_bytes: bytes, lang: str, filepath: str) -> list:
    """
    Walk the AST root and extract top-level function/class/method nodes as chunks.
    Recurses into class bodies to capture methods as separate chunks.

    Each chunk is a complete AST-node-bounded symbol -- no partial definitions.
    """
    chunks = []
    symbol_types = _PY_SYMBOL_TYPES if lang == "python" else _JS_SYMBOL_TYPES

    def walk_top(node, class_name=None):
        if node.type in symbol_types:
            name = _extract_symbol_name(node, source_bytes)

            # For Python decorated_definition, unwrap to the inner function/class
            inner_node = node
            if node.type == "decorated_definition":
                for child in node.children:
                    if child.type in ("function_definition", "async_function_definition", "class_definition"):
                        inner_node = child
                        name = _extract_symbol_name(inner_node, source_bytes)
                        break

            if class_name:
                full_name = f"{class_name}.{name}"
                sym_type = "method"
            else:
                if "class" in inner_node.type:
                    sym_type = "class"
                    full_name = name
                else:
                    sym_type = "function"
                    full_name = name

            content = source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
            start_line = node.start_point[0] + 1  # 1-indexed
            end_line = node.end_point[0] + 1

            deps = _extract_dependencies(node, source_bytes, lang)

            chunk = {
                "file_path": filepath,
                "symbol_name": full_name,
                "symbol_type": sym_type,
                "start_line": start_line,
                "end_line": end_line,
                "content": content,
                "dependencies": deps,
                "dependents": [],
                # rlm-service.py compatibility fields
                "text": content,
                "label": full_name,
                "filepath": filepath,
                "char_count": len(content),
            }
            chunks.append(chunk)

            # Recurse into class bodies to find methods as separate chunks
            next_class = full_name if "class" in inner_node.type else class_name
            for child in inner_node.children:
                if child.type in ("block", "class_body", "statement_block"):
                    for grandchild in child.children:
                        walk_top(grandchild, class_name=next_class)

        elif node.type in ("module", "program", "source_file"):
            # Only recurse at module/program level
            for child in node.children:
                walk_top(child)

    walk_top(root_node)
    return chunks


def chunk_file_ast(filepath: str) -> list:
    """
    Parse a code file with tree-sitter and extract chunks at function/class/method boundaries.

    Returns a list of chunk dicts. Each chunk represents one complete symbol.

    Returns empty list if:
      - File is not a code file (use legacy_chunker instead)
      - tree-sitter parse fails (caller should fall back to legacy_chunker)
      - File is empty

    The caller should check is_code_file() first, then fall back to legacy_chunker()
    if this returns an empty list.
    """
    filepath = str(os.path.abspath(filepath))
    ext = Path(filepath).suffix.lower()

    if not is_code_file(filepath):
        return []

    try:
        with open(filepath, "rb") as f:
            source_bytes = f.read()
    except OSError as e:
        log.warning("ast_chunker_read_failed path=%s error=%s", filepath, str(e))
        return []

    if not source_bytes.strip():
        return []

    parser, lang = _load_parser(ext)
    if parser is None:
        log.warning("ast_chunker_no_parser ext=%s path=%s", ext, filepath)
        return []

    try:
        tree = parser.parse(source_bytes)
    except Exception as e:
        log.warning("ast_chunker_parse_failed path=%s error=%s", filepath, str(e))
        return []

    if tree.root_node.has_error:
        log.debug("ast_chunker_parse_errors path=%s (continuing with partial AST)", filepath)
        # Continue -- partial AST may still yield useful chunks

    chunks = _extract_top_level_symbols(tree.root_node, source_bytes, lang, filepath)

    if not chunks:
        log.debug("ast_chunker_no_symbols path=%s lang=%s", filepath, lang)

    log.debug("ast_chunker_done path=%s lang=%s chunks=%d", filepath, lang, len(chunks))
    return chunks


def legacy_chunker(filepath: str, max_chars: int = 4000) -> list:
    """
    Fall back to rlm-service.py's fixed-char chunker for non-code files
    (Markdown, SQL, YAML, JSON, shell) or when tree-sitter parse yields no symbols.

    Imports chunk_file from rlm-service.py to avoid code duplication.
    Non-code files get BM25 indexing only -- no embeddings, no dependency graph edges.
    """
    try:
        import importlib.util
        rlm_path = os.path.join(os.path.dirname(__file__), "rlm-service.py")
        spec = importlib.util.spec_from_file_location("rlm_service", rlm_path)
        rlm_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rlm_mod)
        return rlm_mod.chunk_file(filepath, max_chars)
    except Exception as e:
        log.warning("legacy_chunker_fallback_failed path=%s error=%s", filepath, str(e))
        return []
