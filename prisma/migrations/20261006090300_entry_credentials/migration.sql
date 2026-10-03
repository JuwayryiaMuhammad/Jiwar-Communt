-- ============================================================================
-- Phase 4.3 — entry credentials (ADR 0031). One row per phone a resident
-- registered for the rotating entry QR. The secret is NOT here and is never
-- stored: it is derived, HMAC(ENTRY_CREDENTIAL_KEY, "entry:<tenant>:<id>").
-- The row says only that the credential exists, whose it is and whether it
-- was revoked. No "last used": a resident's scan leaves no trace.
-- Rows are never deleted: the audit log names them by id.
-- ============================================================================

CREATE TABLE "entry_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "device_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    CONSTRAINT "entry_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entry_credentials_tenant_id_id_key"
  ON "entry_credentials"("tenant_id", "id");
-- An account's live credentials: the limit, the list, every revocation.
CREATE INDEX "entry_credentials_live_idx"
  ON "entry_credentials"("tenant_id", "account_id") WHERE "revoked_at" IS NULL;
ALTER TABLE "entry_credentials" ADD CONSTRAINT "entry_credentials_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Revoked or not, never half: a reason from the closed list (ENTRY_REVOKE_REASONS).
ALTER TABLE "entry_credentials" ADD CONSTRAINT "entry_credentials_revoked_together"
  CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));
ALTER TABLE "entry_credentials" ADD CONSTRAINT "entry_credentials_revoke_reason"
  CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN
    ('owner', 'sessions_revoked', 'account_deactivated', 'account_frozen',
     'account_erased', 'not_resident', 'key_rotated'));
-- A device name is personal data: kept only while the credential is live.
ALTER TABLE "entry_credentials" ADD CONSTRAINT "entry_credentials_device_name"
  CHECK ("device_name" IS NULL
         OR ("revoked_at" IS NULL AND char_length("device_name") BETWEEN 1 AND 60));

GRANT SELECT, INSERT, UPDATE ON "entry_credentials" TO jiwar_app;

ALTER TABLE "entry_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entry_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "entry_credentials"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
