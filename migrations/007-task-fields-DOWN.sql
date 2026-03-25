-- Migration 007 DOWN: Remove 7 fields added by 007-task-fields.sql

ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS doc_refs;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS risks;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS validation_checklist;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS estimated_hours;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS due_date;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS sprint;
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS children;
