-- ============================================================================
-- Scheduled reports (ADR 0086).
--
-- A schedule sends one curated report (the report registry's key, in core)
-- on a cadence of the compound's days: daily (the day before), weekly (the
-- week before, Monday to Sunday) or monthly (the month before), as a PDF, a
-- workbook or CSV, compared with the period before and/or the same period a
-- year earlier. A schedule is made by a holder of `reports.schedule` who
-- may read the report itself; it is paused and resumed, never deleted (its
-- runs name it).
--
-- A run is written once per schedule and period: the key (tenant, schedule,
-- period's first day) with ON CONFLICT DO NOTHING, so two sweeps at once
-- write one file and tell once. Its file (`report_file`) is drawn by the
-- server in the run's transaction; the staff who hold the report's
-- permission then are told, with the report's key and period only, and
-- download the file with their own session. A run keeps its file 90 days,
-- then expires (the file deleted by the files sweep); nothing else of it
-- ever changes.
--
-- A run's file is a PDF, a workbook or CSV of at most 20 MB; the compound's
-- export (20270504090300) a zip of at most 512 MB. The files CHECKs that
-- say so are recreated in 20270609090100, dated after every purpose they
-- name: a CHECK on the purpose enum can name only values that exist when it
-- is made, and ADR 0087's and ADR 0088's purposes come later.
-- ============================================================================

CREATE TABLE "report_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "compare" TEXT NOT NULL DEFAULT 'none',
    "group_by" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_schedules_tenant_id_id_key" ON "report_schedules"("tenant_id", "id");
CREATE INDEX "report_schedules_list_idx" ON "report_schedules"("tenant_id", "created_at", "id");
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_shape"
  CHECK ("report_key" ~ '^[a-z][a-z0-9_]{1,39}$'
     AND "cadence" IN ('daily', 'weekly', 'monthly')
     AND "format" IN ('pdf', 'xlsx', 'csv')
     AND "compare" IN ('none', 'previous', 'last_year', 'both'));
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_group_by_shape"
  CHECK ("group_by" IS NULL OR "group_by" ~ '^[a-z][a-z0-9_]{1,39}$');

-- What a schedule is: its report, cadence and author never change.
CREATE FUNCTION "report_schedules_fixed"() RETURNS trigger AS $$
BEGIN
  IF NEW."report_key" <> OLD."report_key"
     OR NEW."cadence" <> OLD."cadence"
     OR NEW."created_by_account_id" <> OLD."created_by_account_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'a report schedule keeps its report and cadence' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "report_schedules_fixed" BEFORE UPDATE ON "report_schedules"
  FOR EACH ROW EXECUTE FUNCTION "report_schedules_fixed"();

REVOKE ALL ON "report_schedules" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "report_schedules" TO jiwar_app;
ALTER TABLE "report_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_schedules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "report_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "format" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "file_id" UUID,
    "written_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "expired_at" TIMESTAMPTZ(3),
    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_runs_tenant_id_id_key" ON "report_runs"("tenant_id", "id");
-- Once per schedule and period: the sweep's ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX "report_runs_once_per_period" ON "report_runs"("tenant_id", "schedule_id", "period_from");
CREATE INDEX "report_runs_list_idx" ON "report_runs"("tenant_id", "written_at" DESC, "id" DESC);
CREATE INDEX "report_runs_expiry_idx" ON "report_runs"("tenant_id", "status", "expires_at");
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_tenant_id_schedule_id_fkey"
  FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "report_schedules"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_shape"
  CHECK ("period_from" <= "period_to"
     AND "rows" >= 0
     AND "format" IN ('pdf', 'xlsx', 'csv')
     AND "status" IN ('ready', 'expired')
     AND "expires_at" > "written_at");
-- Ready: its file, never expired. Expired: no file any more, and when.
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_status_shape"
  CHECK ((("status" = 'ready') = ("file_id" IS NOT NULL))
     AND (("status" = 'expired') = ("expired_at" IS NOT NULL)));

-- A run is written once; only its expiry changes it, once.
CREATE FUNCTION "report_runs_expire_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'ready'
     OR NEW."status" <> 'expired'
     OR NEW."schedule_id" <> OLD."schedule_id"
     OR NEW."report_key" <> OLD."report_key"
     OR NEW."period_from" <> OLD."period_from"
     OR NEW."period_to" <> OLD."period_to"
     OR NEW."format" <> OLD."format"
     OR NEW."rows" <> OLD."rows"
     OR NEW."written_at" <> OLD."written_at"
     OR NEW."expires_at" <> OLD."expires_at" THEN
    RAISE EXCEPTION 'a report run is written once and expires once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "report_runs_expire_once" BEFORE UPDATE ON "report_runs"
  FOR EACH ROW EXECUTE FUNCTION "report_runs_expire_once"();

REVOKE ALL ON "report_runs" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "report_runs" TO jiwar_app;
ALTER TABLE "report_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_runs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
