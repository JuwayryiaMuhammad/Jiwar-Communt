-- ============================================================================
-- Phase 4 — the in-app notifications inbox (ADR 0027). One row per recipient:
-- a catalog code, its params and what it points at; never display text.
-- Read rows are purged after NOTIFICATIONS_RETENTION_DAYS; an erased account
-- loses its rows; personal params (names) are scrubbed when the data they
-- came from expires. Push and SMS will read this table.
-- ============================================================================

CREATE TYPE "notification_priority" AS ENUM ('normal', 'critical');

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" "notification_priority" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "target_type" TEXT,
    "target_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_tenant_id_account_id_created_at_id_idx"
  ON "notifications"("tenant_id", "account_id", "created_at" DESC, "id" DESC);
-- The badge: unread counts per account.
CREATE INDEX "notifications_unread_idx"
  ON "notifications"("tenant_id", "account_id", "priority") WHERE "read_at" IS NULL;
-- The visitor-data sweep scrubs by target.
CREATE INDEX "notifications_tenant_id_target_id_idx"
  ON "notifications"("tenant_id", "target_id");
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_pair"
  CHECK (("target_type" IS NULL) = ("target_id" IS NULL));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_params_object"
  CHECK (jsonb_typeof("params") = 'object');

-- Read state changes; retention and erasure delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO jiwar_app;

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
