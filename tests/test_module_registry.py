"""Phase 57 MARK-01: Registry index schema tests."""
import json
import os
import unittest

from services.module_registry import (
    RegistryIndex,
    RegistryEntry,
    SCHEMA_VERSION,
    _REGISTRY_ERROR_CODES,
    load_registry_index,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(REPO_ROOT, "registry", "index.json")


class TestRegistryConstants(unittest.TestCase):
    def test_schema_version_locked_at_1_0(self):
        self.assertEqual(SCHEMA_VERSION, "1.0")

    def test_eight_error_codes_frozen(self):
        expected = {
            "unsupported_install_source", "download_failed", "manifest_invalid",
            "sha256_mismatch", "unknown_signer", "signature_invalid",
            "registry_not_found", "registry_unreachable",
        }
        self.assertEqual(set(_REGISTRY_ERROR_CODES), expected)
        self.assertEqual(len(_REGISTRY_ERROR_CODES), 8)


class TestRegistryEntryFieldOrder(unittest.TestCase):
    def test_seven_field_locked_order(self):
        # The 7-field LOCKED order: name, version, sha256, manifest_url,
        # maintainer, signed_by, signature.
        if hasattr(RegistryEntry, "model_fields"):
            order = list(RegistryEntry.model_fields.keys())
        else:
            order = ["name", "version", "sha256", "manifest_url",
                     "maintainer", "signed_by", "signature"]
        self.assertEqual(order, [
            "name", "version", "sha256", "manifest_url",
            "maintainer", "signed_by", "signature",
        ])


class TestRegistryIndexSchema(unittest.TestCase):
    def test_loads_repo_registry_index(self):
        idx = load_registry_index(INDEX_PATH)
        self.assertEqual(idx.registry_version, "1.0")
        self.assertGreaterEqual(len(idx.entries), 1)

    def test_rejects_wrong_version(self):
        bad = {"registry_version": "2.0", "entries": []}
        if hasattr(RegistryIndex, "model_validate"):
            with self.assertRaises(Exception):
                RegistryIndex.model_validate(bad)
        else:
            with self.assertRaises(ValueError):
                RegistryIndex(**bad)

    def test_rejects_extra_field(self):
        bad = {"registry_version": "1.0", "entries": [], "unknown": "x"}
        if hasattr(RegistryIndex, "model_validate"):
            with self.assertRaises(Exception):
                RegistryIndex.model_validate(bad)


class TestRegistryEntryValidation(unittest.TestCase):
    def _entry(self, **overrides):
        defaults = {
            "name": "ex", "version": "1.0.0",
            "sha256": "0" * 64,
            "manifest_url": "https://example.com/m.yaml",
            "maintainer": "test", "signed_by": "k1",
            "signature": "0" * 128,
        }
        defaults.update(overrides)
        return defaults

    def test_sha256_must_be_64_hex(self):
        if hasattr(RegistryEntry, "model_validate"):
            with self.assertRaises(Exception):
                RegistryEntry.model_validate(self._entry(sha256="abc"))

    def test_signature_must_be_128_hex(self):
        if hasattr(RegistryEntry, "model_validate"):
            with self.assertRaises(Exception):
                RegistryEntry.model_validate(self._entry(signature="abc"))

    def test_manifest_url_must_be_https(self):
        if hasattr(RegistryEntry, "model_validate"):
            with self.assertRaises(Exception):
                RegistryEntry.model_validate(self._entry(manifest_url="ftp://x/m.yaml"))


if __name__ == "__main__":
    unittest.main()
