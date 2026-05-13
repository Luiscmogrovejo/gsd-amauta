-- lifecycle-test v0.2.0 expand migration (additive)
-- Used by Phase 49 upgrade tests; runs BEFORE swap_services.
BEGIN;
CREATE TABLE IF NOT EXISTS lifecycle_test_payloads (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lifecycle_test_payloads
  ADD COLUMN IF NOT EXISTS body TEXT;
COMMIT;
