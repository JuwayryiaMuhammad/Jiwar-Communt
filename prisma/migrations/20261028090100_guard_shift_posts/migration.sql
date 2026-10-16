-- ============================================================================
-- Guard shifts and tasks (ADR 0050): a shift at a gate or in a zone.
-- ============================================================================
--
-- A guard works a post: a gate, or a zone of the compound. Zones are the
-- compound's places (ADR 0047). A zone shift has no gate, so the gate's
-- actions (verify, entries, approvals, parcels, plate lookup) refuse it
-- (SHIFT_NOT_AT_GATE); emergencies and gate services take it.

ALTER TABLE "guard_shifts" ALTER COLUMN "gate_id" DROP NOT NULL;
ALTER TABLE "guard_shifts" ADD COLUMN "place_id" UUID;

ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_tenant_id_place_id_fkey"
  FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Exactly one post.
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_one_post"
  CHECK (num_nonnulls("gate_id", "place_id") = 1);

CREATE INDEX "guard_shifts_tenant_id_place_id_idx"
  ON "guard_shifts"("tenant_id", "place_id");
