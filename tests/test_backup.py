#!/usr/bin/env python3
"""Tests for GSD-Amauta Backup/Restore (Phase 8: Data Durability).

Tests backup creation, checksum verification, tamper detection,
restore merge/replace modes, auto-backup daily logic, and pruning.

Uses SQLiteStore in a temp directory -- no daemon, no PG needed.

Run with:
    python3 tests/test_backup.py
    python3 -m pytest tests/test_backup.py -v
"""
import gzip
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

# Prevent side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore
from backup import BackupManager, SCHEMA_VERSION


class BackupTestBase(unittest.TestCase):
    """Base class: creates a temp dir with an SQLiteStore and BackupManager."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="gsd-backup-test-")
        self.db_path = os.path.join(self.tmpdir, "test.db")
        self.backup_dir = os.path.join(self.tmpdir, "backups")
        os.makedirs(self.backup_dir, exist_ok=True)

        self.store = SQLiteStore(db_path=self.db_path)
        self.mgr = BackupManager(self.store)

        # Seed some test data
        self.store.memory_store(
            text="Test memory entry for backup",
            source="auto_learning",
            agent_id="test-agent",
            tags=["testing", "backup"],
            project_id="test-project",
        )
        self.store.memory_store(
            text="Second memory entry",
            source="lesson-learned",
            tags=["kubernetes"],
        )
        self.store.skb_store(
            title="Test SKB",
            content="Some knowledge content",
            category="pattern",
            importance=7,
        )
        self.store.task_upsert({
            "id": "TK-TEST-001",
            "title": "Test Task",
            "type": "task",
            "status": "done",
            "rpetd_phases": {"R": "research", "P": "plan", "E": "exec", "T": "test", "D": "doc"},
        })
        self.store.validation_record(
            task_id="TK-TEST-001",
            validator_id="validator-bot",
            status="approved",
            evidence={"notes": "Looks good"},
        )
        self.store.audit_log(
            task_id="TK-TEST-001",
            event_type="validation",
            agent_id="test-agent",
            status="pass",
        )
        self.store.audit_log(
            task_id="TK-TEST-001",
            event_type="rpetd_phase",
            agent_id="test-agent",
            phase="R",
        )

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class TestBackupCreate(BackupTestBase):
    """DUR-01: Test that create produces valid gzip JSON with correct schema."""

    def test_create_produces_gzip_json(self):
        output = os.path.join(self.backup_dir, "test-backup.json.gz")
        path, counts, checksum = self.mgr.create(output)

        # File was created
        self.assertTrue(os.path.exists(path))
        self.assertEqual(path, output)

        # Readable as gzip JSON
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)

        # Has required fields
        self.assertIn("schema_version", data)
        self.assertIn("created_at", data)
        self.assertIn("tables", data)
        self.assertIn("counts", data)
        self.assertIn("checksum", data)

    def test_create_includes_schema_version(self):
        """DUR-03: Backup includes schema_version."""
        output = os.path.join(self.backup_dir, "test-schema.json.gz")
        self.mgr.create(output)

        with gzip.open(output, "rt") as f:
            data = json.load(f)

        self.assertEqual(data["schema_version"], SCHEMA_VERSION)

    def test_create_counts_match_rows(self):
        output = os.path.join(self.backup_dir, "test-counts.json.gz")
        path, counts, _ = self.mgr.create(output)

        self.assertEqual(counts["gsd_memory"], 2)
        self.assertEqual(counts["gsd_tasks"], 1)
        self.assertEqual(counts["gsd_shared_kb"], 1)
        self.assertEqual(counts["gsd_task_validations"], 1)

        # Verify internal counts match actual row counts
        with gzip.open(path, "rt") as f:
            data = json.load(f)
        for table, expected in data["counts"].items():
            self.assertEqual(len(data["tables"][table]), expected,
                             f"Count mismatch for {table}")


class TestBackupVerify(BackupTestBase):
    """DUR-04: Test checksum verification."""

    def test_verify_valid_backup(self):
        output = os.path.join(self.backup_dir, "valid-backup.json.gz")
        self.mgr.create(output)

        result = self.mgr.verify(output)
        self.assertTrue(result["valid"], f"Expected valid, errors: {result.get('errors')}")
        self.assertEqual(len(result["errors"]), 0)

    def test_verify_detects_tampered_backup(self):
        """Tamper with the backup data and verify checksum fails."""
        output = os.path.join(self.backup_dir, "tampered-backup.json.gz")
        self.mgr.create(output)

        # Read, tamper, and rewrite
        with gzip.open(output, "rt") as f:
            data = json.load(f)

        # Tamper: add a fake memory row
        data["tables"]["gsd_memory"].append({"id": "fake", "text": "injected"})
        # Do NOT update the checksum

        with gzip.open(output, "wt", encoding="utf-8") as f:
            json.dump(data, f)

        result = self.mgr.verify(output)
        self.assertFalse(result["valid"])
        # Should have checksum error
        checksum_errors = [e for e in result["errors"] if "Checksum" in e or "checksum" in e]
        self.assertTrue(len(checksum_errors) > 0, f"Expected checksum error, got: {result['errors']}")

    def test_verify_detects_count_mismatch(self):
        """Tamper with counts and verify count validation catches it."""
        output = os.path.join(self.backup_dir, "count-tamper.json.gz")
        self.mgr.create(output)

        with gzip.open(output, "rt") as f:
            data = json.load(f)

        # Tamper: inflate the count without adding rows
        data["counts"]["gsd_memory"] = 999
        # Also fix checksum to pass checksum check (only test count mismatch)
        data_for_hash = json.dumps(data["tables"], sort_keys=True, default=str)
        data["checksum"] = hashlib.sha256(data_for_hash.encode()).hexdigest()

        with gzip.open(output, "wt", encoding="utf-8") as f:
            json.dump(data, f)

        result = self.mgr.verify(output)
        self.assertFalse(result["valid"])
        count_errors = [e for e in result["errors"] if "Count mismatch" in e]
        self.assertTrue(len(count_errors) > 0)

    def test_verify_database_state(self):
        """Verify current database (no file path)."""
        result = self.mgr.verify()
        self.assertTrue(result["valid"], f"Errors: {result.get('errors')}")
        self.assertIn("gsd_memory", result.get("counts", {}))


class TestBackupRestore(BackupTestBase):
    """DUR-02: Test restore merge and replace modes."""

    def test_restore_merge_adds_missing(self):
        """Merge mode: adds rows that don't exist, skips existing."""
        output = os.path.join(self.backup_dir, "merge-backup.json.gz")
        self.mgr.create(output)

        # Create a new store (simulating a different database)
        new_db = os.path.join(self.tmpdir, "new.db")
        new_store = SQLiteStore(db_path=new_db)
        new_mgr = BackupManager(new_store)

        result = new_mgr.restore(output, mode="merge")
        self.assertEqual(result["mode"], "merge")
        self.assertEqual(result["schema_version"], SCHEMA_VERSION)
        self.assertGreater(result["tables_restored"], 0)

        # Verify data was imported
        self.assertEqual(new_store.memory_count(), 2)

    def test_restore_merge_no_duplicates(self):
        """Merge into same store should not duplicate rows."""
        output = os.path.join(self.backup_dir, "dup-backup.json.gz")
        self.mgr.create(output)

        original_count = self.store.memory_count()
        self.mgr.restore(output, mode="merge")

        # Should still have same count (all rows already exist)
        self.assertEqual(self.store.memory_count(), original_count)

    def test_restore_replace_drops_and_imports(self):
        """Replace mode: drops existing data and imports all from backup."""
        output = os.path.join(self.backup_dir, "replace-backup.json.gz")
        self.mgr.create(output)

        # Add extra data that should be removed on replace
        self.store.memory_store(text="Extra row that should be removed")
        self.assertEqual(self.store.memory_count(), 3)

        self.mgr.restore(output, mode="replace")

        # After replace, should be back to 2 (the backup had 2)
        self.assertEqual(self.store.memory_count(), 2)

    def test_restore_rejects_incompatible_version(self):
        """Restore should fail on major version mismatch."""
        output = os.path.join(self.backup_dir, "old-version.json.gz")
        self.mgr.create(output)

        # Tamper the version
        with gzip.open(output, "rt") as f:
            data = json.load(f)
        data["schema_version"] = "99.0.0"
        # Recalculate checksum
        data_for_hash = json.dumps(data["tables"], sort_keys=True, default=str)
        data["checksum"] = hashlib.sha256(data_for_hash.encode()).hexdigest()
        with gzip.open(output, "wt", encoding="utf-8") as f:
            json.dump(data, f)

        with self.assertRaises(ValueError) as ctx:
            self.mgr.restore(output)
        self.assertIn("Incompatible", str(ctx.exception))

    def test_restore_rejects_corrupt_checksum(self):
        """Restore should fail if checksum doesn't match."""
        output = os.path.join(self.backup_dir, "corrupt.json.gz")
        self.mgr.create(output)

        with gzip.open(output, "rt") as f:
            data = json.load(f)
        data["tables"]["gsd_memory"].append({"id": "corrupt", "text": "bad"})
        # Do NOT update checksum
        with gzip.open(output, "wt", encoding="utf-8") as f:
            json.dump(data, f)

        with self.assertRaises(ValueError) as ctx:
            self.mgr.restore(output)
        self.assertIn("checksum", str(ctx.exception).lower())

    def test_restore_file_not_found(self):
        """Restore should raise FileNotFoundError for missing file."""
        with self.assertRaises(FileNotFoundError):
            self.mgr.restore("/nonexistent/backup.json.gz")


