"""Phase 57 MARK-04: URL install tests. Real ed25519, mocked urllib + filesystem."""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.module_registry import RegistryEntry, RegistryIndex
from services.module_signer import generate_keypair, sign_sha256
from services.module_url_installer import (
    InstallError,
    ERROR_CODES,
    resolve_source,
    download_to_temp,
    install_from_url,
)


def _fixture_manifest_yaml(name="fixture-mod", version="1.0.0") -> str:
    return (
        f"name: {name}\n"
        f"version: {version}\n"
        f"description: Phase 57 fixture\n"
        f"author: tests\n"
    )


def _registry_entry_signed(yaml_text: str, key_id: str = "phase57-test-key"):
    """Generate a real signed RegistryEntry for the given manifest yaml."""
    from services.module_registry import compute_manifest_hash
    sha = compute_manifest_hash(yaml_text)
    priv, pub = generate_keypair()
    sig = sign_sha256(sha, priv)
    entry = RegistryEntry(
        name="fixture-mod", version="1.0.0",
        sha256=sha,
        manifest_url="https://example.com/fixture-mod/1.0.0/manifest.yaml",
        maintainer="tests", signed_by=key_id,
        signature=sig,
    )
    return entry, pub  # pub is what gets written to trust store


def _mock_urlopen(body: bytes):
    """Build a mock urlopen context manager response."""
    fake = io.BytesIO(body)
    fake.read = fake.read
    ctx = mock.MagicMock()
    ctx.__enter__ = mock.MagicMock(return_value=fake)
    ctx.__exit__ = mock.MagicMock(return_value=False)
    return mock.patch("urllib.request.urlopen", return_value=ctx)


class TestSchemeResolution(unittest.TestCase):
    def test_https_passthrough(self):
        url, n, v = resolve_source("https://example.com/m.yaml")
        self.assertEqual(url, "https://example.com/m.yaml")
        self.assertIsNone(n)
        self.assertIsNone(v)

    def test_github_resolution(self):
        url, n, v = resolve_source("github:robertamauta/mod-x@v2.1.0")
        self.assertEqual(
            url,
            "https://raw.githubusercontent.com/robertamauta/mod-x/v2.1.0/manifest.yaml",
        )
        self.assertIsNone(n)
        self.assertIsNone(v)

    def test_ftp_scheme_rejected_as_unsupported(self):
        with self.assertRaises(InstallError) as ctx:
            resolve_source("ftp://example.com/m.yaml")
        self.assertEqual(ctx.exception.error_code, "unsupported_install_source")

    def test_bare_string_rejected_as_unsupported(self):
        with self.assertRaises(InstallError) as ctx:
            resolve_source("just-a-name")
        self.assertEqual(ctx.exception.error_code, "unsupported_install_source")


class TestErrorVocabularyLocked(unittest.TestCase):
    def test_eight_frozen_codes(self):
        expected = {
            "unsupported_install_source",
            "download_failed",
            "manifest_invalid",
            "sha256_mismatch",
            "unknown_signer",
            "signature_invalid",
            "registry_not_found",
            "registry_unreachable",
        }
        self.assertEqual(set(ERROR_CODES), expected)
        self.assertEqual(len(ERROR_CODES), 8)

    def test_install_error_rejects_unknown_code(self):
        with self.assertRaises(ValueError):
            InstallError("not_a_real_code", "x")

    def test_install_error_accepts_known_code(self):
        err = InstallError("download_failed", "test detail")
        self.assertEqual(err.error_code, "download_failed")
        self.assertEqual(err.detail, "test detail")


class TestDownloadToTemp(unittest.TestCase):
    def test_url_error_raises_download_failed(self):
        import urllib.error
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("nope"),
        ):
            with self.assertRaises(InstallError) as ctx:
                download_to_temp("https://example.com/m.yaml")
            self.assertEqual(ctx.exception.error_code, "download_failed")

    def test_writes_temp_file_on_success(self):
        body = b"name: test\nversion: 1.0.0\n"
        with _mock_urlopen(body):
            path = download_to_temp("https://example.com/m.yaml")
            try:
                self.assertTrue(os.path.exists(path))
                with open(path, "rb") as f:
                    self.assertEqual(f.read(), body)
            finally:
                os.unlink(path)


