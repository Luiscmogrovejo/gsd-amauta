"""INFRA-04: tree-sitter Python package verification tests."""
import pytest


def test_infra04_tree_sitter_importable():
    """tree-sitter base package imports without error."""
    import tree_sitter
    assert hasattr(tree_sitter, 'Language') or hasattr(tree_sitter, 'Parser')


def test_infra04_tree_sitter_python_grammar_importable():
    """tree-sitter-python grammar imports without error."""
    import tree_sitter_python
    assert tree_sitter_python is not None


def test_infra04_tree_sitter_javascript_grammar_importable():
    """tree-sitter-javascript grammar imports without error."""
    import tree_sitter_javascript
    assert tree_sitter_javascript is not None


def test_infra04_tree_sitter_typescript_grammar_importable():
    """tree-sitter-typescript grammar imports without error."""
    import tree_sitter_typescript
    assert tree_sitter_typescript is not None


def test_infra04_python_parse_produces_ast():
    """Parsing a Python snippet produces an AST with node count > 0."""
    from tree_sitter import Language, Parser
    import tree_sitter_python as tspython
    try:
        # New API (tree-sitter >= 0.22)
        PY_LANGUAGE = Language(tspython.language())
    except TypeError:
        pytest.skip("tree-sitter < 0.22 detected — use newer API")
    parser = Parser()
    parser.language = PY_LANGUAGE
    tree = parser.parse(b"def foo(x):\n    return x + 1\n")
    assert tree.root_node is not None
    assert tree.root_node.named_child_count > 0


def test_infra04_javascript_parse_produces_ast():
    """Parsing a JavaScript snippet produces an AST with node count > 0."""
    from tree_sitter import Language, Parser
    import tree_sitter_javascript as tsjavascript
    try:
        JS_LANGUAGE = Language(tsjavascript.language())
    except TypeError:
        pytest.skip("tree-sitter < 0.22 detected")
    parser = Parser()
    parser.language = JS_LANGUAGE
    tree = parser.parse(b"const x = 1 + 2;")
    assert tree.root_node.named_child_count > 0


def test_infra01_docker_compose_uses_valkey():
    """docker-compose.yml references valkey/valkey:8-alpine (not redis:7)."""
    import pathlib
    compose = pathlib.Path('docker/docker-compose.yml').read_text()
    assert 'valkey/valkey:8-alpine' in compose, "Must use valkey/valkey:8-alpine"
    assert 'redis:7' not in compose, "Must not reference redis:7"
    assert 'BSD 3-Clause' in compose, "Must have BSD 3-Clause license comment"