class TestAutoBackup(BackupTestBase):
    """DUR-05: Test auto-backup creates daily file and prunes old ones."""

    def test_auto_backup_creates_daily_file(self):
        import backup as backup_module
        orig_dir = backup_module.BACKUP_DIR
        backup_module.BACKUP_DIR = self.backup_dir
        try:
            path = self.mgr.auto_backup()
            self.assertIsNotNone(path)
            self.assertTrue(os.path.exists(path))
            self.assertIn("gsd-auto-", os.path.basename(path))
        finally:
            backup_module.BACKUP_DIR = orig_dir

    def test_auto_backup_skips_if_exists(self):
        import backup as backup_module
        orig_dir = backup_module.BACKUP_DIR
        backup_module.BACKUP_DIR = self.backup_dir
        try:
            path1 = self.mgr.auto_backup()
            self.assertIsNotNone(path1)

            # Second call same day should return None
            path2 = self.mgr.auto_backup()
            self.assertIsNone(path2)
        finally:
            backup_module.BACKUP_DIR = orig_dir

    def test_auto_backup_prunes_to_7(self):
        import backup as backup_module
        import time
        orig_dir = backup_module.BACKUP_DIR
        backup_module.BACKUP_DIR = self.backup_dir
        try:
            # Create 10 fake auto-backup files
            for i in range(10):
                fake_date = f"2026031{i}"
                fake_path = os.path.join(self.backup_dir, f"gsd-auto-{fake_date}.json.gz")
                with gzip.open(fake_path, "wt") as f:
                    json.dump({"fake": True}, f)

            # Now run auto_backup which creates today's file + prunes
            path = self.mgr.auto_backup()

            # Count remaining auto-backups
            import glob
            remaining = glob.glob(os.path.join(self.backup_dir, "gsd-auto-*.json.gz"))
            self.assertLessEqual(len(remaining), 7,
                                 f"Expected <= 7 auto-backups, found {len(remaining)}")
        finally:
            backup_module.BACKUP_DIR = orig_dir


