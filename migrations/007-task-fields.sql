-- Migration 007: Add 7 fields previously dropped by dual-write mirror
-- These fields exist in tasks.json but were not mirrored to gsd_tasks.
-- All columns are nullable with safe defaults (non-blocking ADD COLUMN).

ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS doc_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS risks JSONB DEFAULT '[]'::jsonb;
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS validation_checklist JSONB DEFAULT '[]'::jsonb;
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS estimated_hours REAL;
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS due_date VARCHAR(32);
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS sprint VARCHAR(64);
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS children JSONB DEFAULT '[]'::jsonb;
