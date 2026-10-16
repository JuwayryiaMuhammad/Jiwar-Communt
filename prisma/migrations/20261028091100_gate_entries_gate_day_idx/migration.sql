-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the daily report counts a gate's
-- visitors of a day.
-- ============================================================================

CREATE INDEX "gate_entries_gate_day_idx"
  ON "gate_entries"("tenant_id", "gate_id", "occurred_at");