class TestBackupList(BackupTestBase):
    """Test listing available backups."""

    def test_list_empty(self):
        import backup as backup_module
        orig_dir = backup_module.BACKUP_DIR
        empty_dir = os.path.join(self.tmpdir, "empty_backups")
        backup_module.BACKUP_DIR = empty_dir
        try:
            backups = self.mgr.list_backups()
            self.assertEqual(len(backups), 0)
        finally:
            backup_module.BACKUP_DIR = orig_dir

    def test_list_after_create(self):
        import backup as backup_module
        orig_dir = backup_module.BACKUP_DIR
        backup_module.BACKUP_DIR = self.backup_dir
        try:
            self.mgr.create(os.path.join(self.backup_dir, "gsd-backup-test.json.gz"))
            backups = self.mgr.list_backups()
            self.assertEqual(len(backups), 1)
            self.assertIn("filename", backups[0])
            self.assertIn("size_bytes", backups[0])
            self.assertIn("size_human", backups[0])
        finally:
            backup_module.BACKUP_DIR = orig_dir


class TestBackupAuditInclusion(BackupTestBase):
    """DUR-01: gsd_audit_log must be included in backup create/restore/verify."""

    def test_create_includes_audit_log_key(self):
        """Backup JSON must contain gsd_audit_log in tables and counts."""
        output = os.path.join(self.backup_dir, "audit-create.json.gz")
        path, counts, _ = self.mgr.create(output)

        self.assertIn("gsd_audit_log", counts,
                      "gsd_audit_log missing from backup counts")
        self.assertEqual(counts["gsd_audit_log"], 2,
                         f"Expected 2 audit rows, got {counts['gsd_audit_log']}")

        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("gsd_audit_log", data["tables"])
        self.assertEqual(len(data["tables"]["gsd_audit_log"]), 2)

    def test_restore_merge_imports_audit_rows(self):
        """Merge restore to fresh DB must import all audit rows."""
        output = os.path.join(self.backup_dir, "audit-merge.json.gz")
        self.mgr.create(output)

        new_db = os.path.join(self.tmpdir, "audit-new.db")
        new_store = SQLiteStore(db_path=new_db)
        new_mgr = BackupManager(new_store)

        result = new_mgr.restore(output, mode="merge")
        self.assertIn("gsd_audit_log", result["rows_imported"])
        self.assertEqual(result["rows_imported"]["gsd_audit_log"], 2)
        self.assertEqual(new_store.audit_count(), 2)

    def test_restore_merge_no_duplicates_on_rerun(self):
        """Merge restore into same store must not duplicate audit rows."""
        output = os.path.join(self.backup_dir, "audit-dup.json.gz")
        self.mgr.create(output)

        original_count = self.store.audit_count()
        self.mgr.restore(output, mode="merge")
        self.assertEqual(self.store.audit_count(), original_count,
                         "Merge re-import should not create duplicate audit rows")

    def test_restore_replace_repopulates_audit(self):
        """Replace restore must truncate and repopulate audit table."""
        output = os.path.join(self.backup_dir, "audit-replace.json.gz")
        self.mgr.create(output)

        # Add an extra audit row that should be removed on replace
        self.store.audit_log(
            task_id="TK-EXTRA",
            event_type="validation",
            agent_id="extra-agent",
            status="fail",
        )
        self.assertEqual(self.store.audit_count(), 3)

        self.mgr.restore(output, mode="replace")
        self.assertEqual(self.store.audit_count(), 2,
                         "After replace, audit count should match backup (2)")

    def test_verify_file_checks_audit_count(self):
        """verify(file) must include gsd_audit_log count check in result."""
        output = os.path.join(self.backup_dir, "audit-verify.json.gz")
        self.mgr.create(output)

        result = self.mgr.verify(output)
        self.assertTrue(result["valid"], f"verify failed: {result.get('errors')}")
        audit_checks = [c for c in result["checks"] if "gsd_audit_log" in c]
        self.assertTrue(len(audit_checks) > 0,
                        f"Expected gsd_audit_log in verify checks, got: {result['checks']}")

    def test_restore_old_backup_without_audit_key(self):
        """Old backup without gsd_audit_log key must restore cleanly (0 audit rows)."""
        output = os.path.join(self.backup_dir, "old-backup.json.gz")
        self.mgr.create(output)

        # Strip out gsd_audit_log to simulate an old backup
        with gzip.open(output, "rt", encoding="utf-8") as f:
            data = json.load(f)
        data["tables"].pop("gsd_audit_log", None)
        data["counts"].pop("gsd_audit_log", None)
        # Recompute checksum to keep it valid
        data_for_hash = json.dumps(data["tables"], sort_keys=True, default=str)
        data["checksum"] = hashlib.sha256(data_for_hash.encode("utf-8")).hexdigest()
        with gzip.open(output, "wt", encoding="utf-8") as f:
            json.dump(data, f)

        new_db = os.path.join(self.tmpdir, "old-compat.db")
        new_store = SQLiteStore(db_path=new_db)
        new_mgr = BackupManager(new_store)

        # Must not raise; audit count should be 0
        result = new_mgr.restore(output, mode="merge")
        self.assertEqual(result["rows_imported"].get("gsd_audit_log", 0), 0,
                         "Old backup should restore 0 audit rows, not error")
        self.assertEqual(new_store.audit_count(), 0)


if __name__ == "__main__":
    unittest.main()
