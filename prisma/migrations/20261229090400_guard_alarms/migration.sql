-- ============================================================================
-- G8 (ADR 0068): a guard-down alarm. A vendor's wearable (or panic button)
-- calls the server when its guard falls, stops moving or presses panic; the
-- server raises the guard's SOS for them, through the staff's SOS core
-- (ADR 0067), from the post of the shift the device is paired to.
--
-- `guard_alarm_devices`: the wearables the management registers (the
-- vendor's own reference, a label), retired once with a reason.
-- `guard_alarm_pairings`: a guard on shift pairs a device for the shift;
-- one open per device and one per guard; it ends with the shift, a re-pair,
-- an unpair or the device retired.
-- `guard_alarm_events`: every event the vendor sent, once per (device,
-- vendor event) — a replay is a no-op — with what came of it: an emergency
-- raised or joined, the cancel the vendor sent recorded, or, with no
-- pairing (an unknown or unpaired device, or a shift that ended), the
-- control room told. Nothing is dropped. Immutable.
-- ============================================================================

CREATE TABLE "guard_alarm_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_ref" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "registered_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    "retire_reason" TEXT,
    CONSTRAINT "guard_alarm_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_alarm_devices_tenant_id_id_key"
  ON "guard_alarm_devices"("tenant_id", "id");
-- A vendor's device is one live device of the compound's.
CREATE UNIQUE INDEX "guard_alarm_devices_ref_key"
  ON "guard_alarm_devices"("tenant_id", "device_ref") WHERE "retired_at" IS NULL;
ALTER TABLE "guard_alarm_devices"
  ADD CONSTRAINT "guard_alarm_devices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_devices_registered_by_fkey"
  FOREIGN KEY ("tenant_id", "registered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_devices_retired_by_fkey"
  FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guard_alarm_devices" ADD CONSTRAINT "guard_alarm_devices_text"
  CHECK (char_length("device_ref") BETWEEN 1 AND 120
     AND char_length("label") BETWEEN 1 AND 60);
ALTER TABLE "guard_alarm_devices" ADD CONSTRAINT "guard_alarm_devices_retired"
  CHECK (("retired_at" IS NULL) = ("retired_by_account_id" IS NULL)
     AND ("retired_at" IS NULL) = ("retire_reason" IS NULL));

-- A device keeps its reference; its label changes; it is retired once.
CREATE OR REPLACE FUNCTION guard_alarm_device_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."device_ref" = OLD."device_ref"
     AND NEW."registered_by_account_id" = OLD."registered_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."retired_at" IS NULL
          OR (NEW."retired_at" = OLD."retired_at"
              AND NEW."retired_by_account_id" = OLD."retired_by_account_id"
              AND NEW."retire_reason" = OLD."retire_reason"
              AND NEW."label" = OLD."label")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_alarm_devices: a device keeps its reference and is retired once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_alarm_devices_kept
  BEFORE UPDATE OR DELETE ON "guard_alarm_devices"
  FOR EACH ROW EXECUTE FUNCTION guard_alarm_device_kept();
CREATE TRIGGER guard_alarm_devices_no_truncate
  BEFORE TRUNCATE ON "guard_alarm_devices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "guard_alarm_pairings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "paired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    CONSTRAINT "guard_alarm_pairings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_alarm_pairings_tenant_id_id_key"
  ON "guard_alarm_pairings"("tenant_id", "id");
-- One open pairing a device, and one a guard.
CREATE UNIQUE INDEX "guard_alarm_pairings_device_open"
  ON "guard_alarm_pairings"("tenant_id", "device_id") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "guard_alarm_pairings_guard_open"
  ON "guard_alarm_pairings"("tenant_id", "guard_account_id") WHERE "ended_at" IS NULL;
CREATE INDEX "guard_alarm_pairings_shift_idx"
  ON "guard_alarm_pairings"("tenant_id", "shift_id") WHERE "ended_at" IS NULL;
ALTER TABLE "guard_alarm_pairings"
  ADD CONSTRAINT "guard_alarm_pairings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_pairings_device_fkey"
  FOREIGN KEY ("tenant_id", "device_id") REFERENCES "guard_alarm_devices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_pairings_guard_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_pairings_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guard_alarm_pairings" ADD CONSTRAINT "guard_alarm_pairings_end"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("end_reason" IS NULL
          OR "end_reason" IN ('unpaired', 'shift_ended', 'repaired', 'device_retired')));

-- A pairing ends once; nothing else changes.
CREATE OR REPLACE FUNCTION guard_alarm_pairing_ends_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."device_id" = OLD."device_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."shift_id" = OLD."shift_id"
     AND NEW."paired_at" = OLD."paired_at"
     AND OLD."ended_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_alarm_pairings: a pairing ends once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_alarm_pairings_ends_once
  BEFORE UPDATE OR DELETE ON "guard_alarm_pairings"
  FOR EACH ROW EXECUTE FUNCTION guard_alarm_pairing_ends_once();
CREATE TRIGGER guard_alarm_pairings_no_truncate
  BEFORE TRUNCATE ON "guard_alarm_pairings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "guard_alarm_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_ref" TEXT NOT NULL,
    "vendor_event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "device_id" UUID,
    "pairing_id" UUID,
    "guard_account_id" UUID,
    "emergency_id" UUID,
    "outcome" TEXT NOT NULL,
    CONSTRAINT "guard_alarm_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_alarm_events_tenant_id_id_key"
  ON "guard_alarm_events"("tenant_id", "id");
-- A vendor's event is handled once: a replay is a no-op.
CREATE UNIQUE INDEX "guard_alarm_events_vendor_key"
  ON "guard_alarm_events"("tenant_id", "device_ref", "vendor_event_id");
CREATE INDEX "guard_alarm_events_device_idx"
  ON "guard_alarm_events"("tenant_id", "device_ref", "received_at");
ALTER TABLE "guard_alarm_events"
  ADD CONSTRAINT "guard_alarm_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_events_device_fkey"
  FOREIGN KEY ("tenant_id", "device_id") REFERENCES "guard_alarm_devices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_events_pairing_fkey"
  FOREIGN KEY ("tenant_id", "pairing_id") REFERENCES "guard_alarm_pairings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_events_guard_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_alarm_events_emergency_fkey"
  FOREIGN KEY ("tenant_id", "emergency_id") REFERENCES "emergencies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guard_alarm_events" ADD CONSTRAINT "guard_alarm_events_kind"
  CHECK ("kind" IN ('fall', 'no_motion', 'panic', 'cancelled'));
ALTER TABLE "guard_alarm_events" ADD CONSTRAINT "guard_alarm_events_text"
  CHECK (char_length("device_ref") BETWEEN 1 AND 120
     AND char_length("vendor_event_id") BETWEEN 1 AND 200);
-- What came of it, and its shape: an emergency raised or joined has its
-- pairing, guard and emergency; a cancel recorded its emergency; an
-- unpaired one none of them.
ALTER TABLE "guard_alarm_events" ADD CONSTRAINT "guard_alarm_events_outcome"
  CHECK ("outcome" IN ('raised', 'joined', 'cancel_requested', 'cancel_unmatched', 'unpaired')
     AND ("outcome" NOT IN ('raised', 'joined')
          OR ("kind" <> 'cancelled' AND "pairing_id" IS NOT NULL
              AND "guard_account_id" IS NOT NULL AND "emergency_id" IS NOT NULL))
     AND ("outcome" <> 'cancel_requested'
          OR ("kind" = 'cancelled' AND "emergency_id" IS NOT NULL))
     AND ("outcome" <> 'cancel_unmatched'
          OR ("kind" = 'cancelled' AND "emergency_id" IS NULL))
     AND ("outcome" <> 'unpaired'
          OR ("kind" <> 'cancelled' AND "pairing_id" IS NULL AND "emergency_id" IS NULL)));
CREATE TRIGGER guard_alarm_events_immutable
  BEFORE UPDATE OR DELETE ON "guard_alarm_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER guard_alarm_events_no_truncate
  BEFORE TRUNCATE ON "guard_alarm_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: devices and pairings are locked and updated; events only inserted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "guard_alarm_devices", "guard_alarm_pairings", "guard_alarm_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_alarm_devices", "guard_alarm_pairings" TO jiwar_app;
GRANT SELECT, INSERT ON "guard_alarm_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guard_alarm_devices', 'guard_alarm_pairings', 'guard_alarm_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
