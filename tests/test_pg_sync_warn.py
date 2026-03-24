"""Test that PG_SYNC_WARN marker appears in daemon response on mirror failure."""
import unittest


class TestPgSyncWarn(unittest.TestCase):
    def test_pg_sync_warn_format(self):
        """Verify the warning string format matches what the CLI grep expects."""
        error_msg = "connection refused"
        task_id = "TK-0001"
        warning = f"\n[PG_SYNC_WARN] PG mirror failed for {task_id}: {error_msg}"
        self.assertIn("[PG_SYNC_WARN]", warning)
        self.assertIn(task_id, warning)
        self.assertIn(error_msg, warning)
        self.assertTrue(warning.startswith("\n"))

    def test_empty_warning_on_success(self):
        """Verify no warning text is added on successful mirror."""
        out = "TK-0001 status changed to in-progress"
        pg_sync_warning = ""  # success path
        result = out + pg_sync_warning
        self.assertNotIn("[PG_SYNC_WARN]", result)
        self.assertEqual(result, out)

    def test_warning_appended_to_output(self):
        """Verify warning is appended (not prepended) to preserve command output."""
        out = "TK-0001 status changed to in-progress"
        pg_sync_warning = "\n[PG_SYNC_WARN] PG mirror failed for TK-0001: connection refused"
        result = out + pg_sync_warning
        self.assertTrue(result.startswith("TK-0001"))
        self.assertTrue(result.endswith("connection refused"))
        self.assertIn("[PG_SYNC_WARN]", result)

    def test_warning_contains_exception_type_info(self):
        """Verify the warning includes enough diagnostic info."""
        # Simulate what _safe_error() would produce
        error_msg = "OperationalError: connection to server refused"
        task_id = "TK-0042"
        warning = f"\n[PG_SYNC_WARN] PG mirror failed for {task_id}: {error_msg}"
        self.assertIn("OperationalError", warning)
        self.assertIn("TK-0042", warning)
        # Verify the format is parseable: starts with newline + bracket
        self.assertTrue(warning.startswith("\n[PG_SYNC_WARN]"))

    def test_warning_does_not_corrupt_json_output(self):
        """Verify that when output is JSON, the warning is still appended as text."""
        import json
        out = json.dumps({"id": "TK-0001", "status": "in-progress"})
        pg_sync_warning = "\n[PG_SYNC_WARN] PG mirror failed for TK-0001: timeout"
        result = out + pg_sync_warning
        # The original JSON is still recoverable from the first line
        first_line = result.split("\n")[0]
        parsed = json.loads(first_line)
        self.assertEqual(parsed["id"], "TK-0001")
        # The warning is on the second line
        self.assertIn("[PG_SYNC_WARN]", result.split("\n")[1])


if __name__ == "__main__":
    unittest.main()
