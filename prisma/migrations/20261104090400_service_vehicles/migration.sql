-- ============================================================================
-- Service vehicles (ADR 0056): tankers, waste trucks, deliveries and others,
-- recorded at the gate by a guard on shift, in and out: the plate (with its
-- key, folded as every plate key, ADR 0045), the kind, the company, and the
-- unit or the facility served when there is one.
--
-- A visit, not gate entries: a service vehicle may serve no unit, and every
-- gate entry names one. One row per visit: its entry, then its exit once —
-- by a guard, or by the system as unconfirmed after
-- GATE_UNCONFIRMED_EXIT_HOURS (as every subject still "inside"). A plate is
-- inside once at a time. The blocklist meets the plate as any other: a ban
-- refuses the entry, a watch flags it.
-- ============================================================================

CREATE TABLE "service_vehicle_visits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "plate_key" TEXT GENERATED ALWAYS AS (translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')) STORED,
    "kind" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "unit_id" UUID,
    "facility_id" UUID,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "entered_gate_id" UUID NOT NULL,
    "entered_shift_id" UUID NOT NULL,
    "entered_by_account_id" UUID NOT NULL,
    "exited_at" TIMESTAMPTZ(3),
    "exited_gate_id" UUID,
    "exited_shift_id" UUID,
    "exited_by_account_id" UUID,
    "exit_unconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_vehicle_visits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_vehicle_visits_tenant_id_id_key"
  ON "service_vehicle_visits"("tenant_id", "id");
-- A plate is inside once at a time.
CREATE UNIQUE INDEX "service_vehicle_visits_one_inside"
  ON "service_vehicle_visits"("tenant_id", "plate_key") WHERE "exited_at" IS NULL;
-- The gate's open list, the reports' days.
CREATE INDEX "service_vehicle_visits_inside_idx"
  ON "service_vehicle_visits"("tenant_id", "entered_at" DESC, "id" DESC) WHERE "exited_at" IS NULL;
CREATE INDEX "service_vehicle_visits_day_idx"
  ON "service_vehicle_visits"("tenant_id", "entered_gate_id", "entered_at");

ALTER TABLE "service_vehicle_visits"
  ADD CONSTRAINT "service_vehicle_visits_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_tenant_id_facility_id_fkey"
    FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_entered_gate_fkey"
    FOREIGN KEY ("tenant_id", "entered_gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_entered_shift_fkey"
    FOREIGN KEY ("tenant_id", "entered_shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_entered_by_fkey"
    FOREIGN KEY ("tenant_id", "entered_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_exited_gate_fkey"
    FOREIGN KEY ("tenant_id", "exited_gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_exited_shift_fkey"
    FOREIGN KEY ("tenant_id", "exited_shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "service_vehicle_visits_exited_by_fkey"
    FOREIGN KEY ("tenant_id", "exited_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "service_vehicle_visits"
  ADD CONSTRAINT "service_vehicle_visits_kind"
    CHECK ("kind" IN ('tanker', 'waste', 'delivery', 'other')),
  -- As every plate is kept: tidied, at most 12 (the code's PLATE_MAX).
  ADD CONSTRAINT "service_vehicle_visits_plate"
    CHECK (char_length("plate") BETWEEN 1 AND 12),
  ADD CONSTRAINT "service_vehicle_visits_company"
    CHECK (char_length("company") BETWEEN 1 AND 120),
  -- A unit or a facility served, or neither; never both.
  ADD CONSTRAINT "service_vehicle_visits_served"
    CHECK (num_nonnulls("unit_id", "facility_id") <= 1),
  -- Out: when and where, by a guard on shift or by the system (unconfirmed).
  ADD CONSTRAINT "service_vehicle_visits_exit_shape"
    CHECK (("exited_at" IS NULL) = ("exited_gate_id" IS NULL)
       AND ("exited_shift_id" IS NULL) = ("exited_by_account_id" IS NULL)
       AND ("exited_by_account_id" IS NULL OR "exited_at" IS NOT NULL)
       AND ("exited_at" IS NULL OR "exit_unconfirmed" OR "exited_by_account_id" IS NOT NULL)
       AND (NOT "exit_unconfirmed" OR ("exited_at" IS NOT NULL AND "exited_by_account_id" IS NULL))
       AND ("exited_at" IS NULL OR "exited_at" >= "entered_at"));

-- The entry never changes; the exit is written once. Never deleted.
CREATE FUNCTION service_vehicle_visit_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."plate" = OLD."plate"
     AND NEW."kind" = OLD."kind"
     AND NEW."company" = OLD."company"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."facility_id" IS NOT DISTINCT FROM OLD."facility_id"
     AND NEW."entered_at" = OLD."entered_at"
     AND NEW."entered_gate_id" = OLD."entered_gate_id"
     AND NEW."entered_shift_id" = OLD."entered_shift_id"
     AND NEW."entered_by_account_id" = OLD."entered_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."exited_at" IS NULL
          OR (NEW."exited_at" = OLD."exited_at"
              AND NEW."exited_gate_id" IS NOT DISTINCT FROM OLD."exited_gate_id"
              AND NEW."exited_shift_id" IS NOT DISTINCT FROM OLD."exited_shift_id"
              AND NEW."exited_by_account_id" IS NOT DISTINCT FROM OLD."exited_by_account_id"
              AND NEW."exit_unconfirmed" = OLD."exit_unconfirmed")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'service_vehicle_visits: an entry never changes, its exit is written once, and nothing is deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER service_vehicle_visits_move_forward
  BEFORE UPDATE OR DELETE ON "service_vehicle_visits"
  FOR EACH ROW EXECUTE FUNCTION service_vehicle_visit_moves_forward();
CREATE TRIGGER service_vehicle_visits_move_forward_truncate
  BEFORE TRUNCATE ON "service_vehicle_visits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "service_vehicle_visits" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "service_vehicle_visits" TO jiwar_app;
ALTER TABLE "service_vehicle_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_vehicle_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service_vehicle_visits"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- The blocklist meets a service vehicle's plate at its entry.
-- ----------------------------------------------------------------------------
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_source";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_source"
  CHECK ("source" IN ('visitor_pass', 'move_permit', 'event_guest', 'gate_request', 'verify', 'entry',
                      'plate_lookup', 'id_lookup', 'field_exception', 'service_vehicle'));
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_subject";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_subject"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
     AND ("subject_type" IS NULL
          OR "subject_type" IN ('visitor_pass', 'gate_request', 'event_guest', 'move_permit',
                                'field_exception', 'service_vehicle')));
