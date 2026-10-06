-- ============================================================================
-- Phase R1 — personal-data export (ADR 0036).
--
-- An account asks for its own data (a fresh step-up code first); the
-- archive is built in the background, streamed into the private bucket as
-- a `data_export` file attached to the request, downloadable for 7 days,
-- then deleted. One active request (pending or building) per account, at
-- most one a day. An assisted request (a manager for the account) goes only
-- to the account's own email.
-- ============================================================================

CREATE TYPE "data_export_status" AS ENUM ('pending', 'building', 'ready', 'expired', 'failed');
CREATE TYPE "data_export_delivery" AS ENUM ('in_app', 'email');

CREATE TABLE "data_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "data_export_status" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID NOT NULL,
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "assist_reason_code" TEXT,
    "delivery" "data_export_delivery" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "object_id" UUID,
    "file_id" UUID,
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "data_exports_tenant_id_id_key" ON "data_exports"("tenant_id", "id");
CREATE INDEX "data_exports_tenant_id_account_id_requested_at_idx"
  ON "data_exports"("tenant_id", "account_id", "requested_at");
CREATE INDEX "data_exports_tenant_id_status_idx" ON "data_exports"("tenant_id", "status");
-- One active request per account: two at once, one wins.
CREATE UNIQUE INDEX "data_exports_one_active"
  ON "data_exports"("tenant_id", "account_id")
  WHERE "status" IN ('pending', 'building');
-- A ready export's file names it (and is never deleted under it).
CREATE UNIQUE INDEX "data_exports_file_id_key"
  ON "data_exports"("tenant_id", "file_id") WHERE "file_id" IS NOT NULL;
ALTER TABLE "data_exports"
  ADD CONSTRAINT "data_exports_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "data_exports_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_shape"
  CHECK ("assisted" = ("assist_reason_code" IS NOT NULL)
     AND ("delivery" = 'email') = "assisted"
     AND ("assisted" OR "requested_by" = "account_id")
     AND "attempts" >= 0
     AND ("status" <> 'building' OR ("locked_until" IS NOT NULL AND "object_id" IS NOT NULL))
     AND ("status" <> 'ready' OR ("file_id" IS NOT NULL AND "ready_at" IS NOT NULL
                                  AND "expires_at" IS NOT NULL))
     AND (("status" IN ('expired', 'failed')) = ("ended_at" IS NOT NULL))
     AND ("status" = 'failed') = ("failure_code" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- The archive's file purpose: a zip, written by the server, up to 512 MiB.
-- Both CHECKs are recreated with it.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" = 'document')
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export'));
ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           WHEN 'ticket_photo' THEN 5242880
           WHEN 'parcel_photo' THEN 5242880
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Never deleted: an expired export keeps its row, its
-- file goes.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "data_exports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "data_exports" TO jiwar_app;

ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_exports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
