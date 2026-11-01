-- ============================================================================
-- Fit-out completion (ADR 0074): a works permit's debris removals.
-- ============================================================================
--
-- An approved works permit's household (the requester, the unit's primary)
-- or the management schedules a window to take the works' debris out: a
-- local day of the permit's period that is a work day, inside the
-- compound's hours, 30 minutes to 4 hours, starting ahead; at most three
-- scheduled at once, never two overlapping. The window is kept as its local
-- day and minutes and as the instants they were then. The management or a
-- guard on shift marks one done once its window is near; one nobody marked
-- two hours past its end is missed (the `permits.debris_missed` sweep).
-- Whoever scheduled it, or the management, calls one off before it starts,
-- with a code (REASON_CODES.debrisSlotCancel). A removal moves once from
-- scheduled and never goes.

CREATE TABLE "permit_debris_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "day" DATE NOT NULL,
    "from_minute" SMALLINT NOT NULL,
    "to_minute" SMALLINT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_by" UUID NOT NULL,
    "scheduled_side" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "done_at" TIMESTAMPTZ(3),
    "done_by" UUID,
    "done_side" TEXT,
    "missed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_side" TEXT,
    "cancel_reason" TEXT,
    CONSTRAINT "permit_debris_slots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_debris_slots_tenant_id_id_key" ON "permit_debris_slots"("tenant_id", "id");
CREATE INDEX "permit_debris_slots_permit_idx" ON "permit_debris_slots"("tenant_id", "permit_id", "starts_at");
CREATE INDEX "permit_debris_slots_due_idx" ON "permit_debris_slots"("tenant_id", "ends_at")
  WHERE "status" = 'scheduled';
ALTER TABLE "permit_debris_slots"
  ADD CONSTRAINT "permit_debris_slots_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_debris_slots_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_debris_slots_scheduled_by_fkey"
  FOREIGN KEY ("tenant_id", "scheduled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_debris_slots_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_debris_slots_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The window: inside a day, 30 minutes to 4 hours.
ALTER TABLE "permit_debris_slots" ADD CONSTRAINT "permit_debris_slots_window"
  CHECK ("permit_kind" = 'works'
     AND "from_minute" >= 0 AND "to_minute" <= 1440
     AND "to_minute" - "from_minute" BETWEEN 30 AND 240
     AND "ends_at" > "starts_at"
     AND "scheduled_side" IN ('resident', 'staff'));
-- The status and the columns that say it, set together.
ALTER TABLE "permit_debris_slots" ADD CONSTRAINT "permit_debris_slots_state_shape"
  CHECK ("status" IN ('scheduled', 'done', 'missed', 'cancelled')
     AND ("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("done_at" IS NULL) = ("done_by" IS NULL)
     AND ("done_at" IS NULL) = ("done_side" IS NULL)
     AND ("done_side" IS NULL OR "done_side" IN ('staff', 'gate'))
     AND ("status" = 'missed') = ("missed_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_side" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_side" IS NULL OR "cancel_side" IN ('resident', 'staff'))
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('plans_changed', 'not_needed', 'other')));

-- What was scheduled never changes; a removal moves once from scheduled.
CREATE FUNCTION permit_debris_slot_moves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."day" = OLD."day"
     AND NEW."from_minute" = OLD."from_minute"
     AND NEW."to_minute" = OLD."to_minute"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."scheduled_by" = OLD."scheduled_by"
     AND NEW."scheduled_side" = OLD."scheduled_side"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" = 'scheduled' AND NEW."status" <> 'scheduled' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_debris_slots: a removal keeps its window and moves once from scheduled (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_debris_slots_moves_once
  BEFORE UPDATE OR DELETE ON "permit_debris_slots"
  FOR EACH ROW EXECUTE FUNCTION permit_debris_slot_moves_once();
CREATE TRIGGER permit_debris_slots_no_truncate
  BEFORE TRUNCATE ON "permit_debris_slots"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT, UPDATE ON "permit_debris_slots" TO jiwar_app;
ALTER TABLE "permit_debris_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permit_debris_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "permit_debris_slots"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
