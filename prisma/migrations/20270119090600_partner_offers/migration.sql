-- ============================================================================
-- Partner offers (ADR 0071): what a service partner of the compound offers
-- residents for a while — a title and a few words in both languages, from a
-- day to a day. The staff who keep the partners (`partners.manage`) publish
-- and withdraw them; residents read the ones in force, of partners not
-- suspended, on the market. No money passes through Jiwar.
-- ============================================================================

CREATE TABLE "partner_offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "body_en" TEXT NOT NULL,
    "body_ar" TEXT NOT NULL,
    "valid_from_on" DATE NOT NULL,
    "valid_to_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_offers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_offers_tenant_id_id_key"
  ON "partner_offers"("tenant_id", "id");
CREATE INDEX "partner_offers_in_force_idx"
  ON "partner_offers"("tenant_id", "status", "valid_to_on");
CREATE INDEX "partner_offers_partner_idx"
  ON "partner_offers"("tenant_id", "partner_id", "created_at" DESC);
ALTER TABLE "partner_offers"
  ADD CONSTRAINT "partner_offers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_offers_tenant_id_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_offers_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_offers_tenant_id_withdrawn_by_fkey"
  FOREIGN KEY ("tenant_id", "withdrawn_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_text_length"
  CHECK (char_length("title_en") BETWEEN 2 AND 80
     AND char_length("title_ar") BETWEEN 2 AND 80
     AND char_length("body_en") BETWEEN 1 AND 1000
     AND char_length("body_ar") BETWEEN 1 AND 1000);
ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_window"
  CHECK ("valid_to_on" >= "valid_from_on"
     AND "valid_to_on" <= "valid_from_on" + 366);
ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_status_shape"
  CHECK ("status" IN ('active', 'withdrawn')
     AND (("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL))
     AND (("status" = 'withdrawn') = ("withdrawn_by" IS NOT NULL)));

-- An offer is what it was published as; the only change is its withdrawal,
-- once. No DELETE, no TRUNCATE.
CREATE FUNCTION partner_offer_is_withdrawn_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'active' AND NEW."status" = 'withdrawn'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."title_en" = OLD."title_en"
     AND NEW."title_ar" = OLD."title_ar"
     AND NEW."body_en" = OLD."body_en"
     AND NEW."body_ar" = OLD."body_ar"
     AND NEW."valid_from_on" = OLD."valid_from_on"
     AND NEW."valid_to_on" = OLD."valid_to_on"
     AND NEW."created_by" = OLD."created_by"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_offers: an offer only gets withdrawn, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_offers_withdrawn_only
  BEFORE UPDATE OR DELETE ON "partner_offers"
  FOR EACH ROW EXECUTE FUNCTION partner_offer_is_withdrawn_only();
CREATE TRIGGER partner_offers_withdrawn_only_truncate
  BEFORE TRUNCATE ON "partner_offers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "partner_offers" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "partner_offers" TO jiwar_app;
ALTER TABLE "partner_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_offers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "partner_offers"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
