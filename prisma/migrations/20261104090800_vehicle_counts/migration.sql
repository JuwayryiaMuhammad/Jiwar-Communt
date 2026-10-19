-- ============================================================================
-- Resident vehicles in the traffic report (ADR 0056): counted, never
-- logged. A guard on shift taps "in" or "out" for a vehicle the plate
-- lookup found registered; what is kept is a count per compound day, gate
-- and direction, and nothing else: not the vehicle, its unit or the time,
-- so the report can never be turned into anyone's comings and goings
-- (ADR 0031: a resident's movements are not logged).
--
-- A count only grows, by one at a time.
-- ============================================================================

CREATE TABLE "gate_vehicle_counts" (
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "gate_id" UUID NOT NULL,
    "direction" "gate_direction" NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "gate_vehicle_counts_pkey" PRIMARY KEY ("tenant_id", "day", "gate_id", "direction")
);
ALTER TABLE "gate_vehicle_counts"
  ADD CONSTRAINT "gate_vehicle_counts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_vehicle_counts_gate_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_vehicle_counts" ADD CONSTRAINT "gate_vehicle_counts_positive"
  CHECK ("count" > 0);

CREATE FUNCTION gate_vehicle_count_grows() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."day" = OLD."day"
     AND NEW."gate_id" = OLD."gate_id"
     AND NEW."direction" = OLD."direction"
     AND NEW."count" = OLD."count" + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_vehicle_counts: a count only grows, by one (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_vehicle_counts_grow
  BEFORE UPDATE OR DELETE ON "gate_vehicle_counts"
  FOR EACH ROW EXECUTE FUNCTION gate_vehicle_count_grows();
CREATE TRIGGER gate_vehicle_counts_grow_truncate
  BEFORE TRUNCATE ON "gate_vehicle_counts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_vehicle_counts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_vehicle_counts" TO jiwar_app;
ALTER TABLE "gate_vehicle_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_vehicle_counts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_vehicle_counts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
