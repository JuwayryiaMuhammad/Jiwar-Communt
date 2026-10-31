-- ============================================================================
-- Daily life (ADR 0071): how busy each gate is — the entries it logged in
-- the last fifteen minutes, as a level: `quiet` below
-- `gate_busy_normal_from`, `busy` from `gate_busy_busy_from`, `normal`
-- between. Levels only, never counts. Residents' own entries are never
-- logged (ADR 0031), so this is visitors, workers and the like.
-- Existing rows take the defaults.
-- ============================================================================

ALTER TABLE "gate_settings"
  ADD COLUMN "gate_busy_normal_from" SMALLINT NOT NULL DEFAULT 10,
  ADD COLUMN "gate_busy_busy_from" SMALLINT NOT NULL DEFAULT 30;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_busy_levels"
  CHECK ("gate_busy_normal_from" BETWEEN 1 AND 1000
     AND "gate_busy_busy_from" BETWEEN 2 AND 1000
     AND "gate_busy_busy_from" > "gate_busy_normal_from");
