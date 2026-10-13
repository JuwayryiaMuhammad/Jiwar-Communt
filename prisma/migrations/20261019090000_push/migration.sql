-- ============================================================================
-- Phase P1 — push notifications through FCM (ADR 0041).
--
-- Two GLOBAL tables, like sessions and outbox_messages (no RLS; tenant_id is
-- a pointer):
--
-- * push_devices: one FCM token per account and install. It belongs to the
--   session that registered it (sessions are global, and a logout runs with
--   no compound set), and a token is one row across every compound: an
--   install that signs in to another account takes its token with it.
-- * push_deliveries: the push outbox, one row per notification and device,
--   claimed across compounds in one statement like the email outbox.
--
-- The token is a secret in practice. It lives in push_devices.token and
-- nowhere else: push_deliveries points at the device and holds no text.
-- ============================================================================

CREATE TYPE "push_platform" AS ENUM ('android', 'ios');
CREATE TYPE "push_status" AS ENUM ('pending', 'processing', 'sent', 'dead');

CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "install_hash" CHAR(64) NOT NULL,
    "platform" "push_platform" NOT NULL,
    "token" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);
-- One active token per install; a re-registration replaces it.
CREATE UNIQUE INDEX "push_devices_account_id_install_hash_key"
  ON "push_devices"("account_id", "install_hash");
CREATE UNIQUE INDEX "push_devices_token_hash_key" ON "push_devices"("token_hash");
CREATE INDEX "push_devices_session_id_idx" ON "push_devices"("session_id");
CREATE INDEX "push_devices_tenant_id_idx" ON "push_devices"("tenant_id");
-- Erasure deletes the account's sessions: its devices go with them.
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_token_present"
  CHECK ("token" <> '');

CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "status" "push_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);
-- A notification is pushed at most once per device.
CREATE UNIQUE INDEX "push_deliveries_notification_id_device_id_key"
  ON "push_deliveries"("notification_id", "device_id");
CREATE INDEX "push_deliveries_status_next_attempt_at_idx"
  ON "push_deliveries"("status", "next_attempt_at");
CREATE INDEX "push_deliveries_device_id_idx" ON "push_deliveries"("device_id");
-- A removed token takes what was still to be sent to it.
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "push_devices"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_attempts_non_negative"
  CHECK ("attempts" >= 0);
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_sent_at_matches_status"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

REVOKE ALL ON "push_devices", "push_deliveries" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_devices", "push_deliveries" TO jiwar_app;
