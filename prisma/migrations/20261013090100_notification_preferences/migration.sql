-- ============================================================================
-- Phase R1 — notification preferences (ADR 0036).
--
-- Per category × channel, never per kind. The inbox always records
-- everything; these decide only whether and when a delivery channel (email
-- now, push later) carries it. Defaults are the absence of rows: every
-- switch on, no quiet hours, no pause — so a new compound needs nothing.
-- ============================================================================

CREATE TYPE "notification_category" AS ENUM
  ('maintenance', 'gate_visitors', 'parcels', 'household', 'account_security');
CREATE TYPE "delivery_channel" AS ENUM ('email', 'push');

-- Quiet hours and pause, one row per account at most. Every preference
-- change locks it (inserted first when missing), so changes never race.
CREATE TABLE "notification_settings" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    -- Minutes after local midnight in the compound's time zone.
    "quiet_start_minute" SMALLINT,
    "quiet_end_minute" SMALLINT,
    "paused_until" TIMESTAMPTZ(3),
    "paused_indefinitely" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("tenant_id", "account_id")
);
ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_quiet_shape"
  CHECK (("quiet_start_minute" IS NULL) = ("quiet_end_minute" IS NULL)
     AND ("quiet_start_minute" IS NULL
          OR ("quiet_start_minute" BETWEEN 0 AND 1439
              AND "quiet_end_minute" BETWEEN 0 AND 1439
              AND "quiet_start_minute" <> "quiet_end_minute")));
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_pause_shape"
  CHECK (NOT ("paused_indefinitely" AND "paused_until" IS NOT NULL));

-- One switch per (account, category, channel). No row: on.
CREATE TABLE "notification_channel_prefs" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "channel" "delivery_channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_channel_prefs_pkey"
      PRIMARY KEY ("tenant_id", "account_id", "category", "channel")
);
ALTER TABLE "notification_channel_prefs"
  ADD CONSTRAINT "notification_channel_prefs_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The outbox (ADR 0019): a message the account's preferences held carries
-- `held_at`; it is re-decided whenever those preferences change, and the
-- outbox retention deletes one held more than 7 days that has an inbox twin.
-- ----------------------------------------------------------------------------
ALTER TABLE "outbox_messages" ADD COLUMN "held_at" TIMESTAMPTZ(3);
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_held_shape"
  CHECK ("status" <> 'held' OR ("held_at" IS NOT NULL AND "recipient_account_id" IS NOT NULL));
CREATE INDEX "outbox_messages_held_idx"
  ON "outbox_messages"("held_at") WHERE "held_at" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Erasure deletes an account's rows.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "notification_settings", "notification_channel_prefs" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "notification_settings", "notification_channel_prefs" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_settings', 'notification_channel_prefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
