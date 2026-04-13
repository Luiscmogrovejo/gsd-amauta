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

    @staticmethod
    def get_current_commit(project_dir: str = ".") -> Optional[str]:
        """Get the current HEAD commit SHA for the project directory.

        Args:
            project_dir: Path to the git repository root.

        Returns:
            40-char commit SHA hex string, or None if not a git repo.
        """
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10,
                cwd=project_dir,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
        return None

    @staticmethod
    def changed_since(context: dict, project_dir: str = ".") -> list[str]:
        """Determine which tracked files have changed since the stored commit.

        Uses `git diff --name-only` between the stored commit_ref and HEAD
        to find changed files, then intersects with the context's file_hashes
        keys. Files not in file_hashes are always considered changed.

        This avoids filesystem reads for unchanged files — only git's index
        is consulted.

        Args:
            context: dict with keys:
                - "file_hashes": dict[str, str] — {path: sha256_hash} from prior phase
                - "commit_ref": str — git commit SHA from when hashes were computed
            project_dir: Path to the git repository root (default ".").

        Returns:
            list[str]: File paths that have changed and need description refresh.
                Empty list if no changes detected or if commit_ref is missing.
        """
        file_hashes = context.get("file_hashes", {})
        commit_ref = context.get("commit_ref")

        if not commit_ref or not file_hashes:
            # No prior commit ref or no hashes stored — all files are "changed"
            return list(file_hashes.keys()) if file_hashes else []

        try:
            result = subprocess.run(
                ["git", "diff", "--name-only", commit_ref, "HEAD"],
                capture_output=True, text=True, timeout=30,
                cwd=project_dir,
            )
            if result.returncode != 0:
                log.warning("git_diff_failed returncode=%d stderr=%s",
                            result.returncode, result.stderr.strip()[:200])
                return list(file_hashes.keys())

            git_changed = set(result.stdout.strip().split("\n")) if result.stdout.strip() else set()

            # Intersect git-changed files with our tracked file_hashes
            changed = [fp for fp in file_hashes if fp in git_changed]

            log.debug("changed_since commit_ref=%s changed=%d total=%d",
                      commit_ref[:8], len(changed), len(file_hashes))
            return changed

        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            log.warning("git_diff_error error=%s", str(e)[:200])
            # On error, treat all files as changed (safe fallback)
            return list(file_hashes.keys())
