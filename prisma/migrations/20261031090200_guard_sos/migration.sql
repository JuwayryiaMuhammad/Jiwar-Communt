-- ============================================================================
-- Security (ADR 0053): a guard's SOS. An emergency comes from a unit (ADR
-- 0047) or from a guard's post: the gate or the zone of their open shift.
--
-- * `unit_id` becomes nullable; exactly one of the unit, the gate and the
--   zone names where it came from, and a post's emergency names the shift
--   it was raised on.
-- * One open per post and type, as per unit and type: decided under the
--   post's emergency lock, with a partial unique index behind it.
-- * The trigger keeps where it came from: `unit_id` is compared with
--   IS NOT DISTINCT FROM (`=` on a NULL is NULL, and would refuse every
--   update of a post's emergency), and the origin never changes.
-- ============================================================================

ALTER TABLE "emergencies" ALTER COLUMN "unit_id" DROP NOT NULL;
ALTER TABLE "emergencies"
  ADD COLUMN "origin_gate_id" UUID,
  ADD COLUMN "origin_place_id" UUID,
  ADD COLUMN "origin_shift_id" UUID;

ALTER TABLE "emergencies"
  ADD CONSTRAINT "emergencies_tenant_id_origin_gate_fkey"
  FOREIGN KEY ("tenant_id", "origin_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_origin_place_fkey"
  FOREIGN KEY ("tenant_id", "origin_place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_origin_shift_fkey"
  FOREIGN KEY ("tenant_id", "origin_shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- From a unit, or from a post on a shift: one place it came from.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_origin"
  CHECK (num_nonnulls("unit_id", "origin_gate_id", "origin_place_id") = 1
     AND ("origin_shift_id" IS NULL) = ("unit_id" IS NOT NULL));

-- One open emergency per post and type.
CREATE UNIQUE INDEX "emergencies_one_open_at_gate"
  ON "emergencies"("tenant_id", "origin_gate_id", "type")
  WHERE "origin_gate_id" IS NOT NULL AND "status" IN ('reported', 'on_the_way', 'arrived');
CREATE UNIQUE INDEX "emergencies_one_open_in_zone"
  ON "emergencies"("tenant_id", "origin_place_id", "type")
  WHERE "origin_place_id" IS NOT NULL AND "status" IN ('reported', 'on_the_way', 'arrived');

CREATE OR REPLACE FUNCTION emergency_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."origin_gate_id" IS NOT DISTINCT FROM OLD."origin_gate_id"
     AND NEW."origin_place_id" IS NOT DISTINCT FROM OLD."origin_place_id"
     AND NEW."origin_shift_id" IS NOT DISTINCT FROM OLD."origin_shift_id"
     AND NEW."type" = OLD."type"
     AND NEW."reported_by_account_id" = OLD."reported_by_account_id"
     AND NEW."reported_at" = OLD."reported_at"
     AND NEW."responders_notified" = OLD."responders_notified"
     -- Nothing changes once closed.
     AND OLD."closed_at" IS NULL
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'reported' AND NEW."status" IN ('on_the_way', 'resolved', 'cancelled'))
          OR (OLD."status" = 'on_the_way' AND NEW."status" IN ('arrived', 'resolved', 'cancelled'))
          OR (OLD."status" = 'arrived' AND NEW."status" IN ('resolved', 'cancelled')))
     AND ((NEW."escalated_at" IS NOT DISTINCT FROM OLD."escalated_at"
           AND NEW."escalation_reason" IS NOT DISTINCT FROM OLD."escalation_reason")
          OR OLD."escalated_at" IS NULL)
     AND ((NEW."responder_account_id" IS NOT DISTINCT FROM OLD."responder_account_id"
           AND NEW."responder_gate_id" IS NOT DISTINCT FROM OLD."responder_gate_id"
           AND NEW."eta_minutes" IS NOT DISTINCT FROM OLD."eta_minutes"
           AND NEW."accepted_at" IS NOT DISTINCT FROM OLD."accepted_at")
          OR OLD."accepted_at" IS NULL)
     AND (NEW."arrived_at" IS NOT DISTINCT FROM OLD."arrived_at"
          OR OLD."arrived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'emergencies: an emergency only moves forward and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
