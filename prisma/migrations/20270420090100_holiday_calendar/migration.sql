-- ============================================================================
-- The compound's holiday calendar (ADR 0084): one list of dated holidays,
-- each with its names and whether works and moves stop on it. It takes over
-- the permits' days off (ADR 0049, permit_settings.days_off): each of them
-- becomes a holiday that stops works, and the column goes. Permits read the
-- holidays that stop works exactly as they read the days off; bookings and
-- planned work are only flagged by a holiday, never refused.
--
-- `holiday_calendars` is the compound's lock row: a write to the holidays
-- takes it FOR UPDATE, a permit request FOR SHARE after permit_settings'
-- row (the permits' lock order: the unit, the rules, the calendar, the
-- permit), so a request and a new day off go one after the other, as a
-- request and a change of the days off did. One holiday a day.
-- ============================================================================

CREATE TABLE "holiday_calendars" (
    "tenant_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "compound_holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "stops_works" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "compound_holidays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compound_holidays_tenant_id_id_key" ON "compound_holidays"("tenant_id", "id");
CREATE UNIQUE INDEX "compound_holidays_one_a_day" ON "compound_holidays"("tenant_id", "day");
-- A holiday is of a calendar: the lock row exists for every compound.
ALTER TABLE "compound_holidays" ADD CONSTRAINT "compound_holidays_tenant_id_calendar_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "holiday_calendars"("tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compound_holidays" ADD CONSTRAINT "compound_holidays_names"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);

REVOKE ALL ON "holiday_calendars", "compound_holidays" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "holiday_calendars" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "compound_holidays" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['holiday_calendars', 'compound_holidays'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/core/holidays/
-- holiday-provisioning.ts): the calendar row. Their days off move in as
-- holidays that stop works, named as a day off. FORCE RLS applies here too:
-- one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "holiday_calendars" ("tenant_id") VALUES (t."id");
    INSERT INTO "compound_holidays" ("id", "tenant_id", "day", "name_en", "name_ar", "stops_works", "updated_at")
      SELECT gen_random_uuid(), t."id", d.day, 'Day off', 'يوم عطلة', true, CURRENT_TIMESTAMP
        FROM (SELECT DISTINCT unnest(s."days_off") AS day
                FROM "permit_settings" s WHERE s."tenant_id" = t."id") d
       WHERE d.day IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "permit_settings" DROP CONSTRAINT "permit_settings_days_off";
ALTER TABLE "permit_settings" DROP COLUMN "days_off";
