"""
Phase 69 ASTG-01/ASTG-02: mobile-stack AST chunker tests (Kotlin/Swift/Go/Rust/Java).

Verifies each of the 5 newly wired tree-sitter grammars chunks at real AST
symbol boundaries (no paragraph-splitting fallback), that the ingestion gate
is single-sourced from ast_chunker (no drift-prone duplicate set), and that
the Phase 27 python/javascript baseline is unaffected by the dict-dispatch
refactor of _extract_top_level_symbols.

Grammars are declared runtime dependencies -- imported HARD via
services.ast_chunker's chunk_file_ast(). No conditional-skip-on-missing-dep
pytest marker is used here: a silent skip would be exactly the
networkx-class degradation Phase 69 exists to prevent.

Run: pytest tests/test_69_ast_mobile.py -v
"""
import os
import sys

import pytest

# Ensure project root is on path so 'services.ast_chunker' resolves
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.ast_chunker import chunk_file_ast, is_code_file  # noqa: E402

REQUIRED_KEYS = {
    'file_path', 'symbol_name', 'symbol_type', 'start_line', 'end_line',
    'content', 'dependencies', 'dependents',
    'text', 'label', 'filepath', 'char_count',
}


def _assert_schema(chunk):
    missing = REQUIRED_KEYS - set(chunk.keys())
    assert not missing, f"Chunk {chunk.get('symbol_name')} missing keys: {missing}"
    assert isinstance(chunk['start_line'], int)
    assert isinstance(chunk['end_line'], int)
    assert isinstance(chunk['dependencies'], list)
    assert isinstance(chunk['dependents'], list)
    assert chunk['char_count'] == len(chunk['content'])
    assert chunk['symbol_type'] in ('function', 'class', 'method', 'module', 'legacy')


def _by_name(chunks, name):
    return next((c for c in chunks if c['symbol_name'] == name), None)


# ---------------------------------------------------------------------------
# 1. Per-language extraction (free function + class-like type + one method)
# ---------------------------------------------------------------------------

KOTLIN_SRC = """package com.example

class Frobber {
    fun frobMethod(): Int {
        return 7
    }
}

fun frobKt(): Int = 7
"""


