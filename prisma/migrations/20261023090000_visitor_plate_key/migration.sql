-- ============================================================================
-- Vehicles and parking (ADR 0045): one key to compare plates by.
--
-- A plate is stored as typed, tidied (ADR 0043), so "ق ب ط ١٢٣٤" and
-- "قبط1234" are two strings for one plate. `plate_key` is the plate without
-- its spaces, its Arabic-Indic digits as Western ones; the guard's plate
-- lookup matches a visitor's plate by it. The application never writes it,
-- and computes the same key (src/core/common/vehicle-plate.ts, plateKey).
-- ============================================================================

ALTER TABLE "visitor_details" ADD COLUMN "plate_key" TEXT
  GENERATED ALWAYS AS (
    translate(replace("vehicle_plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789')
  ) STORED;

CREATE INDEX "visitor_details_tenant_id_plate_key_idx"
  ON "visitor_details" ("tenant_id", "plate_key")
  WHERE "plate_key" IS NOT NULL;
