-- ============================================================================
-- Phase R1 — the unusual-login alert and email action tokens (ADR 0036).
--
-- "Unusual" means a device never seen on the account: the app's install id,
-- or a browser's family and OS. Only a keyed hash (bound to the account)
-- and a coarse type are kept: no user agent, no IP, no place. The first
-- device recorded is the baseline and raises no alert.
--
-- An email that carries an action (the alert's "not me", an assisted
-- export's download link) carries a token. `action_tokens` stores no secret
-- and no hash of one: the token is `<id>.<mac>`, the mac derived from the id
-- with the server's pepper. Ids only.
-- ============================================================================

CREATE TYPE "known_device_source" AS ENUM ('app', 'web');
CREATE TYPE "action_token_purpose" AS ENUM ('not_me', 'export_download');

CREATE TABLE "known_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "device_hash" CHAR(64) NOT NULL,
    "source" "known_device_source" NOT NULL,
    "device_type" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disowned_at" TIMESTAMPTZ(3),
    CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "known_devices_tenant_id_account_id_device_hash_key"
  ON "known_devices"("tenant_id", "account_id", "device_hash");
CREATE UNIQUE INDEX "known_devices_tenant_id_id_key" ON "known_devices"("tenant_id", "id");
ALTER TABLE "known_devices"
  ADD CONSTRAINT "known_devices_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_device_type_known"
  CHECK ("device_type" IN ('ios', 'android', 'desktop_web', 'mobile_web', 'unknown'));

-- Global, like invite_tokens: resolved before a compound is known.
CREATE TABLE "action_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" "action_token_purpose" NOT NULL,
    "subject_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "uses" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "action_tokens_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "action_tokens_account_id_idx" ON "action_tokens"("account_id");
CREATE INDEX "action_tokens_expires_at_idx" ON "action_tokens"("expires_at");
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_uses_nonnegative"
  CHECK ("uses" >= 0);

-- A "not me" freeze keeps the phone: only a reassigned phone is released.
ALTER TABLE "account_freezes" ALTER COLUMN "released_phone_hash" DROP NOT NULL;
ALTER TABLE "account_freezes" ADD CONSTRAINT "account_freezes_released_shape"
  CHECK (("reason" = 'phone_reassigned') = ("released_phone_hash" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Erasure deletes an account's devices and tokens; the
-- retention sweep deletes expired tokens.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "known_devices", "action_tokens" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "known_devices", "action_tokens" TO jiwar_app;

ALTER TABLE "known_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "known_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "known_devices"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
