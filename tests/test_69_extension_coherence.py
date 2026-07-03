#!/usr/bin/env python3
"""Phase 69 / ASTG-03 — CODE_EXTENSIONS advertising coherence.

Closes audit RLM-M7's advertising gap: services/rlm-service.py's
CODE_EXTENSIONS advertises extensions as code-aware even though several are
only heuristically chunked (paragraph/fixed-char, no AST grammar). This
suite locks the invariant structurally (unit scope -- no daemon, no PG):

1. AST_CODE_EXTENSIONS (services/ast_chunker.py) is a subset of CODE_EXTENSIONS
   (services/rlm-service.py) -- every AST-handled extension is advertised.
2. The six Phase 69 mobile-stack extensions land in BOTH sets.
3. services.rlm_ingestion.AST_EXTENSIONS == services.ast_chunker.AST_CODE_EXTENSIONS
   (single-source held -- rlm_ingestion imports it directly, never redefines).
4. The rlm-service.py SOURCE TEXT documents every non-AST advertised
   extension under the exact "HEURISTIC-ONLY" marker string -- the
   documented-heuristic list cannot silently drift from the computed one.
5. MARKDOWN_EXTENSIONS / TEXT_EXTENSIONS are pinned to their HEAD literals --
   guards against accidental scope creep from the CODE_EXTENSIONS comment
   restructure.

Run: python3 -m pytest tests/test_69_extension_coherence.py -q
"""
import importlib.util
import os

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")

import services.ast_chunker as ast_chunker  # noqa: E402
import services.rlm_ingestion as rlm_ingestion  # noqa: E402

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
_RLM_SERVICE_PATH = os.path.join(_REPO_ROOT, "services", "rlm-service.py")

_HEURISTIC_MARKER = "HEURISTIC-ONLY (paragraph/fixed-char chunking, no AST grammar):"

_EXPECTED_MOBILE_STACK = {".kt", ".kts", ".swift", ".go", ".rs", ".java"}

# Pinned HEAD literals (pre-existing, unrelated to the CODE_EXTENSIONS restructure).
_EXPECTED_MARKDOWN_EXTENSIONS = {".md", ".mdx", ".markdown"}
_EXPECTED_TEXT_EXTENSIONS = {
    ".txt", ".log", ".csv", ".env", ".toml", ".yaml", ".yml", ".json", ".xml",
}


def _load_rlm_service_module():
    """Load rlm-service.py via importlib (hyphenated filename) -- follows the
    loading pattern used by tests/test_65_query_router.py."""
    spec = importlib.util.spec_from_file_location(
        "rlm_service_69_coherence", _RLM_SERVICE_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_rlm_service_source():
    with open(_RLM_SERVICE_PATH, "r") as f:
        return f.read()


class TestAstExtensionsSubsetOfCodeExtensions:
    def test_ast_code_extensions_is_subset_of_code_extensions(self):
        rlm_mod = _load_rlm_service_module()
        assert ast_chunker.AST_CODE_EXTENSIONS.issubset(rlm_mod.CODE_EXTENSIONS), (
            f"AST_CODE_EXTENSIONS not fully advertised in CODE_EXTENSIONS: "
            f"missing={ast_chunker.AST_CODE_EXTENSIONS - rlm_mod.CODE_EXTENSIONS}"
        )


class TestMobileStackExtensionsInBothSets:
    def test_mobile_stack_extensions_in_ast_and_code_extensions(self):
        rlm_mod = _load_rlm_service_module()
        for ext in _EXPECTED_MOBILE_STACK:
            assert ext in ast_chunker.AST_CODE_EXTENSIONS, (
                f"{ext} missing from ast_chunker.AST_CODE_EXTENSIONS"
            )
            assert ext in rlm_mod.CODE_EXTENSIONS, (
                f"{ext} missing from rlm_service.CODE_EXTENSIONS"
            )


class TestSingleSourceAstExtensionsHeld:
    def test_rlm_ingestion_ast_extensions_matches_ast_chunker(self):
        assert rlm_ingestion.AST_EXTENSIONS == ast_chunker.AST_CODE_EXTENSIONS, (
            "services.rlm_ingestion.AST_EXTENSIONS drifted from "
            "services.ast_chunker.AST_CODE_EXTENSIONS -- single-source violated"
        )


class TestHeuristicMarkerDocumentsNonAstExtensions:
    def test_heuristic_marker_present_exactly_once(self):
        source = _read_rlm_service_source()
        assert source.count(_HEURISTIC_MARKER) == 1, (
            f"expected the heuristic marker exactly once, found "
            f"{source.count(_HEURISTIC_MARKER)}"
        )

    def test_every_non_ast_advertised_extension_documented_after_marker(self):
        rlm_mod = _load_rlm_service_module()
        source = _read_rlm_service_source()
        marker_index = source.index(_HEURISTIC_MARKER)

        # Isolate the CODE_EXTENSIONS set-literal region so the "after marker"
        # check cannot accidentally match an unrelated extension mention
        # elsewhere in the file.
        block_start = source.index("CODE_EXTENSIONS = {")
        block_end = source.index("}", marker_index) + 1
        assert block_start < marker_index < block_end, (
            "heuristic marker is not inside the CODE_EXTENSIONS set literal"
        )

        ast_region = source[block_start:marker_index]
        heuristic_region = source[marker_index:block_end]

        non_ast_extensions = rlm_mod.CODE_EXTENSIONS - ast_chunker.AST_CODE_EXTENSIONS
        assert non_ast_extensions, "expected at least one heuristic-only extension"

        for ext in non_ast_extensions:
            assert f'"{ext}"' in heuristic_region, (
                f"{ext} is advertised as code-aware but not documented after "
                f"the HEURISTIC-ONLY marker: {heuristic_region!r}"
            )
            assert f'"{ext}"' not in ast_region, (
                f"{ext} appears in the AST-handled region but is not in "
                f"AST_CODE_EXTENSIONS -- membership/documentation drift"
            )

        for ext in ast_chunker.AST_CODE_EXTENSIONS:
            assert f'"{ext}"' in ast_region, (
                f"{ext} is AST-handled but not documented in the AST region "
                f"of CODE_EXTENSIONS: {ast_region!r}"
            )


class TestMarkdownAndTextExtensionsUnchanged:
    def test_markdown_extensions_pinned(self):
        rlm_mod = _load_rlm_service_module()
        assert rlm_mod.MARKDOWN_EXTENSIONS == _EXPECTED_MARKDOWN_EXTENSIONS, (
            f"MARKDOWN_EXTENSIONS drifted: {rlm_mod.MARKDOWN_EXTENSIONS}"
        )

    def test_text_extensions_pinned(self):
        rlm_mod = _load_rlm_service_module()
        assert rlm_mod.TEXT_EXTENSIONS == _EXPECTED_TEXT_EXTENSIONS, (
            f"TEXT_EXTENSIONS drifted: {rlm_mod.TEXT_EXTENSIONS}"
        )


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
