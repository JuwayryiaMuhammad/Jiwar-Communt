-- ============================================================================
-- The market (ADR 0071): what residents sell, give away, want or offer, and
-- a unit an owner sells or lets. A listing names no seller: the others read
-- "a resident of building X", and write to the seller through the
-- neighbours' masked conversation (the next migration). The compound's
-- handlers review a listing before it goes live (on by default), take one
-- off with a reason code, and a listing reported by enough units leaves the
-- market for review on its own.
--
-- Personal data here: a listing's `title` and `body` (the seller's words).
-- An erasure clears both and withdraws the listing; the row stays, pointing
-- at the tombstone. A unit listing shows the unit's type, area, building and
-- floor, never its code.
-- ============================================================================

CREATE TYPE "market_listing_kind" AS ENUM ('sell', 'give', 'wanted', 'service', 'unit_sale', 'unit_rent');
CREATE TYPE "market_listing_category" AS ENUM (
  'furniture', 'electronics', 'appliances', 'clothing', 'kids', 'books',
  'sports', 'vehicles', 'home_garden', 'services', 'food', 'real_estate', 'other');
CREATE TYPE "market_listing_status" AS ENUM (
  'pending_review', 'live', 'under_review', 'rejected', 'removed', 'withdrawn', 'sold', 'expired');

-- ----------------------------------------------------------------------------
-- A compound's market settings: one row, created with the compound.
-- `requires_review`: a new or edited listing waits for a handler first.
-- `max_live_per_account`: listings an account may have pending, live or under
-- review at once. `expiry_days`: how long a listing stays live.
-- `report_hide_threshold`: how many distinct units' reports take a live
-- listing off the market for review.
-- ----------------------------------------------------------------------------
CREATE TABLE "market_settings" (
    "tenant_id" UUID NOT NULL,
    "requires_review" BOOLEAN NOT NULL DEFAULT true,
    "max_live_per_account" INTEGER NOT NULL DEFAULT 10,
    "expiry_days" INTEGER NOT NULL DEFAULT 30,
    "report_hide_threshold" INTEGER NOT NULL DEFAULT 3,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_ranges"
  CHECK ("max_live_per_account" BETWEEN 1 AND 50
     AND "expiry_days" BETWEEN 1 AND 180
     AND "report_hide_threshold" BETWEEN 1 AND 20);

-- ----------------------------------------------------------------------------
-- A listing. `seller_unit_id` is the unit the seller listed from, for its
-- building alone; `unit_id` is the unit for sale or to let (its owner's).
--
-- Its life: `pending_review` (when the compound reviews) → `live`, or
-- `rejected` with a code; `live` → `under_review` (reported by enough units)
-- → `live` again or `removed`; `live` → `withdrawn` (by the seller, or by the
-- system when the seller left or was erased, or when the owner's occupancy
-- of a listed unit ended), `sold` (the seller says so), `expired` (its day
-- passed), `removed` (a handler, with a code). Every end is final.
-- `decided_*` is the handler's last decision; `reason_code` the end's code.
-- ----------------------------------------------------------------------------
CREATE TABLE "market_listings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "market_listing_kind" NOT NULL,
    "category" "market_listing_category" NOT NULL,
    "seller_account_id" UUID NOT NULL,
    "seller_unit_id" UUID NOT NULL,
    "unit_id" UUID,
    "title" TEXT,
    "body" TEXT,
    "price" DECIMAL(12,2),
    "negotiable" BOOLEAN NOT NULL DEFAULT false,
    "status" "market_listing_status" NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "expiry_notified_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "reason_code" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", ''))) STORED,
    CONSTRAINT "market_listings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_listings_tenant_id_id_key"
  ON "market_listings"("tenant_id", "id");
-- One live listing a unit and a kind: checked first under the unit's lock.
CREATE UNIQUE INDEX "market_listings_one_per_unit"
  ON "market_listings"("tenant_id", "unit_id", "kind")
  WHERE "unit_id" IS NOT NULL AND "status" IN ('pending_review', 'live', 'under_review');
