-- ============================================================================
-- The field team (ADR 0078): instructions to the technicians.
-- ============================================================================
--
-- An instruction (ADR 0050, 0056) reaches the guards: all of them, a gate's
-- or a zone's. `technicians` reaches every field technician instead, with no
-- post: those holding the work when it is sent, and anyone who goes on duty
-- while it is live (`on_duty`). Each acknowledges it once, as a guard does.

ALTER TABLE "guard_instructions"
  DROP CONSTRAINT "guard_instructions_audience_shape",
  ADD CONSTRAINT "guard_instructions_audience_shape"
    CHECK (("audience" IN ('all', 'technicians') AND "gate_id" IS NULL AND "place_id" IS NULL)
        OR ("audience" = 'gate' AND "gate_id" IS NOT NULL AND "place_id" IS NULL)
        OR ("audience" = 'zone' AND "place_id" IS NOT NULL AND "gate_id" IS NULL));
