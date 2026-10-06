-- ============================================================================
-- Phase R1 — account deletion (ADR 0036, amending ADR 0023).
--
-- A request is checked for blockers (a primary resident, an active staff
-- role, a legal hold, open worker obligations) when it is made, and again in
-- the transaction that executes it after the cooling-off (14 days). With
-- none, the sweep erases the account; with some, the request is queued for
-- the managers with its blocker codes. A manager executes it once they are
-- cleared, or closes it with a reason code. The account is reminded two
-- days before. A manager may file one for the account (assisted).
-- ============================================================================

ALTER TABLE "account_deletion_requests"
  ADD COLUMN "requested_by" UUID,
  ADD COLUMN "assisted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assist_reason_code" TEXT,
  ADD COLUMN "reminded_at" TIMESTAMPTZ(3),
  ADD COLUMN "queued_at" TIMESTAMPTZ(3),
  ADD COLUMN "blocker_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "closed_at" TIMESTAMPTZ(3),
  ADD COLUMN "closed_by" UUID,
  ADD COLUMN "close_reason_code" TEXT;

-- Every earlier request was the account's own. FORCE RLS: one compound at
-- a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "account_deletion_requests" SET "requested_by" = "account_id"
     WHERE "requested_by" IS NULL;
  END LOOP;
END $$;
ALTER TABLE "account_deletion_requests" ALTER COLUMN "requested_by" SET NOT NULL;

-- One open request per account: pending or queued.
DROP INDEX "account_deletion_requests_one_pending";
CREATE UNIQUE INDEX "account_deletion_requests_one_pending"
  ON "account_deletion_requests"("tenant_id", "account_id")
  WHERE "status" IN ('pending', 'queued');

ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_deletion_requests_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_r1_shape"
  CHECK ("assisted" = ("assist_reason_code" IS NOT NULL)
     AND ("assisted" OR "requested_by" = "account_id")
     AND ("status" <> 'queued' OR ("queued_at" IS NOT NULL AND cardinality("blocker_codes") > 0))
     AND (("status" = 'closed') = ("closed_at" IS NOT NULL))
     AND ("status" <> 'closed' OR ("close_reason_code" IS NOT NULL AND "queued_at" IS NOT NULL)));
