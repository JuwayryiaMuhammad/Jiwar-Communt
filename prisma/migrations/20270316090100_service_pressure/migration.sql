-- ============================================================================
-- Service pressure (ADR 0079): the open tickets against the technicians
-- available to take them. A compound sets how many open tickets one
-- available technician may carry (`open_per_technician`, 1–100; NULL: no
-- alert, the default). When the open tickets reach that many times the
-- available technicians (one at least), the dispatch and the managers are
-- told once; the rise is over when they fall below it again. A rise that
-- comes within an hour of the last notice is told when the hour is up, if
-- it lasts that long: one notice an hour at most (no alert storm).
--
-- One row per compound, made when it first sets a threshold; the sweep
-- keeps the episode on it under the row's lock: when it rose
-- (`raised_at`, NULL when not under pressure), when it was last told
-- (`told_at`; at or after `raised_at`: this rise is told) and when it last
-- eased (`eased_at`). Counts only.
-- ============================================================================

CREATE TABLE "maintenance_service_pressure" (
    "tenant_id" UUID NOT NULL,
    "open_per_technician" INTEGER,
    "raised_at" TIMESTAMPTZ(3),
    "told_at" TIMESTAMPTZ(3),
    "eased_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_service_pressure_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "maintenance_service_pressure" ADD CONSTRAINT "maintenance_service_pressure_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_service_pressure" ADD CONSTRAINT "maintenance_service_pressure_range"
  CHECK ("open_per_technician" IS NULL OR "open_per_technician" BETWEEN 1 AND 100);

REVOKE ALL ON "maintenance_service_pressure" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "maintenance_service_pressure" TO jiwar_app;
ALTER TABLE "maintenance_service_pressure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_service_pressure" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_service_pressure"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
