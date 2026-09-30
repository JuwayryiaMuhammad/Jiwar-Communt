-- ============================================================================
-- Phase 2.2 — account deletion (ADR 0023). The holder asks and can undo
-- during a grace period; afterwards staff erase it in three steps (scope,
-- legal hold, typed scope). The account becomes a TOMBSTONE: the row stays
-- (audit joins show a deleted user, financial records keep their pointer)
-- and every personal field is NULL.
-- ============================================================================

CREATE TYPE "deletion_request_status" AS ENUM ('pending', 'cancelled', 'completed');

-- Accounts: personal fields may be NULL, but only as one erased shape.
ALTER TABLE "accounts"
  ALTER COLUMN "full_name" DROP NOT NULL,
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "id_document_number" DROP NOT NULL,
  ALTER COLUMN "id_document_type" DROP NOT NULL,
  ALTER COLUMN "nationality" DROP NOT NULL;
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_phone_present";
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_erased_shape"
  CHECK (("status" = 'erased'
          AND "full_name" IS NULL AND "phone" IS NULL AND "email" IS NULL
          AND "id_document_type" IS NULL AND "id_document_number" IS NULL
          AND "nationality" IS NULL AND "birth_date" IS NULL)
      OR ("status" <> 'erased'
          AND "full_name" IS NOT NULL AND "email" IS NOT NULL
          AND "id_document_type" IS NOT NULL AND "id_document_number" IS NOT NULL
          AND "nationality" IS NOT NULL
          -- Only a frozen account has no phone (the number left it).
          AND ("phone" IS NOT NULL OR "status" = 'frozen')));
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_identity_document";
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_identity_document"
  CHECK ("status" = 'erased'
      OR ("id_document_type" = 'national_id' AND "nationality" = 'EG')
      OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'
          AND "birth_date" IS NOT NULL));

-- Invites that brought an erased person in lose their personal data too.
ALTER TABLE "household_invites"
  ALTER COLUMN "full_name" DROP NOT NULL,
  ALTER COLUMN "phone" DROP NOT NULL,
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "id_document_number" DROP NOT NULL,
  ALTER COLUMN "id_document_type" DROP NOT NULL,
  ALTER COLUMN "nationality" DROP NOT NULL,
  ADD COLUMN "stripped_at" TIMESTAMPTZ(3);
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_stripped_shape"
  CHECK (("stripped_at" IS NULL
          AND "full_name" IS NOT NULL AND "phone" IS NOT NULL AND "email" IS NOT NULL
          AND "id_document_type" IS NOT NULL AND "id_document_number" IS NOT NULL
          AND "nationality" IS NOT NULL)
      OR ("stripped_at" IS NOT NULL AND "status" <> 'pending'
          AND "full_name" IS NULL AND "phone" IS NULL AND "email" IS NULL
          AND "id_document_type" IS NULL AND "id_document_number" IS NULL
          AND "nationality" IS NULL AND "birth_date" IS NULL));
ALTER TABLE "household_invites" DROP CONSTRAINT "household_invites_identity_document";
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_identity_document"
  CHECK ("stripped_at" IS NOT NULL
      OR ("id_document_type" = 'national_id' AND "nationality" = 'EG')
      OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'
          AND "birth_date" IS NOT NULL));

CREATE TABLE "account_deletion_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "deletion_request_status" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- End of the grace period: undo before it, erasure only after it.
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "completed_by" UUID,
    -- The erasure holders were told it is overdue (the sweep, once).
    "overdue_notified_at" TIMESTAMPTZ(3),
    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_deletion_requests_one_pending"
  ON "account_deletion_requests"("account_id") WHERE "status" = 'pending';
CREATE INDEX "account_deletion_requests_tenant_id_status_effective_at_idx"
  ON "account_deletion_requests"("tenant_id", "status", "effective_at");
ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_deletion_requests_tenant_id_completed_by_fkey"
  FOREIGN KEY ("tenant_id", "completed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_cancelled_matches"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_completed_matches"
  CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL));
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_grace_after_request"
  CHECK ("effective_at" > "requested_at");

CREATE TABLE "legal_holds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    -- Staff only; never told to the person, never audited.
    "note" TEXT,
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placed_by" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "released_by" UUID,
    "release_reason_code" TEXT,
    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_holds_one_active"
  ON "legal_holds"("account_id") WHERE "released_at" IS NULL;
CREATE INDEX "legal_holds_tenant_id_account_id_idx" ON "legal_holds"("tenant_id", "account_id");
ALTER TABLE "legal_holds"
  ADD CONSTRAINT "legal_holds_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "legal_holds_tenant_id_placed_by_fkey"
  FOREIGN KEY ("tenant_id", "placed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "legal_holds_tenant_id_released_by_fkey"
  FOREIGN KEY ("tenant_id", "released_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_release_is_complete"
  CHECK (("released_at" IS NULL AND "released_by" IS NULL AND "release_reason_code" IS NULL)
      OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason_code" IS NOT NULL));

REVOKE DELETE ON "account_deletion_requests", "legal_holds" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_deletion_requests", "legal_holds" TO jiwar_app;

ALTER TABLE "account_deletion_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_deletion_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_deletion_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "legal_holds"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
