-- ============================================================================
-- Parcels (ADR 0035): received at the gate for a unit, told to its residents,
-- handed over against a derived code, a resident's QR or a delegate's code.
--
-- Personal data here: `parcels.label_name`, `parcel_credentials.delegate_name`,
-- the two photos and `handed_to_account_id`. The 30-day retention sweep
-- clears them; the rows and `parcel_events` stay.
-- ============================================================================

CREATE TYPE "parcel_status" AS ENUM ('held', 'handed_over', 'rejected', 'returned');
CREATE TYPE "parcel_carrier" AS ENUM ('aramex', 'dhl', 'fedex', 'ups', 'bosta', 'mylerz', 'egypt_post', 'amazon', 'noon', 'jumia', 'talabat', 'other');
CREATE TYPE "parcel_method" AS ENUM ('code', 'resident_qr', 'delegate');
CREATE TYPE "parcel_event_kind" AS ENUM ('received', 'delegate_authorized', 'delegate_revoked', 'handed_over', 'rejected', 'returned');
CREATE TYPE "parcel_actor_side" AS ENUM ('guard', 'resident', 'system');
CREATE TYPE "parcel_credential_kind" AS ENUM ('holder', 'delegate');

-- ----------------------------------------------------------------------------
-- Settings and the number counter: one row per compound, created with it and
-- backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "parcel_settings" (
    "tenant_id" UUID NOT NULL,
    "parcel_reminder_days" INTEGER NOT NULL DEFAULT 3,
    "parcel_manager_days" INTEGER NOT NULL DEFAULT 14,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "parcel_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "parcel_settings"
  ADD CONSTRAINT "parcel_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "parcel_settings"
  ADD CONSTRAINT "parcel_settings_ranges"
  CHECK ("parcel_reminder_days" BETWEEN 1 AND 30
     AND "parcel_manager_days" BETWEEN 2 AND 90
     AND "parcel_reminder_days" < "parcel_manager_days");

CREATE TABLE "parcel_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "parcel_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "parcel_counters"
  ADD CONSTRAINT "parcel_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The parcel.
-- ----------------------------------------------------------------------------
CREATE TABLE "parcels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "received_by_account_id" UUID NOT NULL,
    "carrier" "parcel_carrier" NOT NULL,
    "pieces" INTEGER NOT NULL,
    "label_name" TEXT,
    "photo_file_id" UUID,
    "handover_photo_file_id" UUID,
    "status" "parcel_status" NOT NULL DEFAULT 'held',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handed_over_at" TIMESTAMPTZ(3),
    "handed_over_method" "parcel_method",
    "handed_to_account_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "returned_at" TIMESTAMPTZ(3),
    "return_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "reminded_at" TIMESTAMPTZ(3),
    "held_long_at" TIMESTAMPTZ(3),
    "unclaimable_notified_at" TIMESTAMPTZ(3),
    "data_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "parcels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "parcels_tenant_id_id_key" ON "parcels"("tenant_id", "id");
CREATE UNIQUE INDEX "parcels_tenant_id_number_key" ON "parcels"("tenant_id", "number");
CREATE INDEX "parcels_tenant_id_status_received_at_idx"
  ON "parcels"("tenant_id", "status", "received_at" DESC, "id" DESC);
CREATE INDEX "parcels_tenant_id_unit_id_idx"
  ON "parcels"("tenant_id", "unit_id", "received_at" DESC);
-- The retention sweep's work: closed and not yet cleared.
CREATE INDEX "parcels_retention_idx"
  ON "parcels"("tenant_id", "closed_at") WHERE "data_cleared_at" IS NULL AND "closed_at" IS NOT NULL;

ALTER TABLE "parcels" ADD CONSTRAINT "parcels_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_tenant_id_photo_file_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_tenant_id_handover_photo_file_fkey"
  FOREIGN KEY ("tenant_id", "handover_photo_file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "parcels" ADD CONSTRAINT "parcels_pieces" CHECK ("pieces" BETWEEN 1 AND 20);
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_label_name_length"
  CHECK ("label_name" IS NULL OR char_length("label_name") BETWEEN 1 AND 80);
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_reject_reason"
  CHECK ("reject_reason" IS NULL OR "reject_reason" IN ('not_ours', 'not_expected', 'other'));
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_return_reason"
  CHECK ("return_reason" IS NULL OR "return_reason" IN ('rejected', 'unclaimed'));
-- Each status has exactly its own columns. Every comparison on a nullable
-- column sits beside its IS [NOT] NULL.
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_status_shape" CHECK (
  ("status" = 'held'
     AND "handed_over_at" IS NULL AND "handed_over_method" IS NULL
     AND "rejected_at" IS NULL AND "reject_reason" IS NULL
     AND "returned_at" IS NULL AND "return_reason" IS NULL
     AND "closed_at" IS NULL)
  OR ("status" = 'handed_over'
     AND "handed_over_at" IS NOT NULL AND "handed_over_method" IS NOT NULL
     AND "closed_at" IS NOT NULL
     AND "rejected_at" IS NULL AND "reject_reason" IS NULL
     AND "returned_at" IS NULL AND "return_reason" IS NULL)
  OR ("status" = 'rejected'
     AND "rejected_at" IS NOT NULL AND "reject_reason" IS NOT NULL
     AND "handed_over_at" IS NULL AND "handed_over_method" IS NULL
     AND "returned_at" IS NULL AND "return_reason" IS NULL
     AND "closed_at" IS NULL)
  OR ("status" = 'returned'
     AND "returned_at" IS NOT NULL AND "return_reason" IS NOT NULL
     AND "closed_at" IS NOT NULL
     AND "handed_over_at" IS NULL AND "handed_over_method" IS NULL
     AND (("return_reason" = 'rejected'
            AND "rejected_at" IS NOT NULL AND "reject_reason" IS NOT NULL)
       OR ("return_reason" = 'unclaimed'
            AND "rejected_at" IS NULL AND "reject_reason" IS NULL)))
);
-- The recipient's id exists only for a resident-QR hand-over.
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_handed_to"
  CHECK ("handed_to_account_id" IS NULL
     OR ("handed_over_method" IS NOT NULL AND "handed_over_method" = 'resident_qr'));
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_handover_photo"
  CHECK ("handover_photo_file_id" IS NULL OR "status" = 'handed_over');
-- Cleared means cleared: after the 30 days nothing personal is left.
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_data_cleared"
  CHECK ("data_cleared_at" IS NULL
     OR ("closed_at" IS NOT NULL
         AND "label_name" IS NULL AND "photo_file_id" IS NULL
         AND "handover_photo_file_id" IS NULL AND "handed_to_account_id" IS NULL));

-- ----------------------------------------------------------------------------
-- The codes: a holder credential per parcel and at most one live delegate.
-- Only HMACs, only while live; the token behind them is derived from
-- PARCEL_TOKEN_KEY from (id, attempt), so nothing here can show a code.
-- ----------------------------------------------------------------------------
CREATE TABLE "parcel_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "kind" "parcel_credential_kind" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "code_hash" CHAR(64),
    "qr_token_hash" CHAR(64),
    "delegate_name" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    CONSTRAINT "parcel_credentials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "parcel_credentials_parcel_idx" ON "parcel_credentials"("tenant_id", "parcel_id");
ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_tenant_id_parcel_id_fkey"
  FOREIGN KEY ("tenant_id", "parcel_id") REFERENCES "parcels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A live credential is findable by its code and by its QR, in its compound
-- alone; holder and delegate codes share one code space.
CREATE UNIQUE INDEX "parcel_credentials_live_code"
  ON "parcel_credentials"("tenant_id", "code_hash") WHERE "code_hash" IS NOT NULL;
CREATE UNIQUE INDEX "parcel_credentials_live_qr"
  ON "parcel_credentials"("tenant_id", "qr_token_hash") WHERE "qr_token_hash" IS NOT NULL;
CREATE UNIQUE INDEX "parcel_credentials_one_holder"
  ON "parcel_credentials"("tenant_id", "parcel_id") WHERE "kind" = 'holder';
CREATE UNIQUE INDEX "parcel_credentials_one_live_delegate"
  ON "parcel_credentials"("tenant_id", "parcel_id") WHERE "kind" = 'delegate' AND "ended_at" IS NULL;
-- The lifecycle hooks look up the delegates an account authorized.
CREATE INDEX "parcel_credentials_authorizer_idx"
  ON "parcel_credentials"("tenant_id", "created_by_account_id")
  WHERE "kind" = 'delegate' AND "ended_at" IS NULL;

ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_attempt" CHECK ("attempt" >= 0);
-- Both hashes together, and only while the credential is live.
ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_hashes_while_live"
  CHECK (("code_hash" IS NULL) = ("qr_token_hash" IS NULL)
     AND ("code_hash" IS NULL) = ("ended_at" IS NOT NULL));
ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_end"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("end_reason" IS NULL OR "end_reason" IN
           ('revoked', 'authorizer_left', 'handed_over', 'rejected', 'returned')));
ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_delegate_name"
  CHECK ("delegate_name" IS NULL
     OR ("kind" = 'delegate' AND char_length("delegate_name") BETWEEN 1 AND 80));
