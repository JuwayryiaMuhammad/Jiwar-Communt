-- ============================================================================
-- Visiting hours (ADR 0038): when technicians visit units, read in the
-- compound's time zone and cut into slots, for the residents' choice of a
-- new visit time. Every compound gets 08:00–18:00 in one-hour slots (the
-- defaults fill existing rows). A slot is never longer than a visit (4 h,
-- ADR 0034).
-- ============================================================================

ALTER TABLE "maintenance_settings"
  ADD COLUMN "visit_hours_start" INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN "visit_hours_end" INTEGER NOT NULL DEFAULT 1080,
  ADD COLUMN "visit_slot_minutes" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_visit_hours"
  CHECK ("visit_hours_start" BETWEEN 0 AND 1439
     AND "visit_hours_end" BETWEEN 1 AND 1440
     AND "visit_slot_minutes" BETWEEN 15 AND 240
     AND "visit_hours_end" - "visit_hours_start" >= "visit_slot_minutes");
