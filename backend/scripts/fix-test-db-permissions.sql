-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix test DB permissions for buzzma_app_test_user
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run this against the remote PostgreSQL test database
-- as a superuser / database owner to fix "permission denied for table ..." errors.
--
-- The test user needs full CRUD on all tables in buzzma_test schema.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Grant usage on the schema
GRANT USAGE ON SCHEMA buzzma_test TO buzzma_app_test_user;

-- Grant all DML privileges (SELECT, INSERT, UPDATE, DELETE) on ALL existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA buzzma_test TO buzzma_app_test_user;

-- Grant usage on sequences (needed for auto-increment primary keys)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA buzzma_test TO buzzma_app_test_user;

-- Set default privileges so future tables also get the grants automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA buzzma_test
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO buzzma_app_test_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA buzzma_test
  GRANT USAGE, SELECT ON SEQUENCES TO buzzma_app_test_user;
