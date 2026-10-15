-- ============================================================================
-- Vehicles and parking (ADR 0045): a unit's vehicles, their stickers and
-- permits, the compound's settings, and the numbers its records carry.
--
-- A vehicle is the unit's; who registered it is recorded and, once erased,
-- points at the tombstone. It is `pending` until the staff approve it
-- (a sticker and the last local day of its permit: `active`) or reject it
-- with a reason code. A plate edit sends it back to `pending` and voids its
-- sticker; a removal (by the unit, the staff, or the system when the
-- registrant no longer lives there) is final. One active permit per plate
-- in a compound. A sticker's number is issued once, forever: a revoked one
-- is never valid again on another car.
-- ============================================================================

CREATE TYPE "vehicle_type" AS ENUM ('car', 'motorcycle', 'van');
CREATE TYPE "vehicle_status" AS ENUM ('pending', 'active', 'rejected', 'removed');
CREATE TYPE "vehicle_removal_side" AS ENUM ('resident', 'staff', 'system');
CREATE TYPE "vehicle_counter_kind" AS ENUM ('vehicle', 'parking_booking', 'fine', 'parking_report');

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicle_settings" (
    "tenant_id" UUID NOT NULL,
    "max_vehicles_per_unit" INTEGER NOT NULL DEFAULT 4,
    "visitor_parking_max_hours" INTEGER NOT NULL DEFAULT 12,
    "max_active_visitor_parking_bookings" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vehicle_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "vehicle_settings" ADD CONSTRAINT "vehicle_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicle_settings" ADD CONSTRAINT "vehicle_settings_ranges"
  CHECK ("max_vehicles_per_unit" BETWEEN 1 AND 20
     AND "visitor_parking_max_hours" BETWEEN 1 AND 24
     AND "max_active_visitor_parking_bookings" BETWEEN 1 AND 20);

-- ----------------------------------------------------------------------------
-- The numbers a compound's vehicles, visitor parking bookings, fines and
-- parking reports carry (V-, P-, F-, R-), each taken under its counter's
-- row lock, last in every transaction. A rollback gives the number back.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicle_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" "vehicle_counter_kind" NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "vehicle_counters_pkey" PRIMARY KEY ("tenant_id", "kind")
);
ALTER TABLE "vehicle_counters" ADD CONSTRAINT "vehicle_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicle_counters" ADD CONSTRAINT "vehicle_counters_last_number"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- Vehicles.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "registered_by_account_id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "plate_key" TEXT GENERATED ALWAYS AS (
      translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789')
    ) STORED,
    "make_and_model" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "type" "vehicle_type" NOT NULL,
    "status" "vehicle_status" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sticker_number" TEXT,
    "permit_valid_until" DATE,
    "rejection_reason" TEXT,
    "licence_photo_file_id" UUID,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    "removal_side" "vehicle_removal_side",
    "removal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicles_tenant_id_id_key" ON "vehicles"("tenant_id", "id");
CREATE UNIQUE INDEX "vehicles_number_key" ON "vehicles"("tenant_id", "number");
-- One active permit per plate in a compound.
CREATE UNIQUE INDEX "vehicles_one_active_plate"
  ON "vehicles"("tenant_id", "plate_key") WHERE "status" = 'active';
