-- ============================================================================
-- An asset's warranty, whole (ADR 0076): when it starts (beside its end, ADR
-- 0064), who gives it and what it covers; and the claims made under it.
--
-- A claim is the management's: an asset (and, when it came of one, the ticket
-- whose fault it is), staff's words on what failed, and the warrantor's own
-- reference once they give one. It is decided once: accepted (with what the
-- warrantor paid or covered, if anything), rejected or withdrawn (each with a
-- reason code). One open claim per ticket. Free text (the description, the
-- warrantor's name and what it covers) is plain data: never in the audit
-- trail or a notification.
-- ============================================================================

ALTER TABLE "assets"
  ADD COLUMN "warranty_starts_on" DATE,
  ADD COLUMN "warrantor" TEXT,
  ADD COLUMN "warranty_covers" TEXT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_warranty_shape"
  CHECK (("warranty_starts_on" IS NULL OR "warranty_ends_on" IS NULL
          OR "warranty_starts_on" <= "warranty_ends_on")
     AND ("warrantor" IS NULL OR char_length("warrantor") BETWEEN 1 AND 120)
     AND ("warranty_covers" IS NULL OR char_length("warranty_covers") BETWEEN 1 AND 500));

CREATE TABLE "warranty_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "ticket_id" UUID,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_by_account_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reason_code" TEXT,
    "recovered_amount" DECIMAL(12,2),
    CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warranty_claims_tenant_id_id_key" ON "warranty_claims"("tenant_id", "id");
CREATE INDEX "warranty_claims_asset_idx"
  ON "warranty_claims"("tenant_id", "asset_id", "opened_at" DESC, "id" DESC);
CREATE INDEX "warranty_claims_list_idx"
  ON "warranty_claims"("tenant_id", "status", "opened_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "warranty_claims_one_open_per_ticket"
  ON "warranty_claims"("tenant_id", "ticket_id") WHERE "status" = 'open' AND "ticket_id" IS NOT NULL;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_tenant_id_asset_id_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_status_known"
  CHECK ("status" IN ('open', 'accepted', 'rejected', 'withdrawn'));
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_text_length"
  CHECK (char_length("description") BETWEEN 1 AND 1000
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 80));
-- Open: nobody decided it. Decided: by someone, at a time; a rejection or a
-- withdrawal has its reason code, an acceptance none; only an acceptance
-- says what was recovered.
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_decided_shape"
  CHECK ((("status" = 'open') = ("decided_at" IS NULL))
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" IN ('rejected', 'withdrawn')) = ("reason_code" IS NOT NULL))
     AND ("recovered_amount" IS NULL
          OR ("status" = 'accepted' AND "recovered_amount" >= 0)));

-- Decided once: a decided claim never changes; an open one changes only its
-- reference and its decision.
CREATE FUNCTION "warranty_claims_decided_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'open'
     OR NEW."asset_id" <> OLD."asset_id"
     OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
     OR NEW."description" <> OLD."description"
     OR NEW."opened_by_account_id" <> OLD."opened_by_account_id"
     OR NEW."opened_at" <> OLD."opened_at" THEN
    RAISE EXCEPTION 'a warranty claim is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "warranty_claims_decided_once" BEFORE UPDATE ON "warranty_claims"
  FOR EACH ROW EXECUTE FUNCTION "warranty_claims_decided_once"();

REVOKE ALL ON "warranty_claims" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "warranty_claims" TO jiwar_app;
ALTER TABLE "warranty_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warranty_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "warranty_claims"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
