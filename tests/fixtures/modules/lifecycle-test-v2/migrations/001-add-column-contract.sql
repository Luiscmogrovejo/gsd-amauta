-- lifecycle-test v0.2.0 contract migration (destructive)
-- Used by Phase 49 upgrade tests; runs AFTER swap_services.
-- Drops the legacy column body_legacy (does not exist in this synthetic
-- fixture -- exercise idempotent IF EXISTS).
BEGIN;
ALTER TABLE IF EXISTS lifecycle_test_payloads
  DROP COLUMN IF EXISTS body_legacy;
COMMIT;
