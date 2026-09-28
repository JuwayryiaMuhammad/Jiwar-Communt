-- ============================================================================
-- Schema-level privileges for the runtime role (ADR 0005)
-- ============================================================================
-- init.sql grants these once, on an empty volume. `prisma migrate reset`
-- drops and recreates the public schema, which silently discards them and
-- leaves jiwar_app with "permission denied for schema public". Keeping them
-- in a migration makes every database built from migrations complete.
-- All statements are idempotent.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jiwar_app;

-- Tables created by later migrations get DML for jiwar_app automatically
-- (each migration still grants explicitly as well).
ALTER DEFAULT PRIVILEGES FOR ROLE jiwar_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jiwar_app;
