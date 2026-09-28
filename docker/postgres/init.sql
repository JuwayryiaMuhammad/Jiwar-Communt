-- ============================================================================
-- Database roles (ADR 0005). Runs once, as the superuser, on an empty volume.
-- ============================================================================
--
-- jiwar_migrator  owns every table and runs `prisma migrate`. It needs
--                 CREATEDB only for the shadow database of `migrate dev`.
-- jiwar_app       the runtime role. Not an owner, not a superuser, and no
--                 BYPASSRLS, so row-level security always applies to it.
--                 It gets DML only, through default privileges below.
--
-- The superuser is used for nothing but this script.

\getenv migrator_password JIWAR_MIGRATOR_PASSWORD
\getenv app_password JIWAR_APP_PASSWORD

CREATE ROLE jiwar_migrator LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE jiwar_app LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD :'app_password';

CREATE DATABASE jiwar OWNER jiwar_migrator;
CREATE DATABASE jiwar_test OWNER jiwar_migrator;

-- Same setup in both databases. Default privileges are per database, and
-- apply to every table jiwar_migrator creates from now on.
\connect jiwar
ALTER SCHEMA public OWNER TO jiwar_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jiwar_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jiwar_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jiwar_app;

\connect jiwar_test
ALTER SCHEMA public OWNER TO jiwar_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jiwar_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jiwar_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jiwar_app;
