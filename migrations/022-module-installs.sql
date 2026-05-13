-- GSD-Amauta Migration 022: module_installs table (Phase 49 MOD-03/MOD-04)
-- Phase 49: Module CLI + Lifecycle
-- Records per-module install state (version, manifest_hash, applied_migrations, ...).
-- Source of truth for idempotency, upgrade detection, and uninstall rollback.

BEGIN;

CREATE TABLE module_installs (
  module_name VARCHAR(64) PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  manifest_hash CHAR(64) NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  upgraded_at TIMESTAMPTZ,
  applied_migrations TEXT[] NOT NULL DEFAULT '{}',
  registered_services TEXT[] NOT NULL DEFAULT '{}',
  installed_agents TEXT[] NOT NULL DEFAULT '{}',
  installed_skills TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_module_installs_installed_at
  ON module_installs (installed_at DESC);

COMMENT ON TABLE module_installs IS
  'Per-module install records — Phase 49 MOD-03/MOD-04. One row per installed module.';
COMMENT ON COLUMN module_installs.manifest_hash IS
  'SHA-256 of canonicalized YAML (yaml.safe_dump(yaml.safe_load(content), sort_keys=True)).';
COMMENT ON COLUMN module_installs.applied_migrations IS
  'Migration file paths applied during install (in order).';

COMMIT;
