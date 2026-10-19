-- ============================================================================
-- Sync health (ADR 0057). Every call a device makes says it is alive
-- (`last_seen_at`); a heartbeat says what it still holds (`pending_count`).
-- The sweep `gate.offline_sync_health` tells the management, once per
-- outage, of a device on an open shift with a live bundle that has not been
-- seen for `gate_settings.offline_sync_alert_minutes`, and once per gap of
-- a sequence that stays open that long.
-- ============================================================================

ALTER TABLE "gate_settings" ADD COLUMN "offline_sync_alert_minutes" SMALLINT NOT NULL DEFAULT 15;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_offline_sync_alert"
  CHECK ("offline_sync_alert_minutes" BETWEEN 5 AND 240);

ALTER TABLE "gate_devices"
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_upload_at" TIMESTAMPTZ(3),
  ADD COLUMN "pending_count" INTEGER,
  ADD COLUMN "overdue_alerted_at" TIMESTAMPTZ(3),
  ADD COLUMN "gap_alerted_at" TIMESTAMPTZ(3);
ALTER TABLE "gate_devices"
  ADD CONSTRAINT "gate_devices_health_shape"
    CHECK (("pending_count" IS NULL OR "pending_count" >= 0)
       AND ("last_upload_at" IS NULL OR "last_seen_at" IS NOT NULL));

-- The device's own times only move forward; the alert stamps too.
CREATE OR REPLACE FUNCTION gate_device_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."public_key" = OLD."public_key"
     AND NEW."label" IS NOT DISTINCT FROM OLD."label"
     AND NEW."enrolled_by_account_id" = OLD."enrolled_by_account_id"
     AND NEW."enrolled_at" = OLD."enrolled_at"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."revoked_at" IS NULL
          OR (NEW."revoked_at" = OLD."revoked_at"
              AND NEW."revoked_by_account_id" = OLD."revoked_by_account_id"
              AND NEW."revoke_reason" = OLD."revoke_reason"))
     AND NEW."bundle_version" >= OLD."bundle_version"
     AND (OLD."last_bundle_at" IS NULL OR NEW."last_bundle_at" >= OLD."last_bundle_at")
     AND NEW."acked_seq" >= OLD."acked_seq"
     AND NEW."max_seq" >= OLD."max_seq"
     AND (OLD."last_seen_at" IS NULL OR NEW."last_seen_at" >= OLD."last_seen_at")
     AND (OLD."last_upload_at" IS NULL OR NEW."last_upload_at" >= OLD."last_upload_at")
     AND (OLD."overdue_alerted_at" IS NULL OR NEW."overdue_alerted_at" >= OLD."overdue_alerted_at")
     AND (OLD."gap_alerted_at" IS NULL OR NEW."gap_alerted_at" >= OLD."gap_alerted_at")
     AND (OLD."rejection_alerted_at" IS NULL OR NEW."rejection_alerted_at" >= OLD."rejection_alerted_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_devices: a device keeps its key and is revoked once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- The sweep's devices: live, seen before.
CREATE INDEX "gate_devices_seen_idx"
  ON "gate_devices"("tenant_id", "last_seen_at") WHERE "revoked_at" IS NULL;
