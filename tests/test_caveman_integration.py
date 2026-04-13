#!/usr/bin/env python3
"""Fact density measurement and caveman description wiring integration tests.

Phase 22 / CAVE-04: Fact density — compressed descriptions contain >= 40% more
distinct technical facts than the naive first-500-char original descriptions.

Phase 22 / CAVE-01 wiring: validate_context() and selective_refresh() use
generate_caveman_description as description_fn end-to-end.

Run: pytest tests/test_caveman_integration.py -v
"""
import json
import os
import pytest

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "cave-04-fact-annotations.json")


# ---------------------------------------------------------------------------
# CAVE-04: Fact Density Tests
# ---------------------------------------------------------------------------

class TestFactDensity:

    def test_fixture_exists_and_has_10_entries(self):
        """Fixture file exists with exactly 10 annotated samples."""
        assert os.path.isfile(FIXTURE_PATH), f"Fixture not found: {FIXTURE_PATH}"
        with open(FIXTURE_PATH) as f:
            data = json.load(f)
        assert len(data) == 10, f"Expected 10 entries, got {len(data)}"

    @pytest.fixture
    def fixture_data(self):
        with open(FIXTURE_PATH) as f:
            return json.load(f)

    def test_all_entries_have_required_keys(self, fixture_data):
        """Every entry has file, original_facts, compressed_facts, and counts."""
        required = {
            "file", "original_description", "compressed_description",
            "original_facts", "compressed_facts",
            "original_fact_count", "compressed_fact_count",
        }
        for entry in fixture_data:
            missing = required - set(entry.keys())
            assert not missing, f"Missing keys in {entry.get('file')}: {missing}"

    def test_compressed_facts_ge_140_percent_of_original(self, fixture_data):
        """For every sample, compressed_fact_count >= original_fact_count * 1.4."""
        for entry in fixture_data:
            orig = entry["original_fact_count"]
            comp = entry["compressed_fact_count"]
            assert comp >= orig * 1.4, (
                f"{entry['file']}: compressed_facts={comp} < original_facts={orig} * 1.4 = {orig * 1.4:.1f}"
            )

    def test_fact_counts_match_list_lengths(self, fixture_data):
        """Fact count numbers match the length of the fact lists."""
        for entry in fixture_data:
            assert entry["original_fact_count"] == len(entry["original_facts"]), (
                f"{entry['file']}: original_fact_count={entry['original_fact_count']} "
                f"but original_facts list has {len(entry['original_facts'])} items"
            )
            assert entry["compressed_fact_count"] == len(entry["compressed_facts"]), (
                f"{entry['file']}: compressed_fact_count={entry['compressed_fact_count']} "
                f"but compressed_facts list has {len(entry['compressed_facts'])} items"
            )

    def test_all_entries_reference_real_files(self, fixture_data):
        """Every fixture entry references a file that exists on disk."""
        # FIXTURE_PATH is tests/fixtures/..., so go up 3 levels to reach project root
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(FIXTURE_PATH)))
        missing = []
        for entry in fixture_data:
            abs_path = os.path.join(project_root, entry["file"])
            if not os.path.isfile(abs_path):
                missing.append(entry["file"])
        assert missing == [], f"Fixture entries reference missing files: {missing}"


# ---------------------------------------------------------------------------
# CAVE-01: Caveman Description Wiring Integration Tests
# ---------------------------------------------------------------------------

class TestCavemanDescriptionWiring:

    def test_generate_caveman_description_is_valid_description_fn(self):
        """generate_caveman_description matches the description_fn signature."""
        import tempfile
        from services.caveman_descriptions import generate_caveman_description
        with tempfile.NamedTemporaryFile(delete=False, suffix=".py", mode="w") as f:
            f.write("import os\nimport sys\n\ndef main():\n    pass\n")
            f.flush()
            path = f.name
        try:
            result = generate_caveman_description(path)
            assert isinstance(result, str), f"Expected str, got {type(result)}"
            assert len(result) <= 500, f"Result too long: {len(result)} chars"
            assert "|" in result, f"Result missing pipe delimiter: {result!r}"
            assert "deps:" in result, f"Result missing 'deps:' segment: {result!r}"
        finally:
            os.unlink(path)

    def test_selective_refresh_with_caveman_fn(self):
        """selective_refresh uses generate_caveman_description to produce pipe-delimited output."""
        import re
        import tempfile
        from services.context_validator import ContextValidator
        from services.caveman_descriptions import generate_caveman_description

        PIPE_REGEX = re.compile(r'^.+\|.+deps:.+\|.+touches:.+\|.+tests:.+\|.+$')

        with tempfile.NamedTemporaryFile(delete=False, suffix=".py", mode="w") as f:
            f.write(
                "import hashlib\nimport os\n\n"
                "def compute_hash(path):\n"
                "    return hashlib.sha256(open(path, 'rb').read()).hexdigest()\n"
            )
            f.flush()
            path = f.name
        try:
            context = {
                "file_hashes": {path: "old_hash"},
                "file_descriptions": {path: "old description"},
            }
            result = ContextValidator.selective_refresh(context, [path], generate_caveman_description)
            desc = result["file_descriptions"][path]
            assert PIPE_REGEX.match(desc), f"Description does not match pipe regex: {desc!r}"
            assert result["refreshed_count"] == 1, (
                f"Expected refreshed_count=1, got {result['refreshed_count']}"
            )
        finally:
            os.unlink(path)

    def test_validate_context_with_caveman_fn_end_to_end(self):
        """Full validate_context chain with generate_caveman_description produces pipe-delimited descriptions."""
        import re
        import tempfile
        from unittest.mock import MagicMock, patch
        from services.context_validator import validate_context
        from services.caveman_descriptions import generate_caveman_description

        PIPE_REGEX = re.compile(r'^.+\|.+deps:.+\|.+touches:.+\|.+tests:.+\|.+$')

        with tempfile.NamedTemporaryFile(delete=False, suffix=".py", mode="w") as f:
            f.write("import json\n\ndef parse(data):\n    return json.loads(data)\n")
            f.flush()
            path = f.name
        try:
            mock_store = MagicMock()
            mock_store.rpetd_context_get.return_value = {
                "file_hashes": {path: "old_hash", "__commit_ref__": ""},
                "compiled_view": {"file_descriptions": {path: "old desc"}},
            }

            with patch("services.context_validator.subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stdout=f"{path}\n")
                result = validate_context(
                    "TK-CAVE", "P",
                    pg_store=mock_store,
                    description_fn=generate_caveman_description,
                )
            desc = result["file_descriptions"][path]
            assert PIPE_REGEX.match(desc), f"E2E description does not match pipe regex: {desc!r}"
            assert result["refreshed_count"] == 1, (
                f"Expected refreshed_count=1, got {result['refreshed_count']}"
            )
        finally:
            os.unlink(path)
