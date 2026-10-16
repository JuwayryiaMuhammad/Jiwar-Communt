-- ============================================================================
-- Permits (ADR 0049): a compound's permit rules, one row per compound.
--
-- - work_days: the week days works and moves may take place on (0 = Sunday
--   … 6 = Saturday); Saturday to Thursday by default;
-- - work_from / work_to: the hours, in minutes after local midnight in the
--   compound's time zone, from before to (no overnight window); 09:00–17:00
--   by default;
-- - days_off: dated local days with no works and no moves (feasts), at most
--   100.
--
-- The guard reads them at the time of each entry; a request reads them FOR
-- SHARE, so a change waits for it.
-- ============================================================================

CREATE TABLE "permit_settings" (
    "tenant_id" UUID NOT NULL,
    "work_days" SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,6}',
    "work_from" SMALLINT NOT NULL DEFAULT 540,
    "work_to" SMALLINT NOT NULL DEFAULT 1020,
    "days_off" DATE[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "permit_settings" ADD CONSTRAINT "permit_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- At least one work day, each a week day, no null inside (the service sorts
-- them and drops repeats).
ALTER TABLE "permit_settings" ADD CONSTRAINT "permit_settings_work_days"
  CHECK (cardinality("work_days") BETWEEN 1 AND 7
     AND "work_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[]
     AND array_position("work_days", NULL) IS NULL);
ALTER TABLE "permit_settings" ADD CONSTRAINT "permit_settings_work_hours"
  CHECK ("work_from" >= 0 AND "work_from" < "work_to" AND "work_to" <= 1439);
ALTER TABLE "permit_settings" ADD CONSTRAINT "permit_settings_days_off"
  CHECK (cardinality("days_off") <= 100
     AND array_position("days_off", NULL) IS NULL);

REVOKE ALL ON "permit_settings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "permit_settings" TO jiwar_app;
ALTER TABLE "permit_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permit_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "permit_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/gate/permits/
-- permit-provisioning.ts): the settings row, with the defaults. FORCE RLS
-- applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "permit_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
