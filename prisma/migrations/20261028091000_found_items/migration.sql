-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the gate's lost-and-found register.
-- ============================================================================
--
-- What security finds, or is handed: what, where, when, photos, who
-- registered it. It is claimed by its owner at the gate, or the
-- management receives it and records the claim at the office. A claimant
-- is a unit (its code at the gate) and/or a name as told; the name goes
-- after 30 days, as a visitor's does (ADR 0028). The residents' board stays
-- the neighbours' (ADR 0042). Nothing is deleted.

CREATE TYPE "found_item_status" AS ENUM ('at_gate', 'with_management', 'claimed');

CREATE TABLE "found_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "place_id" UUID,
    "location" TEXT,
    "found_at" TIMESTAMPTZ(3) NOT NULL,
    "registered_by_account_id" UUID NOT NULL,
    -- The registering guard's shift (and so its post); null at the office.
    "shift_id" UUID,
    "gate_id" UUID,
    "zone_id" UUID,
    "status" "found_item_status" NOT NULL DEFAULT 'at_gate',
    "received_at" TIMESTAMPTZ(3),
    "received_by_account_id" UUID,
    "claimed_at" TIMESTAMPTZ(3),
    "claim_recorded_by_account_id" UUID,
    "claimant_unit_id" UUID,
    "claimant_name" TEXT,
    "claimant_name_expires_at" TIMESTAMPTZ(3),
    "claimant_name_cleared_at" TIMESTAMPTZ(3),
    "claim_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "found_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "found_items_tenant_id_id_key" ON "found_items"("tenant_id", "id");
CREATE INDEX "found_items_status_idx" ON "found_items"("tenant_id", "status", "created_at", "id");
CREATE INDEX "found_items_created_idx" ON "found_items"("tenant_id", "created_at", "id");
CREATE INDEX "found_items_name_due_idx"
  ON "found_items"("tenant_id", "claimant_name_expires_at")
  WHERE "claimant_name" IS NOT NULL;

ALTER TABLE "found_items"
  ADD CONSTRAINT "found_items_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_registered_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "registered_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_zone_id_fkey"
    FOREIGN KEY ("tenant_id", "zone_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_received_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "received_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_claim_recorded_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "claim_recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_items_tenant_id_claimant_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "claimant_unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "found_items"
  ADD CONSTRAINT "found_items_description_length"
    CHECK (char_length("description") BETWEEN 1 AND 500),
  ADD CONSTRAINT "found_items_location_length"
    CHECK ("location" IS NULL OR char_length("location") BETWEEN 1 AND 120),
  ADD CONSTRAINT "found_items_claim_note_length"
    CHECK ("claim_note" IS NULL OR char_length("claim_note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "found_items_claimant_name_length"
    CHECK ("claimant_name" IS NULL OR char_length("claimant_name") BETWEEN 1 AND 80),
  -- Registered at a post through a shift (one post at most), or at the office.
  ADD CONSTRAINT "found_items_post_shape"
    CHECK (num_nonnulls("gate_id", "zone_id") <= 1
           AND ("shift_id" IS NULL) = (num_nonnulls("gate_id", "zone_id") = 0)),
  ADD CONSTRAINT "found_items_found_before_registered"
    CHECK ("found_at" <= "created_at"),
  ADD CONSTRAINT "found_items_received_shape"
    CHECK (("received_at" IS NULL) = ("received_by_account_id" IS NULL)
           AND ("status" <> 'with_management' OR "received_at" IS NOT NULL)),
  -- A claim names who recorded it, and a claimant: a unit, a name, or the
  -- name it had before it went.
  ADD CONSTRAINT "found_items_claimed_shape"
    CHECK (("status" = 'claimed') = ("claimed_at" IS NOT NULL)
           AND ("claimed_at" IS NULL) = ("claim_recorded_by_account_id" IS NULL)
           AND ("claimed_at" IS NULL
                OR num_nonnulls("claimant_unit_id", "claimant_name", "claimant_name_cleared_at") >= 1)
           AND ("claimant_name" IS NULL) = ("claimant_name_expires_at" IS NULL OR "claimant_name_cleared_at" IS NOT NULL)),
  ADD CONSTRAINT "found_items_cleared_shape"
    CHECK ("claimant_name_cleared_at" IS NULL OR "claimant_name" IS NULL);

-- What was found never changes; it moves forward only (at the gate → with
-- the management → claimed, or at the gate → claimed); a claim is recorded
-- once, and its name goes once (retention). Never deleted.
CREATE FUNCTION found_item_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."description" = OLD."description"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."location" IS NOT DISTINCT FROM OLD."location"
     AND NEW."found_at" = OLD."found_at"
     AND NEW."registered_by_account_id" = OLD."registered_by_account_id"
     AND NEW."shift_id" IS NOT DISTINCT FROM OLD."shift_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."zone_id" IS NOT DISTINCT FROM OLD."zone_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'at_gate' AND NEW."status" IN ('with_management', 'claimed'))
          OR (OLD."status" = 'with_management' AND NEW."status" = 'claimed'))
     AND ((NEW."received_at" IS NOT DISTINCT FROM OLD."received_at"
           AND NEW."received_by_account_id" IS NOT DISTINCT FROM OLD."received_by_account_id")
          OR OLD."received_at" IS NULL)
     AND ((NEW."claimed_at" IS NOT DISTINCT FROM OLD."claimed_at"
           AND NEW."claim_recorded_by_account_id" IS NOT DISTINCT FROM OLD."claim_recorded_by_account_id"
           AND NEW."claimant_unit_id" IS NOT DISTINCT FROM OLD."claimant_unit_id"
           AND NEW."claim_note" IS NOT DISTINCT FROM OLD."claim_note"
           AND NEW."claimant_name_expires_at" IS NOT DISTINCT FROM OLD."claimant_name_expires_at"
           AND (NEW."claimant_name" IS NOT DISTINCT FROM OLD."claimant_name"
                AND NEW."claimant_name_cleared_at" IS NOT DISTINCT FROM OLD."claimant_name_cleared_at"
                OR (OLD."claimant_name" IS NOT NULL AND NEW."claimant_name" IS NULL
                    AND OLD."claimant_name_cleared_at" IS NULL
                    AND NEW."claimant_name_cleared_at" IS NOT NULL)))
          OR OLD."claimed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'found_items: what was found never changes; it moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER found_items_move_forward
  BEFORE UPDATE OR DELETE ON "found_items"
  FOR EACH ROW EXECUTE FUNCTION found_item_moves_forward();
CREATE TRIGGER found_items_move_forward_truncate
  BEFORE TRUNCATE ON "found_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "found_item_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "found_item_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "found_item_photos_tenant_id_id_key" ON "found_item_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "found_item_photos_file_id_key" ON "found_item_photos"("file_id");
CREATE INDEX "found_item_photos_item_idx" ON "found_item_photos"("tenant_id", "item_id");
ALTER TABLE "found_item_photos"
  ADD CONSTRAINT "found_item_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_item_photos_tenant_id_item_id_fkey"
    FOREIGN KEY ("tenant_id", "item_id") REFERENCES "found_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_item_photos_tenant_id_file_id_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "found_item_photos_tenant_id_uploaded_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER found_item_photos_immutable
  BEFORE UPDATE OR DELETE ON "found_item_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER found_item_photos_immutable_truncate
  BEFORE TRUNCATE ON "found_item_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "found_items", "found_item_photos" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "found_items" TO jiwar_app;
GRANT SELECT, INSERT ON "found_item_photos" TO jiwar_app;

ALTER TABLE "found_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "found_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "found_items"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "found_item_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "found_item_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "found_item_photos"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
