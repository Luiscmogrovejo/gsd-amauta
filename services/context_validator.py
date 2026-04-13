#!/usr/bin/env python3
"""
ContextValidator — hash-based staleness detection for RPETD file context.

Phase 21 / STALE-01..04: SHA-256 file hashing + git diff selectively refreshes
only changed files, skipping unchanged file descriptions.

The file_hashes dict is stored in rpetd_context.file_hashes JSONB column
(created by migration 009, pre-provisioned by Phase 20 for Phase 21).
"""

import hashlib
import logging
import os
import subprocess
from typing import Optional

log = logging.getLogger("gsd.context_validator")


class ContextValidator:
    """Hash-based staleness detection for RPETD context files.

    Provides three core operations:
    1. compute_file_hash(path) — SHA-256 hex digest of file contents
    2. changed_since(context, project_dir) — git diff against stored commit ref
    3. selective_refresh(context, stale_files, description_fn) — regenerate only stale descriptions
    """

    @staticmethod
    def compute_file_hash(path: str) -> Optional[str]:
        """Compute SHA-256 hex digest of a file's contents.

        Reads file in binary mode to ensure stable hashes regardless of
        platform line-ending normalization. Returns None if the file does
        not exist or is unreadable.

        Args:
            path: Absolute or relative file path.

        Returns:
            64-char lowercase hex SHA-256 digest, or None if file unreadable.
        """
        try:
            h = hashlib.sha256()
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(8192)
                    if not chunk:
                        break
                    h.update(chunk)
            return h.hexdigest()
        except (OSError, IOError):
            return None
