#!/usr/bin/env python3
"""Tests for grammar_strip — Phase 22 / CAVE-02.

Verifies that strip_grammar() removes articles/filler/hedging, preserves
code blocks and formatting, and attempts >= 30% char reduction on real agent files.

DIVERGENCE NOTICE (Plan 22-01 vs Reality):
  Plan 22-01 requires len(strip_grammar(text)) / len(text) <= 0.70 for 5 agent
  files. Measurement shows these files are ~50-55% code blocks, bash snippets,
  XML tags, and YAML frontmatter (all preserved by spec). Article/filler/hedging
  words represent only ~1.5% of total characters. The 30% total-file reduction
  threshold is not achievable with the plan-specified word lists alone on these
  technical agent files. Actual ratios are ~0.98 (about 1.5-2% reduction).

  This test implements the plan's assertion faithfully. The failing tests document
  the gap between the plan's compression target and what static word-list removal
  achieves on dense technical markdown. Resolution requires either:
  (a) expanding the stripping vocabulary (Phase 22.1 scope), or
  (b) revising the CAVE-02 success metric to reflect actual achievable reduction.

  Per divergence protocol v1.1.0: divergence surfaced, not silently absorbed.

Run: pytest tests/test_grammar_strip.py -v
"""

import os
import re
import pytest

PROJECT_ROOT = os.path.join(os.path.dirname(__file__), "..")

# 5 agent files for compression ratio measurement
AGENT_FILES = [
    "agents/gsd-executor-backend.md",
    "agents/gsd-checker.md",
    "agents/gsd-researcher.md",
    "agents/gsd-executor-general.md",
    "agents/gsd-debugger.md",
]


def _abs(rel_path: str) -> str:
    """Resolve relative path against project root."""
    return os.path.join(PROJECT_ROOT, rel_path)


# ── TestArticleRemoval ───────────────────────────────────────────────────────

class TestArticleRemoval:
    """Verify articles are removed from plain text."""

    def test_removes_the(self):
        """'the' is removed at word boundaries."""
        from services.grammar_strip import strip_grammar
        result = strip_grammar("the executor validates the input")
        words = result.lower().split()
        assert "the" not in words, f"'the' found in result: {result!r}"
        assert "executor" in result.lower()
        assert "input" in result.lower()

    def test_removes_a_an(self):
        """'a' and 'an' are removed at word boundaries."""
        from services.grammar_strip import strip_grammar
        result = strip_grammar("a simple an easy solution")
        words = result.lower().split()
        assert "a" not in words, f"'a' found in: {result!r}"
        assert "an" not in words, f"'an' found in: {result!r}"
        assert "simple" in result.lower()
        assert "easy" in result.lower()

    def test_preserves_the_in_variable_names(self):
        """'the' inside variable names like 'the_variable' is not stripped."""
        from services.grammar_strip import strip_grammar
        # Note: word boundary means "the" inside "the_variable" is preserved
        result = strip_grammar("use the_variable to store the result")
        assert "the_variable" in result, f"'the_variable' was stripped: {result!r}"


# ── TestFillerRemoval ────────────────────────────────────────────────────────

class TestFillerRemoval:
    """Verify filler words are removed from plain text."""

    def test_removes_just_simply_basically(self):
        """Common filler words are removed from prose."""
        from services.grammar_strip import strip_grammar
        text = "just simply basically call the function"
        result = strip_grammar(text)
        words = result.lower().split()
        assert "just" not in words, f"'just' in: {result!r}"
        assert "simply" not in words, f"'simply' in: {result!r}"
        assert "basically" not in words, f"'basically' in: {result!r}"
        assert "call" in result.lower()
        assert "function" in result.lower()

    def test_preserves_filler_in_code_blocks(self):
        """Filler words inside triple-backtick fences are preserved verbatim."""
        from services.grammar_strip import strip_grammar
        text = "```python\njust_var = simply_call(basically)\n```"
        result = strip_grammar(text)
        assert "just_var" in result, f"'just_var' stripped from code block: {result!r}"
        assert "simply_call" in result, f"'simply_call' stripped from code block: {result!r}"
        assert "basically" in result, f"'basically' stripped from code block: {result!r}"


# ── TestHedgingRemoval ───────────────────────────────────────────────────────

class TestHedgingRemoval:
    """Verify hedging phrases are removed."""

    def test_removes_multi_word_hedging(self):
        """Multi-word hedging phrase 'might want to' is removed."""
        from services.grammar_strip import strip_grammar
        text = "you might want to consider this approach"
        result = strip_grammar(text)
        assert "might want to" not in result.lower(), f"hedging phrase found in: {result!r}"

    def test_removes_could_potentially(self):
        """'could potentially' is removed, leaving surrounding words intact."""
        from services.grammar_strip import strip_grammar
        text = "this could potentially break the system"
        result = strip_grammar(text)
        assert "could potentially" not in result.lower(), f"hedging found in: {result!r}"
        assert "break" in result.lower(), f"'break' missing from: {result!r}"
        assert "system" in result.lower(), f"'system' missing from: {result!r}"


