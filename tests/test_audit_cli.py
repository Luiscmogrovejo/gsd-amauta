#!/usr/bin/env python3
"""Tests for amauta audit CLI subcommand (Phase 9: AUDIT-03, AUDIT-04).

Tests:
  - Parser accepts 'audit export' and 'audit show' subcommands
  - 'audit export --format json' calls /api/audit/export?format=json
  - 'audit export --format csv' calls /api/audit/export?format=csv
  - 'audit export --start X --end Y' passes date params
  - 'audit show TK-0001' calls /api/audit/query?task_id=TK-0001
  - 'audit show TK-0001 --format json' outputs raw JSON
  - daemon unreachable -> sys.exit(1) with message on stderr

Run with:
  python3 tests/test_audit_cli.py
  python3 -m pytest tests/test_audit_cli.py -v
"""
import json
import os
import sys
import unittest
from io import StringIO
from unittest.mock import MagicMock, patch

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

# Add project root so we can import amauta
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import amauta


def _build_args(argv):
    """Parse argv list using build_parser() and return args namespace."""
    p = amauta.build_parser()
    return p.parse_args(argv)


class TestAuditParserRegistration(unittest.TestCase):
    """Parser-level tests: verify subcommands exist and args are registered."""

    def test_audit_export_default_format(self):
        args = _build_args(["audit", "export"])
        self.assertEqual(args.command, "audit")
        self.assertEqual(args.audit_cmd, "export")
        self.assertEqual(args.format, "json")
        self.assertEqual(args.limit, 10000)
        self.assertIsNone(args.start)
        self.assertIsNone(args.end)
        self.assertIsNone(args.output)

    def test_audit_export_csv_format(self):
        args = _build_args(["audit", "export", "--format", "csv"])
        self.assertEqual(args.format, "csv")

    def test_audit_export_date_filters(self):
        args = _build_args(["audit", "export", "--start", "2026-01-01", "--end", "2026-03-31"])
        self.assertEqual(args.start, "2026-01-01")
        self.assertEqual(args.end, "2026-03-31")

    def test_audit_export_limit(self):
        args = _build_args(["audit", "export", "--limit", "500"])
        self.assertEqual(args.limit, 500)

    def test_audit_export_output_file(self):
        args = _build_args(["audit", "export", "--output", "/tmp/audit.json"])
        self.assertEqual(args.output, "/tmp/audit.json")

    def test_audit_show_positional(self):
        args = _build_args(["audit", "show", "TK-0001"])
        self.assertEqual(args.audit_cmd, "show")
        self.assertEqual(args.id, "TK-0001")
        self.assertEqual(args.format, "table")
        self.assertEqual(args.limit, 100)

    def test_audit_show_json_format(self):
        args = _build_args(["audit", "show", "TK-0001", "--format", "json"])
        self.assertEqual(args.format, "json")

    def test_audit_show_limit(self):
        args = _build_args(["audit", "show", "TK-0001", "--limit", "50"])
        self.assertEqual(args.limit, 50)


