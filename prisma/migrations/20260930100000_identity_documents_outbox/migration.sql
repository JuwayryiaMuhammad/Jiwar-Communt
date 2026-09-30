-- ============================================================================
-- Phase 2.1: identity documents (ADR 0018), outbox (ADR 0019), overnight
-- schedules' time zone, units needing review.
-- Renames keep the data: national_id → id_document_number.
-- ============================================================================

CREATE TYPE "id_document_type" AS ENUM ('national_id', 'passport');
CREATE TYPE "outbox_channel" AS ENUM ('email');
CREATE TYPE "outbox_status" AS ENUM ('pending', 'processing', 'sent', 'dead');

-- Identity documents ---------------------------------------------------------
ALTER TABLE "accounts" RENAME COLUMN "national_id" TO "id_document_number";
ALTER TABLE "accounts"
  ADD COLUMN "id_document_type" "id_document_type" NOT NULL DEFAULT 'national_id',
  ADD COLUMN "nationality" CHAR(2) NOT NULL DEFAULT 'EG',
  ADD COLUMN "birth_date" DATE;

-- Minors only (adults' documents live on their accounts).
ALTER TABLE "household_members" RENAME COLUMN "national_id" TO "id_document_number";
ALTER TABLE "household_members"
  ADD COLUMN "id_document_type" "id_document_type",
  ADD COLUMN "nationality" CHAR(2);

ALTER TABLE "household_invites" RENAME COLUMN "national_id" TO "id_document_number";
ALTER TABLE "household_invites"
  ADD COLUMN "id_document_type" "id_document_type" NOT NULL DEFAULT 'national_id',
  ADD COLUMN "nationality" CHAR(2) NOT NULL DEFAULT 'EG',
  ADD COLUMN "birth_date" DATE;

ALTER TABLE "domestic_workers" RENAME COLUMN "national_id" TO "id_document_number";
-- Same values: the national-ID formula is unchanged (ADR 0018).
ALTER TABLE "domestic_workers" RENAME COLUMN "national_id_hash" TO "id_document_hash";
ALTER INDEX "domestic_workers_tenant_id_national_id_hash_key"
  RENAME TO "domestic_workers_tenant_id_id_document_hash_key";
ALTER TABLE "domestic_workers"
  ADD COLUMN "id_document_type" "id_document_type" NOT NULL DEFAULT 'national_id',
  ADD COLUMN "nationality" CHAR(2) NOT NULL DEFAULT 'EG',
  ADD COLUMN "birth_date_verified_by" UUID,
  ADD COLUMN "birth_date_verified_at" TIMESTAMPTZ(3);
ALTER TABLE "domestic_workers"
  ADD CONSTRAINT "domestic_workers_tenant_id_birth_date_verified_by_fkey"
  FOREIGN KEY ("tenant_id", "birth_date_verified_by")
  REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Settings and units -----------------------------------------------------------
ALTER TABLE "tenant_settings"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo';
ALTER TABLE "units" ADD COLUMN "household_review_flagged_at" TIMESTAMPTZ(3);

-- Outbox (global; tenant_id is a pointer) --------------------------------------
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "channel" "outbox_channel" NOT NULL,
    "template_key" TEXT NOT NULL,
    "locale" "locale" NOT NULL,
    "recipient" TEXT,
    "params" JSONB,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "stripped_at" TIMESTAMPTZ(3),
    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_messages_status_next_attempt_at_idx"
  ON "outbox_messages"("status", "next_attempt_at");
CREATE INDEX "outbox_messages_status_sent_at_idx"
  ON "outbox_messages"("status", "sent_at");

-- ============================================================================
-- Birth date from an Egyptian national ID, in SQL. Mirrors
-- core/common/egyptian-national-id.ts (a test compares the two): 14 digits,
-- century 2|3, a real date not in the future, a known governorate.
-- ============================================================================
CREATE FUNCTION egyptian_national_id_birth_date(id text) RETURNS date
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  century int;
  d date;
BEGIN
  IF id !~ '^[0-9]{14}$' THEN RETURN NULL; END IF;
  century := CASE substr(id, 1, 1) WHEN '2' THEN 1900 WHEN '3' THEN 2000 END;
  IF century IS NULL THEN RETURN NULL; END IF;
  IF NOT substr(id, 8, 2) = ANY (ARRAY[
    '01','02','03','04',
    '11','12','13','14','15','16','17','18','19',
    '21','22','23','24','25','26','27','28','29',
    '31','32','33','34','35','88']) THEN
    RETURN NULL;
  END IF;
  BEGIN
    d := make_date(century + substr(id, 2, 2)::int,
                   substr(id, 4, 2)::int,
                   substr(id, 6, 2)::int);
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF d > (now() AT TIME ZONE 'Africa/Cairo')::date THEN RETURN NULL; END IF;
  RETURN d;
END $$;

-- ============================================================================
-- Backfill, one compound at a time (FORCE RLS applies to the migrator).
-- A legacy ID that does not parse leaves birth_date NULL.
-- ============================================================================
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "accounts"
       SET "birth_date" = egyptian_national_id_birth_date("id_document_number")
     WHERE "birth_date" IS NULL AND "id_document_type" = 'national_id';
    UPDATE "household_invites"
       SET "birth_date" = egyptian_national_id_birth_date("id_document_number")
     WHERE "birth_date" IS NULL AND "id_document_type" = 'national_id';
    UPDATE "household_members"
       SET "id_document_type" = 'national_id', "nationality" = 'EG'
     WHERE "is_minor";
    UPDATE "units" SET "household_review_flagged_at" = CURRENT_TIMESTAMP
     WHERE "needs_household_review";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ============================================================================
-- Constraints
-- ============================================================================
-- A national ID is Egyptian; a passport names its country and carries a
-- birth date (a national ID's is derived and may be NULL on legacy rows).
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_identity_document"
  CHECK (("id_document_type" = 'national_id' AND "nationality" = 'EG')
      OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'
          AND "birth_date" IS NOT NULL));
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_identity_document"
  CHECK (("id_document_type" = 'national_id' AND "nationality" = 'EG')
      OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'
          AND "birth_date" IS NOT NULL));
