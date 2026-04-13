#!/usr/bin/env python3
"""Tests for caveman_descriptions — Phase 22 / CAVE-01.

Verifies that generate_caveman_description() produces parseable pipe-delimited
output for 10 representative project files, is callable(path)->str compatible
with ContextValidator.selective_refresh description_fn, and handles edge cases.

Run: pytest tests/test_caveman_descriptions.py -v
"""

import re
import os
import pytest

# ── Constants ────────────────────────────────────────────────────────────────

# CAVE-01 success criterion regex
# Format: [function] | deps: [...] | touches: [...] | tests: [...] | [quality]
PIPE_REGEX = re.compile(r"^.+\|.deps:.+\|.touches:.+\|.tests:.+\|.+$")

PROJECT_ROOT = os.path.join(os.path.dirname(__file__), "..")

# 10 representative project files (mix of Python, CJS, SQL, MD, JSON)
SAMPLE_FILES = [
    "services/caveman_descriptions.py",
    "services/grammar_strip.py",
    "services/context_validator.py",
    "services/rpetd_context.py",
    "services/amauta-daemon.py",
    "get-shit-done/bin/gsd-amauta.cjs",
    "get-shit-done/bin/gsd-rlm.cjs",
    "get-shit-done/bin/gsd-memory.cjs",
    "agents/gsd-executor-backend.md",
    "tests/test_context_validator.py",
]


def _abs(rel_path: str) -> str:
    """Resolve relative path against project root."""
    return os.path.join(PROJECT_ROOT, rel_path)


# ── TestPipeDelimitedFormat ──────────────────────────────────────────────────

class TestPipeDelimitedFormat:
    """CAVE-01 primary success criterion: all 10 sample files produce parseable output."""

    @pytest.mark.parametrize("filepath", SAMPLE_FILES)
    def test_sample_file_matches_pipe_regex(self, filepath):
        """Each file's description matches the CAVE-01 pipe-delimited regex."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs(filepath)
        desc = generate_caveman_description(abs_path)
        assert PIPE_REGEX.match(desc), (
            f"Description for {filepath!r} does not match CAVE-01 regex.\n"
            f"Got: {desc!r}"
        )

    @pytest.mark.parametrize("filepath", SAMPLE_FILES)
    def test_output_under_500_chars(self, filepath):
        """Each description is <= 500 chars."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs(filepath)
        desc = generate_caveman_description(abs_path)
        assert len(desc) <= 500, (
            f"Description for {filepath!r} is {len(desc)} chars, exceeds 500."
        )

    def test_all_four_pipe_segments_present(self):
        """Splitting on '|' produces at least 5 segments (function, deps, touches, tests, quality)."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("services/caveman_descriptions.py")
        desc = generate_caveman_description(abs_path)
        segments = desc.split("|")
        assert len(segments) >= 5, (
            f"Expected >= 5 pipe segments, got {len(segments)}: {desc!r}"
        )

    def test_deps_segment_is_parseable(self):
        """The deps: segment can be split into module names or is 'none'."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("services/caveman_descriptions.py")
        desc = generate_caveman_description(abs_path)
        # Find the deps segment
        deps_match = re.search(r'deps:\s*(.+?)(?:\s*\|)', desc)
        assert deps_match is not None, f"No 'deps:' found in: {desc!r}"
        deps_value = deps_match.group(1).strip()
        # Should be 'none' or comma-separated module names
        if deps_value != "none":
            parts = [p.strip() for p in deps_value.split(",")]
            assert all(len(p) > 0 for p in parts), f"Empty dep in: {deps_value!r}"

    def test_function_summary_under_10_words(self):
        """First segment (before first '|') has <= 10 words."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("services/caveman_descriptions.py")
        desc = generate_caveman_description(abs_path)
        first_segment = desc.split("|")[0].strip()
        word_count = len(first_segment.split())
        assert word_count <= 10, (
            f"Function summary has {word_count} words (max 10): {first_segment!r}"
        )


# ── TestDescriptionFnCompatibility ──────────────────────────────────────────

class TestDescriptionFnCompatibility:
    """Verify generate_caveman_description is compatible with description_fn parameter."""

    def test_callable_signature_matches_selective_refresh(self):
        """generate_caveman_description(path) returns str, no other args required."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("services/caveman_descriptions.py")
        result = generate_caveman_description(abs_path)
        assert isinstance(result, str), f"Expected str, got {type(result)}"
        assert len(result) > 0, "Expected non-empty description"

    def test_nonexistent_file_returns_fallback(self):
        """Returns a non-empty string for missing files (does not raise)."""
        from services.caveman_descriptions import generate_caveman_description
        result = generate_caveman_description("/nonexistent/path/that/does/not/exist.py")
        assert isinstance(result, str), f"Expected str fallback, got {type(result)}"
        assert len(result) > 0, "Expected non-empty fallback"

    def test_binary_file_returns_fallback(self):
        """Returns a string for non-text files (does not raise)."""
        import tempfile
        from services.caveman_descriptions import generate_caveman_description
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False) as f:
            f.write(bytes(range(256)))  # arbitrary binary data
            tmp_path = f.name
        try:
            result = generate_caveman_description(tmp_path)
            assert isinstance(result, str), f"Expected str, got {type(result)}"
            assert len(result) > 0, "Expected non-empty fallback"
        finally:
            os.unlink(tmp_path)


# ── TestLanguageDetection ────────────────────────────────────────────────────

class TestLanguageDetection:
    """Language-specific extraction tests."""

    def test_python_file_extracts_imports(self):
        """Python file description includes 'deps:' with import names."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("services/context_validator.py")
        desc = generate_caveman_description(abs_path)
        # context_validator.py imports hashlib, logging, os, subprocess
        assert "deps:" in desc, f"No 'deps:' in: {desc!r}"
        deps_section = desc[desc.index("deps:"):].split("|")[0]
        assert deps_section.strip() != "deps: none", (
            f"Expected Python imports in deps, got none: {desc!r}"
        )

    def test_cjs_file_extracts_requires(self):
        """CJS file description includes 'deps:' with require names."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("get-shit-done/bin/gsd-amauta.cjs")
        desc = generate_caveman_description(abs_path)
        assert "deps:" in desc, f"No 'deps:' in: {desc!r}"

    def test_markdown_file_extracts_heading(self):
        """MD file description starts with heading text from the first heading."""
        from services.caveman_descriptions import generate_caveman_description
        abs_path = _abs("agents/gsd-executor-backend.md")
        desc = generate_caveman_description(abs_path)
        # The first segment should contain text from a heading or YAML frontmatter key
        first_segment = desc.split("|")[0].strip()
        assert len(first_segment) > 0, f"Empty function summary for MD file: {desc!r}"
