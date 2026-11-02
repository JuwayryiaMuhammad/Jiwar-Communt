-- ============================================================================
-- The operations dashboard (ADR 0079): the daily brief and the end-of-day
-- review. The dashboard's figures are read from the domains' own tables on
-- request; only two things are kept here:
--
--   staff_dashboard_settings  when a compound's brief and review are written,
--                             minutes after the compound's local midnight
--                             (07:00 and 17:00 by default; NULL: not
--                             written). No row: the defaults.
--   staff_briefs              what each was, once per compound, kind and
--                             local day: counts, shares and amounts of the
--                             compound, never a person, a unit or a word.
--
-- The key (tenant, day, kind) is the "once": two sweeps at once, or a
-- second run the same day, write nothing more and tell nobody twice.
-- ============================================================================

CREATE TABLE "staff_dashboard_settings" (
    "tenant_id" UUID NOT NULL,
    "brief_minute" INTEGER DEFAULT 420,
    "review_minute" INTEGER DEFAULT 1020,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_dashboard_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "staff_dashboard_settings" ADD CONSTRAINT "staff_dashboard_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A minute of the local day; the review after the brief when both are set.
ALTER TABLE "staff_dashboard_settings" ADD CONSTRAINT "staff_dashboard_settings_minutes"
  CHECK (("brief_minute" IS NULL OR "brief_minute" BETWEEN 0 AND 1439)
     AND ("review_minute" IS NULL OR "review_minute" BETWEEN 0 AND 1439)
     AND ("brief_minute" IS NULL OR "review_minute" IS NULL
          OR "review_minute" > "brief_minute"));

CREATE TABLE "staff_briefs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "contents" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "staff_briefs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_briefs_tenant_id_id_key" ON "staff_briefs"("tenant_id", "id");
CREATE UNIQUE INDEX "staff_briefs_day_key" ON "staff_briefs"("tenant_id", "day", "kind");
CREATE INDEX "staff_briefs_list_idx" ON "staff_briefs"("tenant_id", "generated_at", "id");
ALTER TABLE "staff_briefs" ADD CONSTRAINT "staff_briefs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "staff_briefs" ADD CONSTRAINT "staff_briefs_shape"
  CHECK ("kind" IN ('brief', 'review') AND jsonb_typeof("contents") = 'object');
-- Written once; never changed.
CREATE TRIGGER staff_briefs_immutable_rows
  BEFORE UPDATE OR DELETE ON "staff_briefs"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER staff_briefs_immutable_truncate
  BEFORE TRUNCATE ON "staff_briefs"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants and RLS. The settings are set and changed; a brief only added.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "staff_dashboard_settings", "staff_briefs" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "staff_dashboard_settings" TO jiwar_app;
GRANT SELECT, INSERT ON "staff_briefs" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_dashboard_settings', 'staff_briefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