-- A delegate who was revoked, or whose authorizer left, keeps no name.
ALTER TABLE "parcel_credentials" ADD CONSTRAINT "parcel_credentials_revoked_keeps_no_name"
  CHECK ("end_reason" IS NULL
     OR "end_reason" NOT IN ('revoked', 'authorizer_left')
     OR "delegate_name" IS NULL);

-- ----------------------------------------------------------------------------
-- The event log. Append-only like the audit tables: jiwar_app has SELECT and
-- INSERT, and triggers refuse the rest for every role. No foreign keys, no
-- free text.
-- ----------------------------------------------------------------------------
CREATE TABLE "parcel_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "kind" "parcel_event_kind" NOT NULL,
    "actor_side" "parcel_actor_side" NOT NULL,
    "actor_account_id" UUID,
    "method" "parcel_method",
    "reason_code" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "parcel_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "parcel_events_parcel_idx" ON "parcel_events"("tenant_id", "parcel_id", "at", "id");
ALTER TABLE "parcel_events" ADD CONSTRAINT "parcel_events_system_has_no_account"
  CHECK (("actor_side" = 'system') = ("actor_account_id" IS NULL));
-- A method only for a hand-over; a reason only where a reason code exists.
ALTER TABLE "parcel_events" ADD CONSTRAINT "parcel_events_method"
  CHECK (("kind" = 'handed_over') = ("method" IS NOT NULL));
ALTER TABLE "parcel_events" ADD CONSTRAINT "parcel_events_reason"
  CHECK (("kind" IN ('rejected', 'returned', 'delegate_revoked')) = ("reason_code" IS NOT NULL)
     AND ("reason_code" IS NULL OR "reason_code" IN
           ('not_ours', 'not_expected', 'other', 'rejected', 'unclaimed', 'revoked', 'authorizer_left')));

CREATE TRIGGER parcel_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "parcel_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER parcel_events_immutable_truncate
  BEFORE TRUNCATE ON "parcel_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted by the app.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "parcel_settings", "parcel_counters", "parcels",
  "parcel_credentials", "parcel_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "parcel_settings", "parcel_counters", "parcels",
  "parcel_credentials" TO jiwar_app;
GRANT SELECT, INSERT ON "parcel_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parcel_settings', 'parcel_counters', 'parcels',
    'parcel_credentials', 'parcel_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (ParcelProvisioning). FORCE RLS
-- applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "parcel_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
    INSERT INTO "parcel_counters" ("tenant_id") VALUES (t."id");
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