def test_kotlin_extraction(tmp_path):
    f = tmp_path / "sample.kt"
    f.write_text(KOTLIN_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frobKt')
    assert fn is not None and fn['symbol_type'] == 'function'
    assert fn['start_line'] == KOTLIN_SRC.splitlines().index('fun frobKt(): Int = 7') + 1

    cls = _by_name(chunks, 'Frobber')
    assert cls is not None and cls['symbol_type'] == 'class'

    method = _by_name(chunks, 'Frobber.frobMethod')
    assert method is not None and method['symbol_type'] == 'method'


SWIFT_SRC = """class Frobber {
    func frobMethod() -> Int {
        return 7
    }
}

func frobSwift() -> Int {
    return 7
}
"""


def test_swift_extraction(tmp_path):
    f = tmp_path / "sample.swift"
    f.write_text(SWIFT_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frobSwift')
    assert fn is not None and fn['symbol_type'] == 'function'
    assert fn['start_line'] == SWIFT_SRC.splitlines().index('func frobSwift() -> Int {') + 1

    cls = _by_name(chunks, 'Frobber')
    assert cls is not None and cls['symbol_type'] == 'class'

    method = _by_name(chunks, 'Frobber.frobMethod')
    assert method is not None and method['symbol_type'] == 'method'


GO_SRC = """package main

func frobGo() int {
    return 7
}

type Frobber struct {
    X int
}

func (f Frobber) FrobMethod() int {
    return f.X
}
"""


def test_go_extraction(tmp_path):
    """
    Go substitute (per plan): methods are top-level (no class-body
    recursion) -- a method_declaration with a receiver is extracted as its
    own chunk named just the method identifier, not Type.method.
    """
    f = tmp_path / "sample.go"
    f.write_text(GO_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frobGo')
    assert fn is not None and fn['symbol_type'] == 'function'
    assert fn['start_line'] == GO_SRC.splitlines().index('func frobGo() int {') + 1

    cls = _by_name(chunks, 'Frobber')
    assert cls is not None and cls['symbol_type'] == 'class'

    method = _by_name(chunks, 'FrobMethod')
    assert method is not None and method['symbol_type'] == 'method'


RUST_SRC = """fn frob_rust() -> i32 {
    7
}

struct Frobber {
    x: i32,
}

impl Frobber {
    fn frob_method(&self) -> i32 {
        self.x
    }
}
"""


def test_rust_extraction(tmp_path):
    f = tmp_path / "sample.rs"
    f.write_text(RUST_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frob_rust')
    assert fn is not None and fn['symbol_type'] == 'function'
    assert fn['start_line'] == RUST_SRC.splitlines().index('fn frob_rust() -> i32 {') + 1

    # struct_item AND impl_item both map to symbol_type "class" -- two
    # legitimate top-level "Frobber" chunks (struct definition + impl block).
    class_chunks = [c for c in chunks if c['symbol_name'] == 'Frobber' and c['symbol_type'] == 'class']
    assert len(class_chunks) >= 1

    method = _by_name(chunks, 'Frobber.frob_method')
    assert method is not None and method['symbol_type'] == 'method'


JAVA_SRC = """public class Frobber {
    public int frobMethod() {
        return 7;
    }
}

interface Frobbable {
    int ifaceMethod();
}
"""


def test_java_extraction(tmp_path):
    """
    Java substitute (Claude's discretion, mirroring the Go substitute
    precedent): Java has no top-level free-function AST node -- every
    method_declaration is nested inside a class/interface body (verified
    live; _JAVA_SYMBOL_TYPES has no bare top-level function node type). In
    place of "one named free function", this fixture asserts a second
    top-level class-like type (an interface) alongside the class+method.
    """
    f = tmp_path / "sample.java"
    f.write_text(JAVA_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    cls = _by_name(chunks, 'Frobber')
    assert cls is not None and cls['symbol_type'] == 'class'
    assert cls['start_line'] == JAVA_SRC.splitlines().index('public class Frobber {') + 1

    method = _by_name(chunks, 'Frobber.frobMethod')
    assert method is not None and method['symbol_type'] == 'method'

    iface = _by_name(chunks, 'Frobbable')
    assert iface is not None and iface['symbol_type'] == 'class'


# ---------------------------------------------------------------------------
# 2. Extension routing
# ---------------------------------------------------------------------------

def test_is_code_file_mobile_extensions():
    for ext in ('.kt', '.kts', '.swift', '.go', '.rs', '.java'):
        assert is_code_file('sample' + ext) is True, f"{ext} should be AST-handled"


def test_is_code_file_still_excludes_non_code():
    for ext in ('.md', '.rb', '.c'):
        assert is_code_file('sample' + ext) is False, f"{ext} should NOT be AST-handled"


# ---------------------------------------------------------------------------
# 3. Single-source coherence (rlm_ingestion <-> ast_chunker)
# ---------------------------------------------------------------------------

def test_rlm_ingestion_ast_extensions_single_sourced():
    from services.rlm_ingestion import AST_EXTENSIONS
    from services.ast_chunker import AST_CODE_EXTENSIONS
    assert AST_EXTENSIONS is AST_CODE_EXTENSIONS
    assert '.kt' in AST_EXTENSIONS
    assert '.swift' in AST_EXTENSIONS
    assert '.go' in AST_EXTENSIONS
    assert '.rs' in AST_EXTENSIONS
    assert '.java' in AST_EXTENSIONS


# ---------------------------------------------------------------------------
# 4. Regression: python/javascript dict-dispatch refactor unaffected
# ---------------------------------------------------------------------------

PY_SRC = """class Frobber:
    def frob_method(self):
        return 7


def frob_py():
    return 7
"""


def test_python_regression(tmp_path):
    f = tmp_path / "sample.py"
    f.write_text(PY_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frob_py')
    assert fn is not None and fn['symbol_type'] == 'function'

    cls = _by_name(chunks, 'Frobber')
    assert cls is not None and cls['symbol_type'] == 'class'

    method = _by_name(chunks, 'Frobber.frob_method')
    assert method is not None and method['symbol_type'] == 'method'


JS_SRC = """function frobJs() {
    return 7;
}
"""


def test_javascript_regression(tmp_path):
    f = tmp_path / "sample.js"
    f.write_text(JS_SRC)
    chunks = chunk_file_ast(str(f))
    for c in chunks:
        _assert_schema(c)

    fn = _by_name(chunks, 'frobJs')
    assert fn is not None and fn['symbol_type'] == 'function'


# ---------------------------------------------------------------------------
# 5. TK-1733 guard: rlm-service module cache untouched
# ---------------------------------------------------------------------------

def test_tk1733_cache_still_present():
    import services.ast_chunker as ast_chunker_mod
    assert hasattr(ast_chunker_mod, '_get_rlm_service_module')
    assert hasattr(ast_chunker_mod, '_RLM_SERVICE_MOD')
