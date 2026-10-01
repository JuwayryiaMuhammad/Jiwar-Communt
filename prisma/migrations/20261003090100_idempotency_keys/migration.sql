-- ============================================================================
-- Phase 4 — idempotent writes (ADR 0028). A key is claimed inside the
-- action's own transaction, so it commits or rolls back with the write; the
-- primary key makes a concurrent duplicate wait for the first, then replay.
-- The body is stored after the response (never a secret: pass creation keeps
-- its key on visitor_passes instead); a lost body is re-rendered from the
-- resource ref. Keys live 24 hours; the sweep purges them.
-- ============================================================================

CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id", "account_id", "key")
);
CREATE INDEX "idempotency_keys_tenant_id_expires_at_idx"
  ON "idempotency_keys"("tenant_id", "expires_at");
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_expiry_after_creation"
  CHECK ("expires_at" > "created_at");
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_length"
  CHECK (char_length("key") BETWEEN 8 AND 128);

GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_keys" TO jiwar_app;

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