# ── TestPreservation ─────────────────────────────────────────────────────────

class TestPreservation:
    """Verify preserved zones are not stripped."""

    def test_preserves_code_blocks(self):
        """Content inside triple-backtick fences is unchanged."""
        from services.grammar_strip import strip_grammar
        code_content = "the_var = a + an + the\njust_func(basically=True)"
        text = f"```python\n{code_content}\n```"
        result = strip_grammar(text)
        assert "the_var" in result, f"code block variable stripped: {result!r}"
        assert "just_func" in result, f"code block function stripped: {result!r}"

    def test_preserves_yaml_frontmatter_keys(self):
        """YAML keys (like 'name:', 'description:') are preserved intact."""
        from services.grammar_strip import strip_grammar
        text = "---\nname: gsd-executor-backend\ndescription: the backend agent\n---\n\nSome text."
        result = strip_grammar(text)
        assert "name:" in result, f"YAML key 'name:' stripped: {result!r}"
        assert "description:" in result, f"YAML key 'description:' stripped: {result!r}"
        assert "gsd-executor-backend" in result, f"YAML value stripped: {result!r}"

    def test_preserves_urls(self):
        """URLs are not modified by grammar stripping."""
        from services.grammar_strip import strip_grammar
        url = "https://example.com/the/path/to/a/resource"
        text = f"See the documentation at {url} for details."
        result = strip_grammar(text)
        assert url in result, f"URL was modified. Got: {result!r}"

    def test_preserves_file_paths(self):
        """File paths starting with ./ are preserved."""
        from services.grammar_strip import strip_grammar
        path = "./services/the_module.py"
        text = f"See {path} for the implementation."
        result = strip_grammar(text)
        assert path in result, f"File path was stripped. Got: {result!r}"

    def test_output_is_valid_markdown(self):
        """Headings, lists, links, and bold formatting survive stripping."""
        from services.grammar_strip import strip_grammar
        text = (
            "# The Main Heading\n\n"
            "## A Sub-Section\n\n"
            "- **Bold item**: the description\n"
            "- [Link text](https://example.com)\n"
            "- *italic* and _underline_\n"
        )
        result = strip_grammar(text)
        # Headings survive (# markers)
        assert "# " in result, f"Headings stripped: {result!r}"
        # Bold formatting survives
        assert "**" in result, f"Bold markers stripped: {result!r}"
        # Links survive
        assert "(https://example.com)" in result, f"Link stripped: {result!r}"
        # List markers survive
        assert "- " in result, f"List markers stripped: {result!r}"


# ── TestCompressionRatio ─────────────────────────────────────────────────────

class TestCompressionRatio:
    """CAVE-02 compression ratio measurement on real agent files.

    NOTE: The plan specifies len(strip_grammar(text)) / len(text) <= 0.70
    (i.e., >= 30% char reduction). As documented in the module docstring,
    these agent files are ~50-55% code blocks, XML, and YAML (all preserved)
    with articles/fillers representing only ~1.5% of total chars. This test
    faithfully implements the plan assertion and will fail to document the
    divergence between plan expectation and actual achievable compression.

    Resolution path: either expand vocabulary (Phase 22.1) or revise the
    CAVE-02 metric to reflect what static word-list removal achieves.
    """

    @pytest.mark.parametrize("filepath", AGENT_FILES)
    def test_agent_file_reduction_ge_30_percent(self, filepath):
        """For each agent file, stripped length / original length <= 0.70.

        DIVERGENCE: This test is expected to FAIL with the current implementation.
        Actual ratios are ~0.985 (about 1.5% reduction) vs required 0.70 (30% reduction).
        The plan's 30% threshold is not achievable with article/filler/hedging removal
        alone on dense technical markdown agent files.
        """
        from services.grammar_strip import strip_grammar
        abs_path = _abs(filepath)

        with open(abs_path, "r", encoding="utf-8") as f:
            text = f.read()

        result = strip_grammar(text)
        ratio = len(result) / len(text)
        print(
            f"\n  {os.path.basename(filepath)}: "
            f"{len(text)} -> {len(result)} chars, "
            f"ratio={ratio:.3f} ({(1 - ratio) * 100:.1f}% reduction)"
        )

        assert ratio <= 0.70, (
            f"CAVE-02 DIVERGENCE: {filepath!r}\n"
            f"  Original: {len(text)} chars\n"
            f"  Stripped: {len(result)} chars\n"
            f"  Ratio: {ratio:.3f} (required <= 0.70)\n"
            f"  Actual reduction: {(1 - ratio) * 100:.1f}% (required >= 30%)\n"
            f"  Root cause: ~50-55% of file is code blocks, XML, YAML (preserved by spec).\n"
            f"  Article/filler/hedging = ~1.5% of chars in dense technical markdown.\n"
            f"  Resolution: expand vocabulary or revise CAVE-02 metric (Phase 22.1 scope)."
        )