class TestAuditExportCommand(unittest.TestCase):
    """Functional tests for cmd_audit with export subcommand (daemon mocked)."""

    def _make_mock_response(self, body_dict, content_type="application/json"):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(body_dict).encode("utf-8")
        mock_resp.headers.get.return_value = content_type
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def _make_csv_response(self, csv_text):
        mock_resp = MagicMock()
        mock_resp.read.return_value = csv_text.encode("utf-8")
        mock_resp.headers.get.return_value = "text/csv"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    @patch("urllib.request.urlopen")
    def test_export_json_calls_correct_url(self, mock_urlopen):
        mock_urlopen.return_value = self._make_mock_response({"results": [], "count": 0, "format": "json"})
        args = _build_args(["audit", "export", "--format", "json"])
        captured_url = []

        def capture(req, timeout):
            captured_url.append(req.full_url)
            return mock_urlopen.return_value
        mock_urlopen.side_effect = capture

        with patch("sys.stdout", new_callable=StringIO):
            amauta.cmd_audit(args)

        self.assertTrue(len(captured_url) == 1)
        self.assertIn("/api/audit/export", captured_url[0])
        self.assertIn("format=json", captured_url[0])

    @patch("urllib.request.urlopen")
    def test_export_with_date_filters(self, mock_urlopen):
        mock_urlopen.return_value = self._make_mock_response({"results": [], "count": 0, "format": "json"})
        args = _build_args(["audit", "export", "--start", "2026-01-01", "--end", "2026-03-31"])
        captured_url = []

        def capture(req, timeout):
            captured_url.append(req.full_url)
            return mock_urlopen.return_value
        mock_urlopen.side_effect = capture

        with patch("sys.stdout", new_callable=StringIO):
            amauta.cmd_audit(args)

        self.assertIn("start=2026-01-01", captured_url[0])
        self.assertIn("end=2026-03-31", captured_url[0])

    @patch("urllib.request.urlopen")
    def test_export_csv_outputs_to_stdout(self, mock_urlopen):
        csv_data = "id,task_id,event_type\n1,TK-0001,validation\n"
        mock_urlopen.return_value = self._make_csv_response(csv_data)
        args = _build_args(["audit", "export", "--format", "csv"])

        with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
            def capture(req, timeout):
                return mock_urlopen.return_value
            mock_urlopen.side_effect = capture
            amauta.cmd_audit(args)
            output = mock_stdout.getvalue()

        self.assertIn("task_id", output)
        self.assertIn("TK-0001", output)

    @patch("urllib.request.urlopen")
    def test_export_daemon_unreachable_exits_1(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        args = _build_args(["audit", "export"])

        with patch("sys.stderr", new_callable=StringIO):
            with self.assertRaises(SystemExit) as ctx:
                amauta.cmd_audit(args)
        self.assertEqual(ctx.exception.code, 1)


class TestAuditShowCommand(unittest.TestCase):
    """Functional tests for cmd_audit with show subcommand (daemon mocked)."""

    SAMPLE_RESULTS = [
        {
            "id": 1, "task_id": "TK-0001", "event_type": "validation",
            "actor": "local", "agent_id": "validator", "phase": None,
            "status": "pass", "created_at": "2026-03-23T10:00:00Z",
        },
        {
            "id": 2, "task_id": "TK-0001", "event_type": "rpetd",
            "actor": "local", "agent_id": "executor", "phase": "E",
            "status": None, "created_at": "2026-03-23T10:05:00Z",
        },
    ]

    def _make_mock_response(self, data):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(data).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    @patch("urllib.request.urlopen")
    def test_show_calls_correct_url(self, mock_urlopen):
        mock_urlopen.return_value = self._make_mock_response(
            {"results": self.SAMPLE_RESULTS, "count": 2}
        )
        args = _build_args(["audit", "show", "TK-0001"])
        captured_url = []

        def capture(req, timeout):
            captured_url.append(req.full_url)
            return mock_urlopen.return_value
        mock_urlopen.side_effect = capture

        with patch("sys.stdout", new_callable=StringIO):
            amauta.cmd_audit(args)

        self.assertIn("/api/audit/query", captured_url[0])
        self.assertIn("task_id=TK-0001", captured_url[0])

    @patch("urllib.request.urlopen")
    def test_show_table_contains_event_type(self, mock_urlopen):
        mock_urlopen.return_value = self._make_mock_response(
            {"results": self.SAMPLE_RESULTS, "count": 2}
        )
        args = _build_args(["audit", "show", "TK-0001"])

        with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
            def capture(req, timeout):
                return mock_urlopen.return_value
            mock_urlopen.side_effect = capture
            amauta.cmd_audit(args)
            output = mock_stdout.getvalue()

        self.assertIn("validation", output)
        self.assertIn("rpetd", output)

    @patch("urllib.request.urlopen")
    def test_show_json_format_outputs_raw_json(self, mock_urlopen):
        payload = {"results": self.SAMPLE_RESULTS, "count": 2}
        mock_urlopen.return_value = self._make_mock_response(payload)
        args = _build_args(["audit", "show", "TK-0001", "--format", "json"])

        with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
            def capture(req, timeout):
                return mock_urlopen.return_value
            mock_urlopen.side_effect = capture
            amauta.cmd_audit(args)
            output = mock_stdout.getvalue()

        parsed = json.loads(output)
        self.assertEqual(parsed["count"], 2)
        self.assertEqual(len(parsed["results"]), 2)

    @patch("urllib.request.urlopen")
    def test_show_empty_results(self, mock_urlopen):
        mock_urlopen.return_value = self._make_mock_response({"results": [], "count": 0})
        args = _build_args(["audit", "show", "TK-9999"])

        with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
            def capture(req, timeout):
                return mock_urlopen.return_value
            mock_urlopen.side_effect = capture
            amauta.cmd_audit(args)
            output = mock_stdout.getvalue()

        self.assertIn("no audit records", output)

    @patch("urllib.request.urlopen")
    def test_show_daemon_unreachable_exits_1(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        args = _build_args(["audit", "show", "TK-0001"])

        with patch("sys.stderr", new_callable=StringIO):
            with self.assertRaises(SystemExit) as ctx:
                amauta.cmd_audit(args)
        self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
