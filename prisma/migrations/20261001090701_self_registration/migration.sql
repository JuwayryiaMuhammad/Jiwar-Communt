-- ============================================================================
-- Phase 2.2 — resident self-registration (ADR 0024). A request first: no
-- account exists until a manager approves it, and the request holds its
-- personal data only while pending (a CHECK nulls it at the decision).
-- ============================================================================

CREATE TYPE "unit_type" AS ENUM (
  'apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'studio',
  'commercial', 'other');
CREATE TYPE "registration_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- The activation card (02 §3): progressive unit details.
ALTER TABLE "units"
  ADD COLUMN "unit_type" "unit_type",
  ADD COLUMN "area_sqm" NUMERIC(8, 2);
ALTER TABLE "units" ADD CONSTRAINT "units_area_positive"
  CHECK ("area_sqm" IS NULL OR "area_sqm" > 0);

-- Global: resolves a registration link to its compound before anyone is
-- logged in, like invite_tokens (ADR 0016). No PII: only the token HMAC.
CREATE TABLE "registration_links" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    CONSTRAINT "registration_links_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "registration_links_tenant_id_idx" ON "registration_links"("tenant_id");
ALTER TABLE "registration_links"
  ADD CONSTRAINT "registration_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
GRANT SELECT, INSERT, UPDATE ON "registration_links" TO jiwar_app;
REVOKE DELETE ON "registration_links" FROM jiwar_app;

CREATE TABLE "resident_registrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "registration_status" NOT NULL DEFAULT 'pending',
    -- Personal data: present exactly while pending.
    "full_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "id_document_type" "id_document_type",
    "id_document_number" TEXT,
    "nationality" CHAR(2),
    "birth_date" DATE,
    "preferred_locale" "locale" NOT NULL DEFAULT 'ar',
    -- As typed: the unit is looked up by the manager, never by the registrant.
    "unit_code" TEXT NOT NULL,
    "occupancy_type" "occupancy_type" NOT NULL,
    "resides" BOOLEAN NOT NULL DEFAULT true,
    "unit_type" "unit_type",
    "area_sqm" NUMERIC(8, 2),
    "building" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "decision_reason_code" TEXT,
    "approved_account_id" UUID,
    "approved_occupancy_id" UUID,
    CONSTRAINT "resident_registrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "resident_registrations_one_pending_per_email"
  ON "resident_registrations"("tenant_id", "email") WHERE "status" = 'pending';
CREATE INDEX "resident_registrations_tenant_id_status_created_at_idx"
  ON "resident_registrations"("tenant_id", "status", "created_at");
ALTER TABLE "resident_registrations"
  ADD CONSTRAINT "resident_registrations_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "resident_registrations_tenant_id_approved_account_id_fkey"
  FOREIGN KEY ("tenant_id", "approved_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "resident_registrations_tenant_id_approved_occupancy_id_fkey"
  FOREIGN KEY ("tenant_id", "approved_occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_pii_only_pending"
  CHECK (("status" = 'pending'
          AND "full_name" IS NOT NULL AND "phone" IS NOT NULL AND "email" IS NOT NULL
          AND "id_document_type" IS NOT NULL AND "id_document_number" IS NOT NULL
          AND "nationality" IS NOT NULL AND "birth_date" IS NOT NULL)
      OR ("status" <> 'pending'
          AND "full_name" IS NULL AND "phone" IS NULL AND "email" IS NULL
          AND "id_document_type" IS NULL AND "id_document_number" IS NULL
          AND "nationality" IS NULL AND "birth_date" IS NULL));
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_decided_matches_status"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL));
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_approved_has_account"
  CHECK (("status" = 'approved') = ("approved_account_id" IS NOT NULL));
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_tenant_resides"
  CHECK ("occupancy_type" = 'owner' OR "resides");
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_area_positive"
  CHECK ("area_sqm" IS NULL OR "area_sqm" > 0);

REVOKE DELETE ON "resident_registrations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "resident_registrations" TO jiwar_app;

ALTER TABLE "resident_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resident_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "resident_registrations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
