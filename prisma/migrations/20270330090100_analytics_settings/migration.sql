-- ============================================================================
-- The maintenance analytics' settings (ADR 0081), one row per compound with
-- the rest of its maintenance settings:
--
--   recurrence   a category's repairs on one asset or in one unit within
--                `recurrence_window_days` (90 by default, 7–366): from
--                `recurrence_min_tickets` (3, 2–20) on, a plan suggestion;
--   cases        a category's residents' tickets in one building within
--                `case_window_days` (30, 1–180): from `case_min_tickets`
--                (3, 2–20) on, a community case.
-- ============================================================================

ALTER TABLE "maintenance_settings"
  ADD COLUMN "recurrence_min_tickets" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "recurrence_window_days" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "case_min_tickets" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "case_window_days" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_analytics_range"
  CHECK ("recurrence_min_tickets" BETWEEN 2 AND 20
     AND "recurrence_window_days" BETWEEN 7 AND 366
     AND "case_min_tickets" BETWEEN 2 AND 20
     AND "case_window_days" BETWEEN 1 AND 180);
