BEGIN;
DROP INDEX IF EXISTS idx_module_installs_installed_at;
DROP TABLE IF EXISTS module_installs;
COMMIT;
