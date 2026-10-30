-- ============================================================================
-- G8 (ADR 0068): the control room's channel. What the guards' supervisors
-- watch is written here, in the transaction of what caused it, as an
-- outbox: a guard's SOS raised or escalated, a guard-down alarm (paired or
-- not), a lockdown started or ended, the blocklist met at the gate, a field
-- exception raised, a patrol's geofence exit flagged, a gate device that
-- stopped syncing, a gate call missed. Ids and codes only: never a name, a
-- plate or a number. The holders of `control_room.watch` are told in the
-- same transaction; a sweep delivers each row to the control-room vendor at
-- least once, keyed by its id (`skipped` while the driver is off), on a
-- lease like the face gallery's. A watcher acknowledges an event once.
-- ============================================================================

CREATE TABLE "control_room_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "shift_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_account_id" UUID,
    "delivery" TEXT NOT NULL DEFAULT 'pending',
    "delivery_attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_delivery_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "leased_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    CONSTRAINT "control_room_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "control_room_events_tenant_id_id_key"
  ON "control_room_events"("tenant_id", "id");
-- The feed: newest first; what is still to acknowledge.
CREATE INDEX "control_room_events_feed_idx"
  ON "control_room_events"("tenant_id", "occurred_at", "id");
CREATE INDEX "control_room_events_open_idx"
  ON "control_room_events"("tenant_id", "occurred_at", "id")
  WHERE "acknowledged_at" IS NULL;
-- The delivery sweep's work.
CREATE INDEX "control_room_events_delivery_idx"
  ON "control_room_events"("tenant_id", "next_delivery_at")
  WHERE "delivery" = 'pending';
ALTER TABLE "control_room_events"
  ADD CONSTRAINT "control_room_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "control_room_events_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "control_room_events_place_fkey"
  FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "control_room_events_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "control_room_events_acknowledged_by_fkey"
  FOREIGN KEY ("tenant_id", "acknowledged_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_kind"
  CHECK ("kind" IN ('guard_sos_raised', 'guard_sos_escalated', 'guard_alarm', 'guard_alarm_unpaired',
                    'lockdown_started', 'lockdown_ended', 'blocklist_match',
                    'field_exception_raised', 'patrol_geofence_exit', 'device_sync_overdue',
                    'gate_call_missed'));
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_severity"
  CHECK ("severity" IN ('high', 'normal'));
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_source_type"
  CHECK ("source_type" IN ('emergency', 'guard_alarm_event', 'lockdown', 'blocklist_match',
                           'gate_field_exception', 'patrol_geofence_exit', 'gate_device',
                           'gate_call'));
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_delivery"
  CHECK ("delivery" IN ('pending', 'delivered', 'skipped'));
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_error"
  CHECK ("last_error" IS NULL
      OR "last_error" IN ('timeout', 'unavailable', 'rejected', 'bad_response', 'off'));
-- Acknowledged by someone, or not at all; delivered once, with its instant.
ALTER TABLE "control_room_events" ADD CONSTRAINT "control_room_events_shape"
  CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by_account_id" IS NULL)
     AND ("delivery" = 'delivered') = ("delivered_at" IS NOT NULL)
     AND "delivery_attempts" >= 0);

-- An event never changes what it says; it is acknowledged once and
-- delivered (or skipped) once.
CREATE OR REPLACE FUNCTION control_room_event_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."severity" = OLD."severity"
     AND NEW."source_type" = OLD."source_type"
     AND NEW."source_id" = OLD."source_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."shift_id" IS NOT DISTINCT FROM OLD."shift_id"
     AND NEW."occurred_at" = OLD."occurred_at"
     AND (OLD."acknowledged_at" IS NULL
          OR (NEW."acknowledged_at" = OLD."acknowledged_at"
              AND NEW."acknowledged_by_account_id" = OLD."acknowledged_by_account_id"))
     AND (OLD."delivery" = 'pending' OR NEW."delivery" = OLD."delivery")
     AND (OLD."delivered_at" IS NULL OR NEW."delivered_at" = OLD."delivered_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'control_room_events: an event is acknowledged and delivered once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER control_room_events_kept
  BEFORE UPDATE OR DELETE ON "control_room_events"
  FOR EACH ROW EXECUTE FUNCTION control_room_event_kept();
CREATE TRIGGER control_room_events_no_truncate
  BEFORE TRUNCATE ON "control_room_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "control_room_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "control_room_events" TO jiwar_app;
ALTER TABLE "control_room_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "control_room_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "control_room_events"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
