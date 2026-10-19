-- ============================================================================
-- The gate's settings (ADR 0056): one row per compound, created with it and
-- backfilled here; managed with `gate.manage`. Each column belongs to one
-- feature, and later migrations add theirs.
--
-- - exception_answer_minutes: how long the management has to answer a
--   field exception before it expires (10 by default);
-- - exception_entry_minutes: how long an approved exception lets its one
--   entry in at its gate (15 by default).
--
-- A write reads the row FOR SHARE when it depends on a value, so a change
-- waits for it; a change locks the row FOR UPDATE.
-- ============================================================================

CREATE TABLE "gate_settings" (
    "tenant_id" UUID NOT NULL,
    "exception_answer_minutes" SMALLINT NOT NULL DEFAULT 10,
    "exception_entry_minutes" SMALLINT NOT NULL DEFAULT 15,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_exception_answer"
  CHECK ("exception_answer_minutes" BETWEEN 1 AND 60);
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_exception_entry"
  CHECK ("exception_entry_minutes" BETWEEN 5 AND 120);

CREATE TRIGGER gate_settings_kept_truncate
  BEFORE TRUNCATE ON "gate_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_settings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_settings" TO jiwar_app;
ALTER TABLE "gate_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/gate/settings/
-- gate-settings-provisioning.ts): the row, with the defaults. FORCE RLS
-- applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "gate_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
