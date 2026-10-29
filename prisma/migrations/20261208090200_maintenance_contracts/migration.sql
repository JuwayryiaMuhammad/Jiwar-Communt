-- ============================================================================
-- Maintenance contracts (ADR 0065): the compound's agreements with
-- vendors — an annual maintenance contract, a service contract, an
-- extended warranty — with their dates, their yearly value and the assets
-- they cover. The vendor's name and phone are plain business data, never
-- audited. A contract ends on its date or is terminated earlier, once, with
-- a reason; its end is announced once per end date, `notice_days` before.
-- A contract's papers are maintenance documents of it.
-- ============================================================================

CREATE TABLE "maintenance_contracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "vendor_phone" TEXT,
    "scope" TEXT,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "annual_value" DECIMAL(12,2),
    "notice_days" INTEGER NOT NULL DEFAULT 30,
    "terminated_at" TIMESTAMPTZ(3),
    "terminated_by_account_id" UUID,
    "termination_reason" TEXT,
    "expiry_alerted_for" DATE,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_contracts_tenant_id_id_key" ON "maintenance_contracts"("tenant_id", "id");
CREATE UNIQUE INDEX "maintenance_contracts_tenant_id_code_key" ON "maintenance_contracts"("tenant_id", "code");
CREATE INDEX "maintenance_contracts_list_idx" ON "maintenance_contracts"("tenant_id", "ends_on", "id");
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_terminated_by_fkey"
  FOREIGN KEY ("tenant_id", "terminated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_code_shape"
  CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
-- CONTRACT_KINDS in src/maintenance/contracts/contract-rules.ts.
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_kind_known"
  CHECK ("kind" IN ('amc', 'service', 'warranty_extension', 'other'));
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_texts_length"
  CHECK (char_length("vendor_name") BETWEEN 1 AND 120
     AND ("scope" IS NULL OR char_length("scope") BETWEEN 1 AND 1000));
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_vendor_phone_shape"
  CHECK ("vendor_phone" IS NULL OR "vendor_phone" ~ '^[0-9+() -]{3,30}$');
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_dates"
  CHECK ("ends_on" > "starts_on" AND "notice_days" BETWEEN 0 AND 180);
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_value_range"
  CHECK ("annual_value" IS NULL OR ("annual_value" >= 0 AND "annual_value" < 10000000000));
-- Terminated once, with when, who and why (REASON_CODES.contractTerminate).
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_termination_shape"
  CHECK (("terminated_at" IS NULL) = ("termination_reason" IS NULL)
     AND ("termination_reason" IS NULL
          OR "termination_reason" IN ('vendor_performance', 'replaced', 'not_needed', 'budget', 'other')));
-- An announcement is for the end date it names.
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_alert_shape"
  CHECK ("expiry_alerted_for" IS NULL OR "expiry_alerted_for" = "ends_on");

-- A terminated contract stays as it was terminated, and its code never
-- changes.
CREATE FUNCTION "maintenance_contracts_terminated_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a contract is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."code" <> OLD."code" OR NEW."created_at" <> OLD."created_at"
     OR (OLD."terminated_at" IS NOT NULL AND (
          NEW."terminated_at" IS DISTINCT FROM OLD."terminated_at"
       OR NEW."termination_reason" IS DISTINCT FROM OLD."termination_reason"
       OR NEW."starts_on" <> OLD."starts_on" OR NEW."ends_on" <> OLD."ends_on"
       OR NEW."annual_value" IS DISTINCT FROM OLD."annual_value"
       OR NEW."kind" <> OLD."kind")) THEN
    RAISE EXCEPTION 'a terminated contract never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_contracts_terminated_once" BEFORE UPDATE OR DELETE ON "maintenance_contracts"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_contracts_terminated_once"();

CREATE TABLE "maintenance_contract_assets" (
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "added_by_account_id" UUID,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_contract_assets_pkey" PRIMARY KEY ("contract_id", "asset_id")
);
CREATE INDEX "maintenance_contract_assets_asset_idx" ON "maintenance_contract_assets"("tenant_id", "asset_id");
ALTER TABLE "maintenance_contract_assets" ADD CONSTRAINT "maintenance_contract_assets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contract_assets" ADD CONSTRAINT "maintenance_contract_assets_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contract_assets" ADD CONSTRAINT "maintenance_contract_assets_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contract_assets" ADD CONSTRAINT "maintenance_contract_assets_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- A contract's papers: a fourth subject of the register's documents.
-- ----------------------------------------------------------------------------
ALTER TABLE "maintenance_documents" ADD COLUMN "contract_id" UUID;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "maintenance_documents_contract_idx" ON "maintenance_documents"("tenant_id", "contract_id", "added_at")
  WHERE "contract_id" IS NOT NULL;
ALTER TABLE "maintenance_documents" DROP CONSTRAINT "maintenance_documents_subject_one";
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_subject_one"
  CHECK (num_nonnulls("asset_id", "asset_type_id", "common_area_id", "contract_id") = 1);

CREATE OR REPLACE FUNCTION "maintenance_documents_removed_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."file_id" = OLD."file_id"
     AND NEW."kind" = OLD."kind" AND NEW."title" = OLD."title"
     AND NEW."asset_id" IS NOT DISTINCT FROM OLD."asset_id"
     AND NEW."asset_type_id" IS NOT DISTINCT FROM OLD."asset_type_id"
     AND NEW."common_area_id" IS NOT DISTINCT FROM OLD."common_area_id"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."added_at" = OLD."added_at" THEN
    RETURN NEW;
  END IF;
  -- An erasure nulls who added or removed it, and nothing else.
  IF NEW."id" = OLD."id" AND NEW."file_id" = OLD."file_id" AND NEW."title" = OLD."title"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."removed_at" IS NOT DISTINCT FROM OLD."removed_at"
     AND (NEW."added_by_account_id" IS NULL OR NEW."added_by_account_id" = OLD."added_by_account_id")
     AND (NEW."removed_by_account_id" IS NULL OR NEW."removed_by_account_id" = OLD."removed_by_account_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a document is removed once, and never changed' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Grants: a contract changes in place under FOR UPDATE (and its coverage
-- with it); a covered asset is added or taken off.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "maintenance_contracts", "maintenance_contract_assets" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "maintenance_contracts" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "maintenance_contract_assets" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_contracts', 'maintenance_contract_assets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
