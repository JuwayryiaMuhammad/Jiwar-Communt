-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the guard closes wrong-parking reports.
-- ============================================================================
--
-- `parking_reports.handle` was offered to every compound with G2 (ADR 0045),
-- so `access:sync`, which grants only never-offered permissions, would not
-- give it to existing guard roles. This grants it once to each compound's
-- system guard role (the default role a new compound gets has it in
-- src/core/access/default-roles.ts) and bumps the role's permissions version,
-- so the versioned cache retires the old set on the guards' next request.
-- No domain reacts to this permission being added (RoleLifecycle).
-- FORCE RLS applies here too: one compound at a time.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    WITH granted AS (
      INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission")
      SELECT r."tenant_id", r."id", 'parking_reports.handle'
        FROM "roles" r
       WHERE r."key" = 'guard' AND r."is_system" AND r."kind" = 'staff'
      ON CONFLICT DO NOTHING
      RETURNING "role_id"
    )
    UPDATE "roles"
       SET "permissions_version" = "permissions_version" + 1,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" IN (SELECT "role_id" FROM granted);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
