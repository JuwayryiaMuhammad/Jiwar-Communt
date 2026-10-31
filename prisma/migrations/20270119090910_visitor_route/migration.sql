-- ============================================================================
-- Visitors (ADR 0071): the route before arrival. A gate gains directions in
-- both languages (how to reach it from outside); a pass may name the gate
-- its visitor is expected at; the visitor's public page then shows that
-- gate and its directions, and the parking area of the unit's visitor
-- parking booking linked to the pass (ADR 0045), if any.
-- ============================================================================

ALTER TABLE "gates"
  ADD COLUMN "directions_en" TEXT,
  ADD COLUMN "directions_ar" TEXT;
ALTER TABLE "gates" ADD CONSTRAINT "gates_directions_length"
  CHECK (("directions_en" IS NULL OR char_length("directions_en") BETWEEN 1 AND 500)
     AND ("directions_ar" IS NULL OR char_length("directions_ar") BETWEEN 1 AND 500));

ALTER TABLE "visitor_passes" ADD COLUMN "expected_gate_id" UUID;
ALTER TABLE "visitor_passes"
  ADD CONSTRAINT "visitor_passes_tenant_id_expected_gate_fkey"
  FOREIGN KEY ("tenant_id", "expected_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
