-- ============================================================================
-- Phase 4 — visitors (ADR 0028): passes with a 6-digit code (an HMAC only),
-- the visitor's name and phone in a separate row that expires, a unit's
-- standing instructions for the gate, and two compound settings.
-- ============================================================================

CREATE TYPE "visitor_pass_kind" AS ENUM ('one_time', 'recurring');
CREATE TYPE "visitor_pass_status" AS ENUM ('active', 'used', 'cancelled', 'expired');
CREATE TYPE "visitor_instruction" AS ENUM ('ask', 'allow', 'deny');
CREATE TYPE "delivery_instruction" AS ENUM ('ask', 'allow', 'leave_at_gate', 'deny');

-- A visitor's name and phone: personal data, deleted when it expires.
CREATE TABLE "visitor_details" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT,
    "phone" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visitor_details_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visitor_details_tenant_id_id_key" ON "visitor_details"("tenant_id", "id");
CREATE INDEX "visitor_details_tenant_id_expires_at_idx" ON "visitor_details"("tenant_id", "expires_at");
ALTER TABLE "visitor_details" ADD CONSTRAINT "visitor_details_not_empty"
  CHECK ("full_name" IS NOT NULL OR "phone" IS NOT NULL);

CREATE TABLE "visitor_passes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "host_account_id" UUID NOT NULL,
    "kind" "visitor_pass_kind" NOT NULL,
    "party_size" INTEGER NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "schedule" JSONB,
    "status" "visitor_pass_status" NOT NULL DEFAULT 'active',
    -- HMAC(IDENTIFIER_PEPPER, "visitor-code:<tenantId>:<code>"); NULL once
    -- the pass is no longer active.
    "code_hash" CHAR(64),
    "visitor_details_id" UUID,
    "used_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason_code" TEXT,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visitor_passes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visitor_passes_tenant_id_id_key" ON "visitor_passes"("tenant_id", "id");
-- A code names at most one live pass in the compound.
CREATE UNIQUE INDEX "visitor_passes_active_code"
  ON "visitor_passes"("tenant_id", "code_hash") WHERE "code_hash" IS NOT NULL;
CREATE UNIQUE INDEX "visitor_passes_tenant_id_host_account_id_idempotency_key_key"
  ON "visitor_passes"("tenant_id", "host_account_id", "idempotency_key");
CREATE INDEX "visitor_passes_tenant_id_unit_id_created_at_idx"
  ON "visitor_passes"("tenant_id", "unit_id", "created_at" DESC);
CREATE INDEX "visitor_passes_tenant_id_host_account_id_status_idx"
  ON "visitor_passes"("tenant_id", "host_account_id", "status");
ALTER TABLE "visitor_passes"
  ADD CONSTRAINT "visitor_passes_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_passes_tenant_id_host_account_id_fkey"
  FOREIGN KEY ("tenant_id", "host_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_passes_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The details expire; the pass stays and loses only the pointer.
  ADD CONSTRAINT "visitor_passes_tenant_id_visitor_details_id_fkey"
  FOREIGN KEY ("tenant_id", "visitor_details_id") REFERENCES "visitor_details"("tenant_id", "id")
  ON DELETE SET NULL ("visitor_details_id") ON UPDATE RESTRICT;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_party_size_range"
  CHECK ("party_size" BETWEEN 1 AND 50);
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_window_order"
  CHECK ("valid_from" < "valid_until");
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_schedule_matches_kind"
  CHECK (("kind" = 'recurring') = ("schedule" IS NOT NULL));
-- Only an active pass has a code; a used one has its time.
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_code_only_when_active"
  CHECK (("status" = 'active') = ("code_hash" IS NOT NULL));
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_used_matches_status"
  CHECK (("status" = 'used') = ("used_at" IS NOT NULL));
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_cancel_is_complete"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason_code" IS NULL)
     AND ("cancelled_by" IS NULL OR "cancelled_at" IS NOT NULL));
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_idempotency_pair"
  CHECK (("idempotency_key" IS NULL) = ("request_hash" IS NULL));

CREATE TABLE "unit_gate_instructions" (
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "uninvited_visitor" "visitor_instruction" NOT NULL DEFAULT 'ask',
    "delivery" "delivery_instruction" NOT NULL DEFAULT 'ask',
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_gate_instructions_pkey" PRIMARY KEY ("tenant_id", "unit_id")
);
ALTER TABLE "unit_gate_instructions"
  ADD CONSTRAINT "unit_gate_instructions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_gate_instructions_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_settings"
  ADD COLUMN "max_active_visitor_passes" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "gate_request_timeout_seconds" INTEGER NOT NULL DEFAULT 180;
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_max_active_visitor_passes_range"
  CHECK ("max_active_visitor_passes" BETWEEN 1 AND 500);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_gate_request_timeout_range"
  CHECK ("gate_request_timeout_seconds" BETWEEN 30 AND 1800);

-- Details are deleted by the retention sweep; passes and instructions never.
GRANT SELECT, INSERT, UPDATE, DELETE ON "visitor_details" TO jiwar_app;
REVOKE DELETE ON "visitor_passes", "unit_gate_instructions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "visitor_passes", "unit_gate_instructions" TO jiwar_app;

ALTER TABLE "visitor_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "visitor_details" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "visitor_details"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "visitor_passes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "visitor_passes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "visitor_passes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "unit_gate_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_gate_instructions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_gate_instructions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