class TestVerifyBeforeInstallPipeline(unittest.TestCase):
    """End-to-end fail-closed paths. Mocks urllib + filesystem + lifecycle.install."""

    def _setup_trust_store(self, key_id, pubkey_hex, td):
        store = Path(td) / "trusted-keys"
        store.mkdir(parents=True, exist_ok=True)
        (store / f"{key_id}.pub").write_text(pubkey_hex)
        return store

    def _setup_registry(self, entry, td):
        idx_path = Path(td) / "index.json"
        idx_path.write_text(json.dumps({
            "registry_version": "1.0",
            "entries": [{
                "name": entry.name, "version": entry.version, "sha256": entry.sha256,
                "manifest_url": entry.manifest_url, "maintainer": entry.maintainer,
                "signed_by": entry.signed_by, "signature": entry.signature,
            }],
        }))
        return idx_path

    def test_sha256_mismatch_fails_closed(self):
        yaml_text = _fixture_manifest_yaml()
        entry, pub = _registry_entry_signed(yaml_text)
        # Tamper the registry sha to a wrong value
        tampered = RegistryEntry(
            name=entry.name, version=entry.version,
            sha256="a" * 64,  # wrong sha (all a's)
            manifest_url=entry.manifest_url, maintainer=entry.maintainer,
            signed_by=entry.signed_by, signature=entry.signature,
        )
        with tempfile.TemporaryDirectory() as td:
            store = self._setup_trust_store("phase57-test-key", pub, td)
            idx_path = self._setup_registry(tampered, td)
            with mock.patch("services.module_signer.TRUST_STORE_DIR", store):
                with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                    with mock.patch(
                        "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                    ):
                        with _mock_urlopen(yaml_text.encode("utf-8")):
                            with self.assertRaises(InstallError) as ctx:
                                install_from_url("https://example.com/m.yaml")
                            self.assertEqual(ctx.exception.error_code, "sha256_mismatch")

    def test_unknown_signer_fails_closed(self):
        yaml_text = _fixture_manifest_yaml()
        entry, _ = _registry_entry_signed(yaml_text, key_id="ghost-key")
        with tempfile.TemporaryDirectory() as td:
            # NO trust store directory at all
            empty_store = Path(td) / "empty-trusted-keys"  # does not exist
            idx_path = self._setup_registry(entry, td)
            with mock.patch("services.module_signer.TRUST_STORE_DIR", empty_store):
                with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                    with mock.patch(
                        "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                    ):
                        with _mock_urlopen(yaml_text.encode("utf-8")):
                            with self.assertRaises(InstallError) as ctx:
                                install_from_url("https://example.com/m.yaml")
                            self.assertEqual(ctx.exception.error_code, "unknown_signer")

    def test_invalid_signature_fails_closed(self):
        yaml_text = _fixture_manifest_yaml()
        entry, _ = _registry_entry_signed(yaml_text)
        # Use a DIFFERENT pubkey in trust store than what signed the entry
        _, wrong_pub = generate_keypair()
        with tempfile.TemporaryDirectory() as td:
            store = self._setup_trust_store("phase57-test-key", wrong_pub, td)
            idx_path = self._setup_registry(entry, td)
            with mock.patch("services.module_signer.TRUST_STORE_DIR", store):
                with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                    with mock.patch(
                        "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                    ):
                        with _mock_urlopen(yaml_text.encode("utf-8")):
                            with self.assertRaises(InstallError) as ctx:
                                install_from_url("https://example.com/m.yaml")
                            self.assertEqual(ctx.exception.error_code, "signature_invalid")

    def test_registry_not_found_fails_closed(self):
        # registry: scheme to a name not in the index
        with tempfile.TemporaryDirectory() as td:
            idx_path = Path(td) / "index.json"
            idx_path.write_text(json.dumps({"registry_version": "1.0", "entries": []}))
            with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                with mock.patch(
                    "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                ):
                    with self.assertRaises(InstallError) as ctx:
                        install_from_url("registry:ghost-mod@1.0.0")
                    self.assertEqual(ctx.exception.error_code, "registry_not_found")

    def test_temp_file_cleaned_on_failure(self):
        # Verify the temp file is unlinked when verification fails
        yaml_text = _fixture_manifest_yaml()
        with tempfile.TemporaryDirectory() as td:
            idx_path = Path(td) / "index.json"
            idx_path.write_text(json.dumps({"registry_version": "1.0", "entries": []}))
            with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                with mock.patch(
                    "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                ):
                    with _mock_urlopen(yaml_text.encode("utf-8")):
                        # Snapshot temp dir BEFORE call
                        temp_root = Path(tempfile.gettempdir())
                        before = {
                            p.name
                            for p in temp_root.iterdir()
                            if p.name.startswith("gsd-amauta-manifest-")
                        }
                        try:
                            install_from_url("https://example.com/m.yaml")
                        except InstallError:
                            pass
                        after = {
                            p.name
                            for p in temp_root.iterdir()
                            if p.name.startswith("gsd-amauta-manifest-")
                        }
                        # No new temp files leaked
                        self.assertEqual(
                            before, after, f"leaked temp files: {after - before}"
                        )

    def test_phase49_not_called_on_sha256_failure(self):
        """Phase 49 install() is NEVER invoked when any verification step fails."""
        yaml_text = _fixture_manifest_yaml()
        entry, pub = _registry_entry_signed(yaml_text)
        tampered = RegistryEntry(
            name=entry.name, version=entry.version,
            sha256="b" * 64,  # wrong sha
            manifest_url=entry.manifest_url, maintainer=entry.maintainer,
            signed_by=entry.signed_by, signature=entry.signature,
        )
        with tempfile.TemporaryDirectory() as td:
            store = self._setup_trust_store("phase57-test-key", pub, td)
            idx_path = self._setup_registry(tampered, td)
            with mock.patch("services.module_signer.TRUST_STORE_DIR", store):
                with mock.patch("services.module_search.REPO_INDEX_PATH", idx_path):
                    with mock.patch(
                        "services.module_search.CACHE_PATH", Path(td) / "nonexistent_cache.json"
                    ):
                        with _mock_urlopen(yaml_text.encode("utf-8")):
                            with mock.patch(
                                "services.module_lifecycle.install"
                            ) as mock_install:
                                with self.assertRaises(InstallError) as ctx:
                                    install_from_url("https://example.com/m.yaml")
                                self.assertEqual(ctx.exception.error_code, "sha256_mismatch")
                                # Phase 49 install NEVER called
                                mock_install.assert_not_called()


if __name__ == "__main__":
    unittest.main()
