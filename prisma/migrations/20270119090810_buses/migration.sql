-- ============================================================================
-- Daily life (ADR 0071): the compound's buses — named routes and their
-- departures, each on some weekdays at a local time of day, from a stop to a
-- stop. The manager keeps them (`content.manage`); residents read the
-- timetable and the next departures, also in the daily brief. A timetable,
-- not a record: a departure is deleted when it no longer runs, and a route is
-- retired with `active`.
-- ============================================================================

CREATE TABLE "bus_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bus_routes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bus_routes_tenant_id_id_key" ON "bus_routes"("tenant_id", "id");
ALTER TABLE "bus_routes"
  ADD CONSTRAINT "bus_routes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "bus_routes" ADD CONSTRAINT "bus_routes_name_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);

-- `weekdays`: a bit a day, Sunday the lowest (1) to Saturday (64).
-- `departs_minute`: the local time of day, minutes after midnight.
CREATE TABLE "bus_departures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "weekdays" INTEGER NOT NULL,
    "departs_minute" INTEGER NOT NULL,
    "from_stop" TEXT NOT NULL,
    "to_stop" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bus_departures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bus_departures_tenant_id_id_key" ON "bus_departures"("tenant_id", "id");
CREATE INDEX "bus_departures_route_idx"
  ON "bus_departures"("tenant_id", "route_id", "departs_minute");
ALTER TABLE "bus_departures"
  ADD CONSTRAINT "bus_departures_tenant_id_route_fkey"
  FOREIGN KEY ("tenant_id", "route_id") REFERENCES "bus_routes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "bus_departures" ADD CONSTRAINT "bus_departures_shape"
  CHECK ("weekdays" BETWEEN 1 AND 127
     AND "departs_minute" BETWEEN 0 AND 1439
     AND char_length("from_stop") BETWEEN 1 AND 80
     AND char_length("to_stop") BETWEEN 1 AND 80);

REVOKE ALL ON "bus_routes", "bus_departures" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "bus_routes" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "bus_departures" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bus_routes', 'bus_departures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
