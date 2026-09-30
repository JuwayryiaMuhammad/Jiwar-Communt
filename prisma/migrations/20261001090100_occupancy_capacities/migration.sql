-- ============================================================================
-- Phase 2.2 — occupancy capacities (ADR 0020).
-- owner + resides = owner-resident; owner + NOT resides = owner-landlord;
-- tenant always resides; an owner on a closed unit = occupant of a closed
-- unit. The owner of several units simply has several occupancies.
-- ============================================================================

CREATE TYPE "occupancy_end_reason" AS ENUM (
  'moved_out', 'contract_ended', 'data_correction', 'other',
  'converted_to_owner', 'ownership_transferred', 'household_ended',
  'account_erased');

ALTER TABLE "unit_occupancies"
  ADD COLUMN "resides" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "end_reason" "occupancy_end_reason",
  -- Free text shown to the person; erasable, never copied to the audit trail.
  ADD COLUMN "end_note" TEXT,
  ADD COLUMN "converted_from_id" UUID,
  ADD COLUMN "primary_since" TIMESTAMPTZ(3),
  ADD COLUMN "handed_over_at" TIMESTAMPTZ(3);

-- Backs the composite FK below (FK checks bypass RLS, ADR 0010).
CREATE UNIQUE INDEX "unit_occupancies_tenant_id_id_key"
  ON "unit_occupancies"("tenant_id", "id");
ALTER TABLE "unit_occupancies"
  ADD CONSTRAINT "unit_occupancies_tenant_id_converted_from_id_fkey"
  FOREIGN KEY ("tenant_id", "converted_from_id")
  REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "units" ADD COLUMN "closed_since" TIMESTAMPTZ(3);

-- Backfill one compound at a time (FORCE RLS applies to the migrator).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "unit_occupancies" SET "end_reason" = 'moved_out'
     WHERE "status" = 'ended';
    UPDATE "unit_occupancies" SET "primary_since" = "started_at"
     WHERE "is_primary";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- A tenant lives in the unit by definition.
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_tenant_resides"
  CHECK ("occupancy_type" = 'owner' OR "resides");
-- A landlord (an owner who does not live there) is never the primary.
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_primary_resides"
  CHECK (NOT "is_primary" OR "resides");
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_end_reason_matches_status"
  CHECK (("status" = 'ended') = ("end_reason" IS NOT NULL));
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_primary_since_matches"
  CHECK ("is_primary" = ("primary_since" IS NOT NULL));
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_handover_after_end"
  CHECK ("handed_over_at" IS NULL OR "status" = 'ended');
