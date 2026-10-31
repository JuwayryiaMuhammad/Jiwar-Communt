-- ============================================================================
-- The market (ADR 0071): a resident's small shop — a name in both
-- languages, a few words and a category — under which their listings may
-- appear. One open shop an account. A handler lets it open, turns it down
-- or suspends it with a code, and reinstates it; the owner closes it. Like a
-- listing, a shop names no person: readers see the building it is run from.
--
-- Personal data here: the shop's names and description (the owner's
-- words). An erasure closes the shop and clears them.
-- ============================================================================

CREATE TYPE "market_shop_status" AS ENUM ('pending', 'active', 'suspended', 'closed');

CREATE TABLE "market_shops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "owner_unit_id" UUID NOT NULL,
    "name_en" TEXT,
    "name_ar" TEXT,
    "description" TEXT,
    "category" "market_listing_category" NOT NULL,
    "status" "market_shop_status" NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "reason_code" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "market_shops_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_shops_tenant_id_id_key"
  ON "market_shops"("tenant_id", "id");
-- One open shop an account: checked first under the account's quota lock.
CREATE UNIQUE INDEX "market_shops_one_open"
  ON "market_shops"("tenant_id", "owner_account_id")
  WHERE "status" <> 'closed';
CREATE INDEX "market_shops_status_idx"
  ON "market_shops"("tenant_id", "status", "created_at" DESC, "id" DESC);
ALTER TABLE "market_shops"
  ADD CONSTRAINT "market_shops_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_shops_tenant_id_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_shops_tenant_id_owner_unit_fkey"
  FOREIGN KEY ("tenant_id", "owner_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_shops_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The words: all three, or none once erased.
ALTER TABLE "market_shops" ADD CONSTRAINT "market_shops_erased_shape"
  CHECK (("name_en" IS NULL) = ("erased_at" IS NOT NULL)
     AND ("name_ar" IS NULL) = ("erased_at" IS NOT NULL)
     AND ("description" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "market_shops" ADD CONSTRAINT "market_shops_text_length"
  CHECK (("name_en" IS NULL OR char_length("name_en") BETWEEN 2 AND 60)
     AND ("name_ar" IS NULL OR char_length("name_ar") BETWEEN 2 AND 60)
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500));
-- A decision has its handler and its time; a closed shop its time; a code
-- where the state calls for one, from its closed list.
ALTER TABLE "market_shops" ADD CONSTRAINT "market_shops_state_shape"
  CHECK (("decided_at" IS NULL) = ("decided_by" IS NULL)
     AND (("status" = 'closed') = ("closed_at" IS NOT NULL))
     AND ("status" <> 'suspended' OR "reason_code" IS NOT NULL)
     AND ("status" IN ('suspended', 'closed') OR "reason_code" IS NULL)
     AND ("reason_code" IS NULL
          OR ("status" = 'suspended' AND "reason_code" IN
                ('complaints', 'prohibited_goods', 'inactive', 'other'))
          OR ("status" = 'closed' AND "reason_code" IN
                ('not_allowed', 'incomplete', 'duplicate', 'other',
                 'owner_left', 'owner_erased'))));

-- Whose shop it is and where it is run from never change; a closed shop
-- stays closed, and only an erasure clears its words.
CREATE FUNCTION market_shop_keeps_its_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."owner_account_id" = OLD."owner_account_id"
     AND NEW."owner_unit_id" = OLD."owner_unit_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."erased_at" IS NULL OR NEW."erased_at" IS NOT DISTINCT FROM OLD."erased_at")
     AND (OLD."status" <> 'closed'
          OR (NEW."status" = 'closed'
              AND NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
              AND NEW."reason_code" IS NOT DISTINCT FROM OLD."reason_code"
              AND ((NEW."name_en" IS NOT DISTINCT FROM OLD."name_en"
                    AND NEW."name_ar" IS NOT DISTINCT FROM OLD."name_ar"
                    AND NEW."description" IS NOT DISTINCT FROM OLD."description")
                   OR (NEW."name_en" IS NULL AND NEW."name_ar" IS NULL
                       AND NEW."description" IS NULL AND NEW."erased_at" IS NOT NULL)))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'market_shops: a shop keeps its owner, and a closed one stays closed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER market_shops_keep_owner
  BEFORE UPDATE OR DELETE ON "market_shops"
  FOR EACH ROW EXECUTE FUNCTION market_shop_keeps_its_owner();
CREATE TRIGGER market_shops_keep_owner_truncate
  BEFORE TRUNCATE ON "market_shops"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A listing may appear under its seller's shop (the service checks whose).
ALTER TABLE "market_listings" ADD COLUMN "shop_id" UUID;
ALTER TABLE "market_listings"
  ADD CONSTRAINT "market_listings_tenant_id_shop_fkey"
  FOREIGN KEY ("tenant_id", "shop_id") REFERENCES "market_shops"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "market_listings_shop_idx"
  ON "market_listings"("tenant_id", "shop_id", "status");

REVOKE ALL ON "market_shops" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "market_shops" TO jiwar_app;
ALTER TABLE "market_shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_shops" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "market_shops"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
