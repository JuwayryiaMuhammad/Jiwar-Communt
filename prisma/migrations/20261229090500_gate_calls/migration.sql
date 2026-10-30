-- ============================================================================
-- G8 (ADR 0068): a masked call from the gate. A guard on shift calls a
-- unit's household in the app, through the call vendor's rooms (VoIP): no
-- phone number reaches the vendor or the guard, and the guard never learns
-- who answered — "the household answered". The household members a gate
-- request goes to (`visitorsInvite`) are rung; the first to answer takes
-- it.
--
-- `gate_calls`: one live (ringing or answered) per guard and per unit; it
-- rings for `gate_settings.call_ring_seconds` (45; 15–120), then is missed;
-- answered, it lasts at most `call_max_seconds` (300; 60–900). It moves
-- forward and ends once; its room is closed once, after.
-- `gate_call_vendor_events`: the vendor's events about a room, once each;
-- immutable.
-- ============================================================================

ALTER TABLE "gate_settings"
  ADD COLUMN "call_ring_seconds" SMALLINT NOT NULL DEFAULT 45,
  ADD COLUMN "call_max_seconds" SMALLINT NOT NULL DEFAULT 300;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_call_seconds"
  CHECK ("call_ring_seconds" BETWEEN 15 AND 120
     AND "call_max_seconds" BETWEEN 60 AND 900);

CREATE TABLE "gate_calls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "approval_request_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ringing',
    "room_ref" TEXT,
    "answered_by_account_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "answered_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "room_closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "gate_calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_calls_tenant_id_id_key" ON "gate_calls"("tenant_id", "id");
-- One live call a guard, and one a unit.
CREATE UNIQUE INDEX "gate_calls_guard_live"
  ON "gate_calls"("tenant_id", "guard_account_id") WHERE "status" IN ('ringing', 'answered');
CREATE UNIQUE INDEX "gate_calls_unit_live"
  ON "gate_calls"("tenant_id", "unit_id") WHERE "status" IN ('ringing', 'answered');
-- A room is one call's.
CREATE UNIQUE INDEX "gate_calls_room_key"
  ON "gate_calls"("tenant_id", "room_ref") WHERE "room_ref" IS NOT NULL;
-- The timeouts' and the rooms' sweep.
CREATE INDEX "gate_calls_live_idx"
  ON "gate_calls"("tenant_id", "started_at") WHERE "status" IN ('ringing', 'answered');
CREATE INDEX "gate_calls_room_open_idx"
  ON "gate_calls"("tenant_id", "ended_at")
  WHERE "room_ref" IS NOT NULL AND "room_closed_at" IS NULL AND "ended_at" IS NOT NULL;
ALTER TABLE "gate_calls"
  ADD CONSTRAINT "gate_calls_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_guard_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_approval_request_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "gate_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_calls_answered_by_fkey"
  FOREIGN KEY ("tenant_id", "answered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_calls" ADD CONSTRAINT "gate_calls_reason"
  CHECK ("reason_code" IN ('visitor_at_gate', 'delivery_at_gate', 'worker_at_gate',
                           'request_unanswered', 'other'));
ALTER TABLE "gate_calls" ADD CONSTRAINT "gate_calls_status"
  CHECK ("status" IN ('ringing', 'answered', 'declined', 'missed', 'ended'));
ALTER TABLE "gate_calls" ADD CONSTRAINT "gate_calls_end_reason"
  CHECK ("end_reason" IS NULL
      OR "end_reason" IN ('guard', 'resident', 'declined', 'missed', 'max_duration',
                          'shift_ended', 'vendor', 'unavailable'));
ALTER TABLE "gate_calls" ADD CONSTRAINT "gate_calls_room_ref"
  CHECK ("room_ref" IS NULL OR char_length("room_ref") BETWEEN 1 AND 200);
-- Each status's shape: answered has who and when; a final one its end.
ALTER TABLE "gate_calls" ADD CONSTRAINT "gate_calls_shape"
  CHECK ((("answered_at" IS NULL) = ("answered_by_account_id" IS NULL))
     AND ("status" <> 'answered' OR ("answered_at" IS NOT NULL AND "ended_at" IS NULL))
     AND ("status" <> 'ringing' OR ("answered_at" IS NULL AND "ended_at" IS NULL))
     AND (("status" IN ('declined', 'missed', 'ended')) = ("ended_at" IS NOT NULL))
     AND (("ended_at" IS NULL) = ("end_reason" IS NULL))
     AND ("room_closed_at" IS NULL OR "ended_at" IS NOT NULL));

-- A call moves forward: ringing → answered | declined | missed | ended;
-- answered → ended; its room is set once and closed once.
CREATE OR REPLACE FUNCTION gate_call_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."shift_id" = OLD."shift_id"
     AND NEW."gate_id" = OLD."gate_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id"
     AND NEW."started_at" = OLD."started_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'ringing' AND NEW."status" IN ('answered', 'declined', 'missed', 'ended'))
          OR (OLD."status" = 'answered' AND NEW."status" = 'ended'))
     AND (OLD."room_ref" IS NULL OR NEW."room_ref" = OLD."room_ref")
     AND (OLD."answered_at" IS NULL
          OR (NEW."answered_at" = OLD."answered_at"
              AND NEW."answered_by_account_id" = OLD."answered_by_account_id"))
     AND (OLD."ended_at" IS NULL
          OR (NEW."ended_at" = OLD."ended_at" AND NEW."end_reason" = OLD."end_reason"))
     AND (OLD."room_closed_at" IS NULL OR NEW."room_closed_at" = OLD."room_closed_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_calls: a call only moves forward and ends once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_calls_moves_forward
  BEFORE UPDATE OR DELETE ON "gate_calls"
  FOR EACH ROW EXECUTE FUNCTION gate_call_moves_forward();
CREATE TRIGGER gate_calls_no_truncate
  BEFORE TRUNCATE ON "gate_calls"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "gate_call_vendor_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "call_id" UUID,
    "room_ref" TEXT NOT NULL,
    "vendor_event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "gate_call_vendor_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_call_vendor_events_tenant_id_id_key"
  ON "gate_call_vendor_events"("tenant_id", "id");
-- A vendor's event is taken once.
CREATE UNIQUE INDEX "gate_call_vendor_events_vendor_key"
  ON "gate_call_vendor_events"("tenant_id", "vendor_event_id");
ALTER TABLE "gate_call_vendor_events"
  ADD CONSTRAINT "gate_call_vendor_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_call_vendor_events_call_fkey"
  FOREIGN KEY ("tenant_id", "call_id") REFERENCES "gate_calls"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_call_vendor_events" ADD CONSTRAINT "gate_call_vendor_events_kind"
  CHECK ("kind" IN ('participant_joined', 'participant_left', 'room_closed'));
ALTER TABLE "gate_call_vendor_events" ADD CONSTRAINT "gate_call_vendor_events_text"
  CHECK (char_length("room_ref") BETWEEN 1 AND 200
     AND char_length("vendor_event_id") BETWEEN 1 AND 200);
CREATE TRIGGER gate_call_vendor_events_immutable
  BEFORE UPDATE OR DELETE ON "gate_call_vendor_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_call_vendor_events_no_truncate
  BEFORE TRUNCATE ON "gate_call_vendor_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_calls", "gate_call_vendor_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_calls" TO jiwar_app;
GRANT SELECT, INSERT ON "gate_call_vendor_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gate_calls', 'gate_call_vendor_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