ALTER TABLE "domestic_workers" ADD CONSTRAINT "domestic_workers_identity_document"
  CHECK (("id_document_type" = 'national_id' AND "nationality" = 'EG')
      OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'));
ALTER TABLE "domestic_workers" ADD CONSTRAINT "domestic_workers_birth_date_verification"
  CHECK (("birth_date_verified_at" IS NULL) = ("birth_date_verified_by" IS NULL));

-- Minors carry a complete document; adults carry none (it is on their account).
ALTER TABLE "household_members" DROP CONSTRAINT "household_members_minor_or_account";
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_minor_or_account"
  CHECK (
    ("is_minor" AND "account_id" IS NULL AND "full_name" IS NOT NULL
      AND "id_document_number" IS NOT NULL
      AND (("id_document_type" = 'national_id' AND "nationality" = 'EG')
        OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$')))
    OR
    (NOT "is_minor" AND "account_id" IS NOT NULL AND "full_name" IS NULL
      AND "id_document_number" IS NULL AND "id_document_type" IS NULL
      AND "nationality" IS NULL)
  );

ALTER TABLE "units" ADD CONSTRAINT "units_household_review_has_time"
  CHECK ("needs_household_review" = ("household_review_flagged_at" IS NOT NULL));

-- Outbox consistency: sent rows have sent_at; a row is stripped of its
-- personal data only once dead (ADR 0019).
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_sent_at_matches_status"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_stripped_only_when_dead"
  CHECK (("stripped_at" IS NULL AND "recipient" IS NOT NULL AND "params" IS NOT NULL)
      OR ("stripped_at" IS NOT NULL AND "status" = 'dead'
          AND "recipient" IS NULL AND "params" IS NULL));
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_attempts_non_negative"
  CHECK ("attempts" >= 0);

-- ============================================================================
-- Privileges (ADR 0005, 0019): the app purges sent rows after retention.
-- ============================================================================
REVOKE ALL ON "outbox_messages" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_messages" TO jiwar_app;
