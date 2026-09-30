-- ============================================================================
-- Phase 2.2 — "not me": a frozen account (ADR 0023). The phone number now
-- belongs to someone else, so it comes off the account itself — not only off
-- login — and its HMAC is kept on the freeze row so the number can never be
-- put back on this account.
-- ============================================================================

CREATE TYPE "account_freeze_reason" AS ENUM ('phone_reassigned');

ALTER TABLE "accounts" ALTER COLUMN "phone" DROP NOT NULL;
-- Only a frozen account may have no phone (erasure widens this later).
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_phone_present"
  CHECK ("phone" IS NOT NULL OR "status" = 'frozen');

CREATE TABLE "account_freezes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reason" "account_freeze_reason" NOT NULL,
    -- HMAC of the number taken off; never reopened for its new holder.
    "released_phone_hash" CHAR(64) NOT NULL,
    -- Managers only; erasable, never audited.
    "note" TEXT,
    "frozen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozen_by" UUID,
    "reactivated_at" TIMESTAMPTZ(3),
    "reactivated_by" UUID,
    CONSTRAINT "account_freezes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_freezes_one_live"
  ON "account_freezes"("account_id") WHERE "reactivated_at" IS NULL;
CREATE INDEX "account_freezes_tenant_id_account_id_idx"
  ON "account_freezes"("tenant_id", "account_id");
ALTER TABLE "account_freezes"
  ADD CONSTRAINT "account_freezes_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_freezes_tenant_id_frozen_by_fkey"
  FOREIGN KEY ("tenant_id", "frozen_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_freezes_tenant_id_reactivated_by_fkey"
  FOREIGN KEY ("tenant_id", "reactivated_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_freezes" ADD CONSTRAINT "account_freezes_reactivated_by_needs_time"
  CHECK ("reactivated_by" IS NULL OR "reactivated_at" IS NOT NULL);

REVOKE DELETE ON "account_freezes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_freezes" TO jiwar_app;

ALTER TABLE "account_freezes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_freezes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_freezes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