CREATE INDEX "vehicles_unit_idx" ON "vehicles"("tenant_id", "unit_id", "status");
CREATE INDEX "vehicles_status_idx" ON "vehicles"("tenant_id", "status", "created_at", "id");
CREATE INDEX "vehicles_plate_key_idx" ON "vehicles"("tenant_id", "plate_key");
CREATE INDEX "vehicles_registrant_idx" ON "vehicles"("tenant_id", "registered_by_account_id");
-- The licence photos the sweep deletes 30 days after a removal.
CREATE INDEX "vehicles_photo_due_idx" ON "vehicles"("tenant_id", "removed_at")
  WHERE "licence_photo_file_id" IS NOT NULL AND "removed_at" IS NOT NULL;
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicles_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicles_tenant_id_registered_by_fkey"
  FOREIGN KEY ("tenant_id", "registered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicles_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicles_tenant_id_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicles_tenant_id_licence_photo_fkey"
  FOREIGN KEY ("tenant_id", "licence_photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_text_length"
  CHECK (char_length("plate") BETWEEN 1 AND 12
     AND char_length("make_and_model") BETWEEN 1 AND 60
     AND char_length("color") BETWEEN 1 AND 30);
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_version_positive"
  CHECK ("version" >= 1);
-- Nullable columns only under IS [NOT] NULL; status is NOT NULL.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_state_shape"
  CHECK (("status" = 'active') = ("sticker_number" IS NOT NULL)
     AND ("status" = 'active') = ("permit_valid_until" IS NOT NULL)
     AND ("status" = 'rejected') = ("rejection_reason" IS NOT NULL)
     AND ("status" = 'removed') = ("removed_at" IS NOT NULL)
     AND ("removed_at" IS NULL) = ("removal_side" IS NULL)
     AND ("removed_at" IS NULL) = ("removal_reason" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL));
-- The system removes without an account; a person always with theirs.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_removed_by"
  CHECK ("removal_side" IS NULL
      OR ("removal_side" = 'system') = ("removed_by_account_id" IS NULL));
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_sticker_shape"
  CHECK ("sticker_number" IS NULL OR "sticker_number" ~ '^[A-Z0-9-]{1,20}$');
-- REASON_CODES.vehicleReject; a unit test keeps the two in step.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_rejection_reason"
  CHECK ("rejection_reason" IS NULL
      OR "rejection_reason" IN ('licence_missing', 'licence_unreadable', 'plate_mismatch',
                                'not_resident_vehicle', 'other'));
-- REASON_CODES.vehicleRemove, vehicleStaffRemove, vehicleSystemRemove, by side.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_removal_reason"
  CHECK ("removal_reason" IS NULL
      OR ("removal_side" = 'resident'
          AND "removal_reason" IN ('sold', 'no_longer_used', 'registered_in_error', 'other'))
      OR ("removal_side" = 'staff'
          AND "removal_reason" IN ('permit_revoked', 'vehicle_left_compound', 'duplicate', 'other'))
      OR ("removal_side" = 'system' AND "removal_reason" IN ('registrant_left')));

-- ----------------------------------------------------------------------------
-- Stickers: append-only. A number is issued once in a compound, to one
-- vehicle; the vehicle's own sticker must be one issued to it.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicle_stickers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "sticker_number" TEXT NOT NULL,
    "issued_by_account_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehicle_stickers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_stickers_tenant_id_id_key" ON "vehicle_stickers"("tenant_id", "id");
CREATE UNIQUE INDEX "vehicle_stickers_number_key" ON "vehicle_stickers"("tenant_id", "sticker_number");
CREATE UNIQUE INDEX "vehicle_stickers_vehicle_number_key"
  ON "vehicle_stickers"("tenant_id", "vehicle_id", "sticker_number");
ALTER TABLE "vehicle_stickers"
  ADD CONSTRAINT "vehicle_stickers_tenant_id_vehicle_id_fkey"
  FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_stickers_tenant_id_issued_by_fkey"
  FOREIGN KEY ("tenant_id", "issued_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicle_stickers" ADD CONSTRAINT "vehicle_stickers_number_shape"
  CHECK ("sticker_number" ~ '^[A-Z0-9-]{1,20}$');
CREATE TRIGGER vehicle_stickers_immutable_rows
  BEFORE UPDATE OR DELETE ON "vehicle_stickers"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER vehicle_stickers_immutable_truncate
  BEFORE TRUNCATE ON "vehicle_stickers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_sticker_issued_fkey"
  FOREIGN KEY ("tenant_id", "id", "sticker_number")
  REFERENCES "vehicle_stickers"("tenant_id", "vehicle_id", "sticker_number")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- A vehicle keeps its unit, its number and who registered it; a removal is
-- final, and after it only the licence photo's pointer goes (the sweep).
-- ----------------------------------------------------------------------------
CREATE FUNCTION vehicle_keeps_its_identity() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."registered_by_account_id" = OLD."registered_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (
       OLD."status" <> 'removed'
       OR (NEW."status" = OLD."status"
           AND NEW."plate" = OLD."plate"
           AND NEW."make_and_model" = OLD."make_and_model"
           AND NEW."color" = OLD."color"
           AND NEW."type" = OLD."type"
           AND NEW."version" = OLD."version"
           AND NEW."sticker_number" IS NOT DISTINCT FROM OLD."sticker_number"
           AND NEW."permit_valid_until" IS NOT DISTINCT FROM OLD."permit_valid_until"
           AND NEW."rejection_reason" IS NOT DISTINCT FROM OLD."rejection_reason"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."removed_at" = OLD."removed_at"
           AND NEW."removed_by_account_id" IS NOT DISTINCT FROM OLD."removed_by_account_id"
           AND NEW."removal_side" = OLD."removal_side"
           AND NEW."removal_reason" = OLD."removal_reason"
           AND (NEW."licence_photo_file_id" IS NOT DISTINCT FROM OLD."licence_photo_file_id"
                OR NEW."licence_photo_file_id" IS NULL))
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vehicles: a vehicle keeps its unit, number and registrant, and a removal is final (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER vehicles_keep_identity
  BEFORE UPDATE OR DELETE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION vehicle_keeps_its_identity();
CREATE TRIGGER vehicles_keep_identity_truncate
  BEFORE TRUNCATE ON "vehicles"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The permit-expiring notice: once per vehicle and last day. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicle_expiry_reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "valid_until" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehicle_expiry_reminders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_expiry_reminders_once"
  ON "vehicle_expiry_reminders"("tenant_id", "vehicle_id", "valid_until");
ALTER TABLE "vehicle_expiry_reminders"
  ADD CONSTRAINT "vehicle_expiry_reminders_tenant_id_vehicle_id_fkey"
  FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER vehicle_expiry_reminders_immutable_rows
  BEFORE UPDATE OR DELETE ON "vehicle_expiry_reminders"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER vehicle_expiry_reminders_immutable_truncate
  BEFORE TRUNCATE ON "vehicle_expiry_reminders"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted; stickers and reminders are
-- never updated either.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "vehicle_settings", "vehicle_counters", "vehicles", "vehicle_stickers",
  "vehicle_expiry_reminders" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "vehicle_settings", "vehicle_counters", "vehicles" TO jiwar_app;
GRANT SELECT, INSERT ON "vehicle_stickers", "vehicle_expiry_reminders" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle_settings', 'vehicle_counters', 'vehicles',
                           'vehicle_stickers', 'vehicle_expiry_reminders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/gate/vehicles/
-- vehicle-provisioning.ts): the settings row. FORCE RLS applies here too:
-- one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "vehicle_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
