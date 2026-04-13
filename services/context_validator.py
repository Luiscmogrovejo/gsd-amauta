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

    @staticmethod
    def selective_refresh(context: dict, stale_files: list[str],
                          description_fn=None) -> dict:
        """Regenerate descriptions only for stale files; cache the rest.

        For each file in context["file_hashes"]:
        - If the file is in stale_files, call description_fn(path) to get a
          new description and recompute its SHA-256 hash.
        - If the file is NOT in stale_files, retain the existing description
          and hash verbatim from the context.

        Args:
            context: dict with keys:
                - "file_hashes": dict[str, str] — {path: sha256_hash}
                - "file_descriptions": dict[str, str] — {path: description_text}
            stale_files: list[str] — file paths that need description refresh.
            description_fn: callable(path: str) -> str — function that generates
                a file description. If None, stale files get empty descriptions.

        Returns:
            dict with keys:
                - "file_hashes": dict[str, str] — updated {path: sha256_hash}
                - "file_descriptions": dict[str, str] — updated {path: description}
                - "refreshed_count": int — number of files that were refreshed
                - "cached_count": int — number of files served from cache
                - "commit_ref": str — current HEAD commit SHA (for next cycle)
        """
        old_hashes = context.get("file_hashes", {})
        old_descriptions = context.get("file_descriptions", {})
        stale_set = set(stale_files)

        new_hashes = {}
        new_descriptions = {}
        refreshed_count = 0
        cached_count = 0

        for path in old_hashes:
            if path in stale_set:
                # Recompute hash and regenerate description
                new_hash = ContextValidator.compute_file_hash(path)
                if new_hash is not None:
                    new_hashes[path] = new_hash
                    if description_fn is not None:
                        try:
                            new_descriptions[path] = description_fn(path)
                        except Exception as e:
                            log.warning("description_fn_failed path=%s error=%s",
                                        path, str(e)[:200])
                            new_descriptions[path] = old_descriptions.get(path, "")
                    else:
                        new_descriptions[path] = ""
                    refreshed_count += 1
                else:
                    # File deleted or unreadable — drop from tracking
                    log.debug("file_gone path=%s", path)
            else:
                # Unchanged — retain cached hash and description verbatim
                new_hashes[path] = old_hashes[path]
                new_descriptions[path] = old_descriptions.get(path, "")
                cached_count += 1

        # Get current commit for next cycle's changed_since
        current_commit = ContextValidator.get_current_commit()

        log.info("[STALE] %d files refreshed, %d cached", refreshed_count, cached_count)

        return {
            "file_hashes": new_hashes,
            "file_descriptions": new_descriptions,
            "refreshed_count": refreshed_count,
            "cached_count": cached_count,
            "commit_ref": current_commit or "",
        }

    @staticmethod
    def compute_file_hashes(paths: list[str]) -> dict[str, str]:
        """Compute SHA-256 hashes for a list of file paths.

        Convenience method for initial hash computation when creating
        a new RPETD context (no prior hashes exist).

        Args:
            paths: List of file paths to hash.

        Returns:
            dict[str, str]: {path: sha256_hash} for all readable files.
                Unreadable files are omitted (not included with None).
        """
        hashes = {}
        for path in paths:
            h = ContextValidator.compute_file_hash(path)
            if h is not None:
                hashes[path] = h
        return hashes
