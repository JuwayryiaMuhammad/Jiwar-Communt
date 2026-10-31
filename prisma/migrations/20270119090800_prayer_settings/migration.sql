-- ============================================================================
-- Daily life (ADR 0071): where the compound is, for its prayer times. The
-- times are computed on read from the place, the calculation method and the
-- school for Asr (the `adhan` package, MIT); nothing is stored but these.
-- A compound without a place has no prayer times until the manager sets it.
-- Existing rows take the defaults: no place, the Egyptian method, Shafi Asr.
-- ============================================================================

ALTER TABLE "engagement_settings"
  ADD COLUMN "latitude" DECIMAL(9,6),
  ADD COLUMN "longitude" DECIMAL(9,6),
  ADD COLUMN "prayer_method" TEXT NOT NULL DEFAULT 'egyptian',
  ADD COLUMN "asr_madhab" TEXT NOT NULL DEFAULT 'shafi';

-- A place is both coordinates or neither, each in range.
ALTER TABLE "engagement_settings" ADD CONSTRAINT "engagement_settings_place"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL)
     AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90)
     AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180));
ALTER TABLE "engagement_settings" ADD CONSTRAINT "engagement_settings_prayer"
  CHECK ("prayer_method" IN ('egyptian', 'muslim_world_league', 'umm_al_qura',
                             'karachi', 'dubai', 'qatar', 'kuwait')
     AND "asr_madhab" IN ('shafi', 'hanafi'));