CREATE INDEX "market_listings_market_idx"
  ON "market_listings"("tenant_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "market_listings_seller_idx"
  ON "market_listings"("tenant_id", "seller_account_id", "created_at" DESC, "id" DESC);
CREATE INDEX "market_listings_expiry_idx"
  ON "market_listings"("tenant_id", "status", "expires_at");
CREATE INDEX "market_listings_search_idx"
  ON "market_listings" USING GIN ("search");
ALTER TABLE "market_listings"
  ADD CONSTRAINT "market_listings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listings_tenant_id_seller_fkey"
  FOREIGN KEY ("tenant_id", "seller_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listings_tenant_id_seller_unit_fkey"
  FOREIGN KEY ("tenant_id", "seller_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listings_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listings_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The words: both, or neither once erased.
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_erased_shape"
  CHECK (("title" IS NULL) = ("erased_at" IS NOT NULL)
     AND ("body" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_text_length"
  CHECK (("title" IS NULL OR char_length("title") BETWEEN 3 AND 80)
     AND ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000));
-- A unit for sale or to let is real estate and names its unit; nothing else
-- does. Selling and a unit carry a price; a gift never does.
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_kind_shape"
  CHECK ((("kind" IN ('unit_sale', 'unit_rent')) = ("unit_id" IS NOT NULL))
     AND (("kind" IN ('unit_sale', 'unit_rent')) = ("category" = 'real_estate'))
     AND ("kind" NOT IN ('sell', 'unit_sale', 'unit_rent') OR "price" IS NOT NULL)
     AND ("kind" <> 'give' OR "price" IS NULL)
     AND ("price" IS NULL OR ("price" > 0 AND "price" <= 1000000000))
     AND ("price" IS NOT NULL OR "negotiable" = false));
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_expires_after_creation"
  CHECK ("expires_at" > "created_at");
-- A decision has its handler and its time; an end its time; a code only where
-- the end calls for one, from its closed list.
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_state_shape"
  CHECK (("decided_at" IS NULL) = ("decided_by" IS NULL)
     AND (("status" IN ('rejected', 'removed', 'withdrawn', 'sold', 'expired')) = ("ended_at" IS NOT NULL))
     AND ("status" NOT IN ('rejected', 'removed') OR ("decided_at" IS NOT NULL AND "reason_code" IS NOT NULL))
     AND ("status" IN ('rejected', 'removed', 'withdrawn') OR "reason_code" IS NULL)
     AND ("reason_code" IS NULL
          OR ("status" = 'rejected' AND "reason_code" IN
                ('prohibited_item', 'misleading', 'wrong_category', 'duplicate', 'incomplete', 'other'))
          OR ("status" = 'removed' AND "reason_code" IN
                ('prohibited_item', 'scam', 'misleading', 'harassment', 'privacy', 'duplicate', 'other'))
          OR ("status" = 'withdrawn' AND "reason_code" IN
                ('seller_left', 'seller_erased', 'owner_left'))));

-- Who sells what, from where, never changes; nor when it was listed. An end
-- is final: the only change after it is an erasure clearing the words.
CREATE FUNCTION market_listing_keeps_its_seller() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."seller_account_id" = OLD."seller_account_id"
     AND NEW."seller_unit_id" = OLD."seller_unit_id"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."erased_at" IS NULL OR NEW."erased_at" IS NOT DISTINCT FROM OLD."erased_at")
     AND (OLD."ended_at" IS NULL
          OR (NEW."status" = OLD."status"
              AND NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
              AND NEW."reason_code" IS NOT DISTINCT FROM OLD."reason_code"
              AND NEW."category" = OLD."category"
              AND NEW."price" IS NOT DISTINCT FROM OLD."price"
              AND NEW."negotiable" = OLD."negotiable"
              AND NEW."expires_at" = OLD."expires_at"
              AND NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
              AND NEW."decided_by" IS NOT DISTINCT FROM OLD."decided_by"
              AND ((NEW."title" IS NOT DISTINCT FROM OLD."title"
                    AND NEW."body" IS NOT DISTINCT FROM OLD."body")
                   OR (NEW."title" IS NULL AND NEW."body" IS NULL
                       AND NEW."erased_at" IS NOT NULL)))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'market_listings: a listing keeps its seller, and an ended one stays ended (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER market_listings_keep_seller
  BEFORE UPDATE OR DELETE ON "market_listings"
  FOR EACH ROW EXECUTE FUNCTION market_listing_keeps_its_seller();
CREATE TRIGGER market_listings_keep_seller_truncate
  BEFORE TRUNCATE ON "market_listings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A listing's photos: at most six (the service counts them), in order. A
-- photo row never changes; it goes only with its file, deleted by an erasure
-- (the lesson of 20261020090600).
-- ----------------------------------------------------------------------------
CREATE TABLE "market_listing_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "market_listing_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_listing_photos_file_id_key"
  ON "market_listing_photos"("file_id");
CREATE UNIQUE INDEX "market_listing_photos_position_key"
  ON "market_listing_photos"("tenant_id", "listing_id", "position");
ALTER TABLE "market_listing_photos"
  ADD CONSTRAINT "market_listing_photos_tenant_id_listing_id_fkey"
  FOREIGN KEY ("tenant_id", "listing_id") REFERENCES "market_listings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listing_photos_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "market_listing_photos" ADD CONSTRAINT "market_listing_photos_position_range"
  CHECK ("position" BETWEEN 0 AND 5);

CREATE FUNCTION market_listing_photo_goes_with_its_file() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
       SELECT 1 FROM "files" f
        WHERE f."tenant_id" = OLD."tenant_id" AND f."id" = OLD."file_id"
          AND f."deleted_at" IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'market_listing_photos: a photo goes only with its deleted file (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER market_listing_photos_immutable_update
  BEFORE UPDATE ON "market_listing_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER market_listing_photos_goes_with_file
  BEFORE DELETE ON "market_listing_photos"
  FOR EACH ROW EXECUTE FUNCTION market_listing_photo_goes_with_its_file();
CREATE TRIGGER market_listing_photos_immutable_truncate
  BEFORE TRUNCATE ON "market_listing_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants and RLS. Listings move in place under FOR UPDATE and are never
-- deleted; settings are read FOR SHARE and changed FOR UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "market_settings", "market_listings", "market_listing_photos" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "market_settings", "market_listings" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "market_listing_photos" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['market_settings', 'market_listings', 'market_listing_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Existing compounds: their settings row, at the defaults.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "market_settings" ("tenant_id") VALUES (t);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
