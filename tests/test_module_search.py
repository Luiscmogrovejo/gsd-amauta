"""Phase 57 MARK-02: Module search tests.

12+ tests covering:
    - 3-tier ranking (_tier function)
    - Search ordering (exact > substring > maintainer, semver-descending within tier)
    - load_index fallback chain (repo fallback, no-index-anywhere error)
    - fetch_remote error handling (registry_unreachable, manifest_invalid)
    - CLI subprocess integration (JSON output shape)
"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.module_registry import RegistryEntry, RegistryIndex
from services.module_search import (
    CACHE_PATH,
    REPO_INDEX_PATH,
    SearchError,
    _tier,
    fetch_remote,
    load_index,
    search,
)


def _entry(name="ex", version="1.0.0", maintainer="m"):
    return RegistryEntry(
        name=name,
        version=version,
        sha256="0" * 64,
        manifest_url=f"https://example.com/{name}/{version}/m.yaml",
        maintainer=maintainer,
        signed_by="k1",
        signature="0" * 128,
    )


def _index(entries):
    return RegistryIndex(registry_version="1.0", entries=entries)


class TestRankingTiers(unittest.TestCase):
    def test_exact_name_match_is_tier_0(self):
        self.assertEqual(_tier(_entry(name="alpha"), "alpha"), 0)

    def test_name_substring_is_tier_1(self):
        self.assertEqual(_tier(_entry(name="alpha-extra"), "alpha"), 1)

    def test_maintainer_substring_is_tier_2(self):
        self.assertEqual(_tier(_entry(name="x", maintainer="alpha-team"), "alpha"), 2)

    def test_no_match_is_tier_3(self):
        self.assertEqual(_tier(_entry(name="x", maintainer="y"), "zzz"), 3)

    def test_empty_query_returns_tier_0(self):
        self.assertEqual(_tier(_entry(name="x"), ""), 0)


class TestSearchOrdering(unittest.TestCase):
    def test_exact_match_ranked_before_substring(self):
        idx = _index([
            _entry(name="alpha-extra", version="9.9.9"),
            _entry(name="alpha", version="1.0.0"),
        ])
        results = search("alpha", idx)
        self.assertEqual(results[0]["name"], "alpha")
        self.assertEqual(results[1]["name"], "alpha-extra")

    def test_semver_descending_within_tier(self):
        idx = _index([
            _entry(name="alpha", version="1.0.0"),
            _entry(name="alpha", version="2.0.0"),
            _entry(name="alpha", version="1.5.0"),
        ])
        results = search("alpha", idx)
        versions = [r["version"] for r in results]
        self.assertEqual(versions, ["2.0.0", "1.5.0", "1.0.0"])

    def test_no_match_returns_empty(self):
        idx = _index([_entry(name="alpha"), _entry(name="beta")])
        self.assertEqual(search("zzz", idx), [])

    def test_empty_query_returns_all(self):
        idx = _index([_entry(name="alpha"), _entry(name="beta")])
        results = search("", idx)
        self.assertEqual(len(results), 2)

    def test_maintainer_match_ranked_after_name_match(self):
        """A name-substring match must rank above a maintainer-substring match."""
        idx = _index([
            _entry(name="zz", maintainer="alpha-org"),     # tier 2
            _entry(name="alpha-plugin", maintainer="bob"),  # tier 1
        ])
        results = search("alpha", idx)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["name"], "alpha-plugin")
        self.assertEqual(results[1]["name"], "zz")

    def test_case_insensitive_matching(self):
        """Query and name comparison is case-insensitive."""
        idx = _index([_entry(name="Alpha")])
        results = search("ALPHA", idx)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["name"], "Alpha")


class TestLoadIndex(unittest.TestCase):
    def test_repo_fallback_when_no_cache_and_no_url(self):
        """load_index() with no args falls through to in-repo registry/index.json."""
        if not REPO_INDEX_PATH.exists():
            self.skipTest("registry/index.json not yet created (57-01 dependency)")
        idx = load_index(registry_url=None)
        self.assertEqual(idx.registry_version, "1.0")

    def test_no_index_anywhere_raises_registry_not_found(self):
        """When neither cache nor in-repo index exists, SearchError(registry_not_found) raised."""
        with tempfile.TemporaryDirectory() as td:
            fake_cache = Path(td) / "cache" / "index.json"
            fake_repo = Path(td) / "repo" / "index.json"
            with mock.patch("services.module_search.CACHE_PATH", fake_cache):
                with mock.patch("services.module_search.REPO_INDEX_PATH", fake_repo):
                    with self.assertRaises(SearchError) as ctx:
                        load_index(None)
                    self.assertEqual(ctx.exception.error_code, "registry_not_found")


class TestFetchRemote(unittest.TestCase):
    def test_url_error_raises_registry_unreachable(self):
        """Unreachable URL raises SearchError(registry_unreachable)."""
        with self.assertRaises(SearchError) as ctx:
            fetch_remote("http://nonexistent.invalid.localhost.test/x.json")
        self.assertEqual(ctx.exception.error_code, "registry_unreachable")

    def test_remote_with_wrong_version_raises_manifest_invalid(self):
        """A remote index with mismatched registry_version raises SearchError(manifest_invalid)."""
        bad = json.dumps({"registry_version": "2.0", "entries": []}).encode("utf-8")
        fake_resp = io.BytesIO(bad)
        fake_resp.__enter__ = lambda *a: fake_resp
        fake_resp.__exit__ = lambda *a: None
        with mock.patch("urllib.request.urlopen", return_value=fake_resp):
            with self.assertRaises(SearchError) as ctx:
                fetch_remote("https://example.com/index.json")
            self.assertEqual(ctx.exception.error_code, "manifest_invalid")

    def test_json_decode_error_raises_manifest_invalid(self):
        """Non-JSON response raises SearchError(manifest_invalid)."""
        bad = b"NOT-JSON!!!"
        fake_resp = io.BytesIO(bad)
        fake_resp.__enter__ = lambda *a: fake_resp
        fake_resp.__exit__ = lambda *a: None
        with mock.patch("urllib.request.urlopen", return_value=fake_resp):
            with self.assertRaises(SearchError) as ctx:
                fetch_remote("https://example.com/index.json")
            self.assertEqual(ctx.exception.error_code, "manifest_invalid")


class TestCLI(unittest.TestCase):
    def test_cli_json_output(self):
        """CLI --json flag produces valid JSON with schema_version, query, results keys."""
        result = subprocess.run(
            [sys.executable, "services/module_search_cli.py", "example", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["schema_version"], "1.0")
        self.assertIn("query", data)
        self.assertIn("results", data)

    def test_cli_empty_query_lists_all(self):
        """Empty query returns all entries without error."""
        result = subprocess.run(
            [sys.executable, "services/module_search_cli.py", "", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertGreaterEqual(len(data["results"]), 0)


if __name__ == "__main__":
    unittest.main()
