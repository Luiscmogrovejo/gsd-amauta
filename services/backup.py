#!/usr/bin/env python3
"""
GSD-Amauta Backup/Restore Service (Phase 8: Data Durability)

Exports all persistent data (memory, tasks, SKB, validations, agent performance)
to compressed JSON. Restores with merge/replace semantics. Verifies integrity
via SHA-256 checksums and count validation.

Works with both PGStore and SQLiteStore via their export_all_* / import_* methods.

DUR-01: amauta backup create
DUR-02: amauta backup restore <file> --mode merge|replace
DUR-03: schema_version in every backup for compatibility checking
DUR-04: amauta backup verify [file]
DUR-05: auto_backup on daemon start (keep last 7)
"""

import glob
import gzip
import hashlib
import json
import os
import time


SCHEMA_VERSION = "2.1.0"
BACKUP_DIR = os.path.expanduser("~/.amauta/backups")


class BackupManager:
    """Manages backup/restore/verify operations for GSD-Amauta stores."""

    def __init__(self, store):
        """Initialize with a PGStore or SQLiteStore instance.

        Args:
            store: A store object implementing export_all_* and import_* methods.
        """
        self.store = store

    # ═══════════════════════════════════════════════════════
    # DUR-01: Create backup
    # ═══════════════════════════════════════════════════════

    def create(self, output_path=None):
        """Export all data to compressed JSON.

        Args:
            output_path: Destination file path. If None, auto-generates in BACKUP_DIR.

        Returns:
            Tuple of (output_path, counts_dict, checksum_hex).
        """
        if not output_path:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            output_path = os.path.join(BACKUP_DIR, f"gsd-backup-{timestamp}.json.gz")

        data = {
            "schema_version": SCHEMA_VERSION,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "tables": {
                "gsd_memory": self._export_table("memory"),
                "gsd_tasks": self._export_table("tasks"),
                "gsd_shared_kb": self._export_table("skb"),
                "gsd_task_validations": self._export_table("validations"),
                "gsd_agent_performance": self._export_table("agent_performance"),
            },
            "counts": {},
            "checksum": None,
        }

        # Calculate counts
        for table, rows in data["tables"].items():
            data["counts"][table] = len(rows)

        # Calculate checksum (of all table data, excluding checksum itself)
        data_for_hash = json.dumps(data["tables"], sort_keys=True, default=str)
        data["checksum"] = hashlib.sha256(data_for_hash.encode("utf-8")).hexdigest()

        # Write compressed
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with gzip.open(output_path, "wt", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)

        return output_path, data["counts"], data["checksum"]

    # ═══════════════════════════════════════════════════════
    # DUR-02: Restore backup
    # ═══════════════════════════════════════════════════════

    def restore(self, input_path, mode="merge"):
        """Import from a backup file.

        Args:
            input_path: Path to a .json.gz backup file.
            mode: 'merge' (add missing rows, skip existing) or
                  'replace' (truncate tables, import all rows).

        Returns:
            Dict with restore results: {tables_restored, rows_imported, mode, schema_version}.

        Raises:
            FileNotFoundError: If input_path does not exist.
            ValueError: If backup is corrupt or schema version is incompatible.
        """
        if not os.path.exists(input_path):
            raise FileNotFoundError(f"Backup file not found: {input_path}")

        data = self._read_backup(input_path)

        # DUR-03: Schema version compatibility check
        backup_version = data.get("schema_version", "unknown")
        if not self._is_version_compatible(backup_version):
            raise ValueError(
                f"Incompatible schema version: backup is {backup_version}, "
                f"current is {SCHEMA_VERSION}. Major version must match."
            )

        # Verify checksum before restoring
        stored_checksum = data.get("checksum")
        if stored_checksum:
            actual_checksum = self._compute_checksum(data["tables"])
            if actual_checksum != stored_checksum:
                raise ValueError(
                    "Backup checksum mismatch -- file may be corrupted. "
                    f"Expected {stored_checksum[:16]}..., got {actual_checksum[:16]}..."
                )

        tables = data.get("tables", {})
        results = {
            "mode": mode,
            "schema_version": backup_version,
            "tables_restored": 0,
            "rows_imported": {},
        }

        # Import each table
        table_importers = {
            "gsd_memory": "import_memory",
            "gsd_tasks": "import_tasks",
            "gsd_shared_kb": "import_skb",
            "gsd_task_validations": "import_validations",
            "gsd_agent_performance": "import_agent_performance",
        }

        for table_name, method_name in table_importers.items():
            rows = tables.get(table_name, [])
            if not rows:
                results["rows_imported"][table_name] = 0
                continue

            importer = getattr(self.store, method_name, None)
            if importer is None:
                # Store doesn't support this table (e.g., SQLite has no agent_performance)
                results["rows_imported"][table_name] = 0
                continue

            try:
                count = importer(rows, mode)
                results["rows_imported"][table_name] = count
                results["tables_restored"] += 1
            except Exception as e:
                results["rows_imported"][table_name] = f"error: {e}"

        return results

    # ═══════════════════════════════════════════════════════
    # DUR-04: Verify backup
    # ═══════════════════════════════════════════════════════

    def verify(self, input_path=None):
        """Verify backup integrity or current database state.

        Args:
            input_path: Path to a backup file to verify. If None, verifies
                       the current database (checks table existence and counts).

        Returns:
            Dict with verification results: {valid, checks, errors}.
        """
        if input_path:
            return self._verify_file(input_path)
        else:
            return self._verify_database()

    def _verify_file(self, input_path):
        """Verify a backup file's integrity."""
        result = {"valid": True, "checks": [], "errors": []}

        # Check file exists
        if not os.path.exists(input_path):
            result["valid"] = False
            result["errors"].append(f"File not found: {input_path}")
            return result
        result["checks"].append("file_exists: ok")

        # Read and decompress
        try:
            data = self._read_backup(input_path)
            result["checks"].append("gzip_decompress: ok")
        except Exception as e:
            result["valid"] = False
            result["errors"].append(f"Failed to read backup: {e}")
            return result

        # Check schema version
        version = data.get("schema_version", "missing")
        if version == "missing":
            result["valid"] = False
            result["errors"].append("Missing schema_version field")
        elif self._is_version_compatible(version):
            result["checks"].append(f"schema_version: {version} (compatible)")
        else:
            result["valid"] = False
            result["errors"].append(
                f"Incompatible schema_version: {version} (current: {SCHEMA_VERSION})"
            )

        # Check required fields
        for field in ("created_at", "tables", "counts", "checksum"):
            if field in data:
                result["checks"].append(f"field_{field}: present")
            else:
                result["valid"] = False
                result["errors"].append(f"Missing required field: {field}")

        # Verify checksum
        stored_checksum = data.get("checksum")
        tables = data.get("tables", {})
        if stored_checksum and tables:
            actual_checksum = self._compute_checksum(tables)
            if actual_checksum == stored_checksum:
                result["checks"].append(f"checksum: valid ({stored_checksum[:16]}...)")
            else:
                result["valid"] = False
                result["errors"].append(
                    f"Checksum mismatch: expected {stored_checksum[:16]}..., "
                    f"got {actual_checksum[:16]}..."
                )

        # Verify counts match actual row counts
        stored_counts = data.get("counts", {})
        for table_name, expected_count in stored_counts.items():
            actual_count = len(tables.get(table_name, []))
            if actual_count == expected_count:
                result["checks"].append(
                    f"count_{table_name}: {actual_count} rows (matches)"
                )
            else:
                result["valid"] = False
                result["errors"].append(
                    f"Count mismatch for {table_name}: header says {expected_count}, "
                    f"actual rows: {actual_count}"
                )

        # File size info
        file_size = os.path.getsize(input_path)
        result["file_size_bytes"] = file_size
        result["file_size_human"] = self._human_size(file_size)
        result["created_at"] = data.get("created_at", "unknown")
        result["schema_version"] = version

        return result

    def _verify_database(self):
        """Verify current database state."""
        result = {"valid": True, "checks": [], "errors": [], "counts": {}}

        # Check store health
        try:
            health = self.store.health()
            if health.get("status") == "ok":
                result["checks"].append("store_health: ok")
            else:
                result["valid"] = False
                result["errors"].append(f"Store unhealthy: {health}")
        except Exception as e:
            result["valid"] = False
            result["errors"].append(f"Store health check failed: {e}")
            return result

        # Check table counts
        try:
            result["counts"]["gsd_memory"] = self.store.memory_count()
            result["checks"].append(
                f"gsd_memory: {result['counts']['gsd_memory']} rows"
            )
        except Exception as e:
            result["errors"].append(f"gsd_memory count failed: {e}")

        try:
            task_counts = self.store.task_count_by_status()
            total_tasks = sum(task_counts.values())
            result["counts"]["gsd_tasks"] = total_tasks
            result["checks"].append(f"gsd_tasks: {total_tasks} rows")
        except Exception as e:
            result["errors"].append(f"gsd_tasks count failed: {e}")

        # Check exportability (can we read all tables?)
        for table_type in ("memory", "tasks", "skb", "validations"):
            method = f"export_all_{table_type}"
            if hasattr(self.store, method):
                result["checks"].append(f"export_{table_type}: available")
            else:
                result["errors"].append(f"export_{table_type}: method not found")

        return result

    # ═══════════════════════════════════════════════════════
    # DUR-05: Auto-backup on daemon start
    # ═══════════════════════════════════════════════════════

    def auto_backup(self):
        """Create daily auto-backup, keep last 7.

        Returns:
            Path to the new backup, or None if already backed up today.
        """
        os.makedirs(BACKUP_DIR, exist_ok=True)
        today = time.strftime("%Y%m%d")
        today_backup = os.path.join(BACKUP_DIR, f"gsd-auto-{today}.json.gz")

        if os.path.exists(today_backup):
            return None  # Already backed up today

        path, counts, checksum = self.create(today_backup)

        # Prune old auto-backups (keep last 7)
        backups = sorted(glob.glob(os.path.join(BACKUP_DIR, "gsd-auto-*.json.gz")))
        while len(backups) > 7:
            oldest = backups.pop(0)
            try:
                os.remove(oldest)
            except OSError:
                pass

        return path

    def list_backups(self):
        """List available backups in BACKUP_DIR.

        Returns:
            List of dicts with {path, filename, size_bytes, size_human, modified}.
        """
        os.makedirs(BACKUP_DIR, exist_ok=True)
        pattern = os.path.join(BACKUP_DIR, "gsd-*.json.gz")
        files = sorted(glob.glob(pattern), reverse=True)

        backups = []
        for f in files:
            stat = os.stat(f)
            backups.append({
                "path": f,
                "filename": os.path.basename(f),
                "size_bytes": stat.st_size,
                "size_human": self._human_size(stat.st_size),
                "modified": time.strftime(
                    "%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)
                ),
            })
        return backups

    # ═══════════════════════════════════════════════════════
    # Internal helpers
    # ═══════════════════════════════════════════════════════

    def _export_table(self, table_type):
        """Export all rows from a table type via store methods.

        Args:
            table_type: One of 'memory', 'tasks', 'skb', 'validations', 'agent_performance'.

        Returns:
            List of dicts (rows), or [] if the method is not available or fails.
        """
        method_name = f"export_all_{table_type}"
        exporter = getattr(self.store, method_name, None)
        if exporter is None:
            return []
        try:
            rows = exporter()
            return rows if rows else []
        except Exception:
            return []

    def _read_backup(self, input_path):
        """Read and decompress a backup file.

        Args:
            input_path: Path to a .json.gz file.

        Returns:
            Parsed JSON dict.
        """
        with gzip.open(input_path, "rt", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _compute_checksum(tables):
        """Compute SHA-256 checksum of table data.

        Args:
            tables: Dict of table_name -> list of row dicts.

        Returns:
            Hex digest string.
        """
        data_for_hash = json.dumps(tables, sort_keys=True, default=str)
        return hashlib.sha256(data_for_hash.encode("utf-8")).hexdigest()

    @staticmethod
    def _is_version_compatible(backup_version):
        """Check if a backup version is compatible with the current schema.

        Compatible means the major version matches (e.g., 2.x.x matches 2.y.z).

        Args:
            backup_version: Version string like "2.1.0".

        Returns:
            True if compatible.
        """
        try:
            backup_major = int(backup_version.split(".")[0])
            current_major = int(SCHEMA_VERSION.split(".")[0])
            return backup_major == current_major
        except (ValueError, IndexError):
            return False

    @staticmethod
    def _human_size(size_bytes):
        """Convert bytes to human-readable size string."""
        for unit in ("B", "KB", "MB", "GB"):
            if size_bytes < 1024:
                return f"{size_bytes:.1f} {unit}"
            size_bytes /= 1024.0
        return f"{size_bytes:.1f} TB"
