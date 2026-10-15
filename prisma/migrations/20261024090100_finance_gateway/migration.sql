-- ============================================================================
-- Phase R6a — a compound's online payment account (ADR 0046). Each compound
-- has its own Paymob merchant account; its credentials are stored sealed
-- (AES-256-GCM, additional data bound to the compound, the field and the key
-- version) and only their last four characters are ever shown. The manager
-- turns online payment on or off; the platform can switch it off for the
-- compound whatever the manager says.
-- ============================================================================

CREATE TYPE "finance_gateway_mode" AS ENUM ('sandbox', 'live');

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_settings" (
    "tenant_id" UUID NOT NULL,
    "online_enabled" BOOLEAN NOT NULL DEFAULT false,
    "platform_disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The gateway: zero or one per compound, replaced as a whole, never deleted.
-- Each *_enc column is iv (12) ‖ tag (16) ‖ ciphertext.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_gateways" (
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paymob',
    "mode" "finance_gateway_mode" NOT NULL,
    "key_version" INTEGER NOT NULL,
    "secret_key_enc" BYTEA NOT NULL,
    "public_key_enc" BYTEA NOT NULL,
    "hmac_secret_enc" BYTEA NOT NULL,
    "card_integration_enc" BYTEA NOT NULL,
    "wallet_integration_enc" BYTEA,
    "secret_key_last4" TEXT NOT NULL,
    "public_key_last4" TEXT NOT NULL,
    "hmac_secret_last4" TEXT NOT NULL,
    "card_integration_last4" TEXT NOT NULL,
    "wallet_integration_last4" TEXT,
    "updated_by_account_id" UUID,
    "updated_by_platform" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_gateways_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "finance_gateways"
  ADD CONSTRAINT "finance_gateways_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_gateways_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_provider"
  CHECK ("provider" = 'paymob');
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_key_version"
  CHECK ("key_version" BETWEEN 1 AND 32767);
-- A sealed value is longer than its iv and tag.
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_sealed"
  CHECK (octet_length("secret_key_enc") > 28
     AND octet_length("public_key_enc") > 28
     AND octet_length("hmac_secret_enc") > 28
     AND octet_length("card_integration_enc") > 28
     AND ("wallet_integration_enc" IS NULL OR octet_length("wallet_integration_enc") > 28));
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_last4"
  CHECK (char_length("secret_key_last4") BETWEEN 1 AND 4
     AND char_length("public_key_last4") BETWEEN 1 AND 4
     AND char_length("hmac_secret_last4") BETWEEN 1 AND 4
     AND char_length("card_integration_last4") BETWEEN 1 AND 4
     AND ("wallet_integration_last4" IS NULL OR char_length("wallet_integration_last4") BETWEEN 1 AND 4));
-- The wallet integration is optional, its two columns together.
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_wallet_shape"
  CHECK (("wallet_integration_enc" IS NULL) = ("wallet_integration_last4" IS NULL));
-- Set by a manager of the compound, or by the platform.
ALTER TABLE "finance_gateways" ADD CONSTRAINT "finance_gateways_updated_by_shape"
  CHECK ("updated_by_platform" = ("updated_by_account_id" IS NULL));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_settings", "finance_gateways" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_settings", "finance_gateways" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_settings', 'finance_gateways'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/finance/provisioning.ts):
-- the settings row, online payment off. FORCE RLS applies here too: one
-- compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "finance_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
