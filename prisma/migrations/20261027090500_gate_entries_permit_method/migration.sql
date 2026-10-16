-- ============================================================================
-- Permits at the gate (ADR 0049): an entry let in against a permit is an
-- `in`, like a code, a QR or an approval; an exit stays the guard's (or the
-- system's). Recreated whole, as 20261004090100_qr_tokens left it plus
-- `permit`.
-- ============================================================================

ALTER TABLE "gate_entries" DROP CONSTRAINT "gate_entries_method_matches_direction";
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_method_matches_direction"
  CHECK (("direction" = 'in') = ("method" IN ('code', 'qr', 'approval', 'permit')));
