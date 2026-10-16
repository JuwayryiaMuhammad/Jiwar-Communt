-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the roster.
-- ============================================================================
--
-- The management schedules guards at a post (a gate or a zone): weekly
-- templates that repeat, made into slots ahead of time, and single slots.
-- Opening a shift links it to the guard's slot at that post; a slot not
-- opened an hour after its start is marked absent. A shift's overtime (a
-- linked one) or its unscheduled minutes (one with no slot) are recorded
-- when it ends. Nothing here is ever deleted.

CREATE TYPE "guard_slot_status" AS ENUM ('scheduled', 'cancelled');

-- ----------------------------------------------------------------------------
-- Templates: a guard, a post, a weekly schedule (the shape of
-- src/core/common/slots/weekly-schedule.ts) and the days it applies.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_roster_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "schedule" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_until" DATE,
    "created_by_account_id" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    "end_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_roster_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_roster_templates_tenant_id_id_key"
  ON "guard_roster_templates"("tenant_id", "id");
CREATE INDEX "guard_roster_templates_guard_idx"
  ON "guard_roster_templates"("tenant_id", "guard_account_id");
CREATE INDEX "guard_roster_templates_live_idx"
  ON "guard_roster_templates"("tenant_id", "id") WHERE "ended_at" IS NULL;

ALTER TABLE "guard_roster_templates"
  ADD CONSTRAINT "guard_roster_templates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_templates_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_templates_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_templates_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_templates_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_templates_tenant_id_ended_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guard_roster_templates"
  ADD CONSTRAINT "guard_roster_templates_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  ADD CONSTRAINT "guard_roster_templates_until_after_from"
    CHECK ("effective_until" IS NULL OR "effective_until" >= "effective_from"),
  ADD CONSTRAINT "guard_roster_templates_schedule_shape"
    CHECK (jsonb_typeof("schedule") = 'object'
           AND jsonb_typeof("schedule"->'days') = 'array'
           AND jsonb_typeof("schedule"->'windows') = 'array'),
  ADD CONSTRAINT "guard_roster_templates_end_is_complete"
    CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)),
  -- REASON_CODES.guardTemplateEnd (src/core/common/reasons.ts); a unit test
  -- keeps them in step. `manager` carries the one who ended it.
  ADD CONSTRAINT "guard_roster_templates_end_reason"
    CHECK ("end_reason" IS NULL OR "end_reason" IN ('manager', 'guard_left')),
  ADD CONSTRAINT "guard_roster_templates_end_by"
    CHECK ("end_reason" IS NULL OR ("end_reason" = 'manager') = ("ended_by_account_id" IS NOT NULL));

-- What a template says never changes; it is ended once.
CREATE FUNCTION guard_roster_template_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."schedule" = OLD."schedule"
     AND NEW."effective_from" = OLD."effective_from"
     AND NEW."effective_until" IS NOT DISTINCT FROM OLD."effective_until"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
           AND NEW."ended_by_account_id" IS NOT DISTINCT FROM OLD."ended_by_account_id"
           AND NEW."end_reason" IS NOT DISTINCT FROM OLD."end_reason")
          OR OLD."ended_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_roster_templates: a template keeps what it says, is ended once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_roster_templates_kept
  BEFORE UPDATE OR DELETE ON "guard_roster_templates"
  FOR EACH ROW EXECUTE FUNCTION guard_roster_template_is_kept();
CREATE TRIGGER guard_roster_templates_kept_truncate
  BEFORE TRUNCATE ON "guard_roster_templates"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Slots: one scheduled shift of one guard at one post.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_roster_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "template_id" UUID,
    "created_by_account_id" UUID,
    "status" "guard_slot_status" NOT NULL DEFAULT 'scheduled',
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    "shift_id" UUID,
    "late_minutes" INTEGER,
    "absent_at" TIMESTAMPTZ(3),
    "swapped_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_roster_slots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_roster_slots_tenant_id_id_key"
  ON "guard_roster_slots"("tenant_id", "id");
-- A shift fills one slot at most.
CREATE UNIQUE INDEX "guard_roster_slots_shift_key"
  ON "guard_roster_slots"("tenant_id", "shift_id");
-- A template makes each of its slots once, cancelled ones included: the
-- sweep never makes again what the management cancelled.
CREATE UNIQUE INDEX "guard_roster_slots_template_start_key"
  ON "guard_roster_slots"("tenant_id", "template_id", "starts_at")
  WHERE "template_id" IS NOT NULL;
CREATE INDEX "guard_roster_slots_guard_idx"
  ON "guard_roster_slots"("tenant_id", "guard_account_id", "starts_at");
CREATE INDEX "guard_roster_slots_start_idx"
  ON "guard_roster_slots"("tenant_id", "starts_at", "id");
-- What the attendance sweep looks at.
CREATE INDEX "guard_roster_slots_unopened_idx"
  ON "guard_roster_slots"("tenant_id", "starts_at")
  WHERE "status" = 'scheduled' AND "shift_id" IS NULL AND "absent_at" IS NULL;

ALTER TABLE "guard_roster_slots"
  ADD CONSTRAINT "guard_roster_slots_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_template_id_fkey"
    FOREIGN KEY ("tenant_id", "template_id") REFERENCES "guard_roster_templates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_cancelled_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_roster_slots_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guard_roster_slots"
  ADD CONSTRAINT "guard_roster_slots_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  ADD CONSTRAINT "guard_roster_slots_ends_after_start"
    CHECK ("ends_at" > "starts_at"),
  -- A slot lasts a day at most.
  ADD CONSTRAINT "guard_roster_slots_at_most_a_day"
    CHECK ("ends_at" <= "starts_at" + interval '24 hours'),
  -- A template's slot is the system's; a single slot names who added it.
  ADD CONSTRAINT "guard_roster_slots_made_by"
    CHECK (("template_id" IS NULL) = ("created_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "guard_roster_slots_cancel_is_complete"
    CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
           AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)),
  -- REASON_CODES.guardSlotCancel (src/core/common/reasons.ts); a unit test
  -- keeps them in step. The management names one of the first four; the
  -- system the rest.
  ADD CONSTRAINT "guard_roster_slots_cancel_reason"
    CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('schedule_change', 'guard_unavailable', 'post_closed', 'other', 'template_ended', 'guard_left')),
  ADD CONSTRAINT "guard_roster_slots_cancelled_by"
    CHECK ("cancel_reason" IS NULL
           OR ("cancel_reason" IN ('template_ended', 'guard_left')) = ("cancelled_by_account_id" IS NULL)),
  -- A slot a shift filled was not cancelled, and its lateness came with it.
  ADD CONSTRAINT "guard_roster_slots_filled_shape"
    CHECK (("shift_id" IS NULL) = ("late_minutes" IS NULL)
           AND ("shift_id" IS NULL OR "status" = 'scheduled')),
  ADD CONSTRAINT "guard_roster_slots_late_minutes_range"
    CHECK ("late_minutes" IS NULL OR "late_minutes" >= 0);

-- A slot keeps its post and its times. It is cancelled once, filled once,
-- marked absent once; it changes guard only by a swap, while nobody has
-- opened it (`swapped_at` moves with the guard). Once cancelled, nothing
-- changes.
CREATE FUNCTION guard_roster_slot_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."template_id" IS NOT DISTINCT FROM OLD."template_id"
     AND NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" = 'scheduled'
     AND ((NEW."status" = OLD."status"
           AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR NEW."status" = 'cancelled')
     AND ((NEW."shift_id" IS NOT DISTINCT FROM OLD."shift_id"
           AND NEW."late_minutes" IS NOT DISTINCT FROM OLD."late_minutes")
          OR OLD."shift_id" IS NULL)
     AND (NEW."absent_at" IS NOT DISTINCT FROM OLD."absent_at"
          OR OLD."absent_at" IS NULL)
     AND ((NEW."guard_account_id" = OLD."guard_account_id"
           AND NEW."swapped_at" IS NOT DISTINCT FROM OLD."swapped_at")
          OR (OLD."shift_id" IS NULL AND NEW."shift_id" IS NULL
              AND NEW."status" = 'scheduled'
              AND NEW."swapped_at" IS NOT NULL
              AND NEW."swapped_at" IS DISTINCT FROM OLD."swapped_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_roster_slots: a slot keeps its post and times, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_roster_slots_move_forward
  BEFORE UPDATE OR DELETE ON "guard_roster_slots"
  FOR EACH ROW EXECUTE FUNCTION guard_roster_slot_moves_forward();
CREATE TRIGGER guard_roster_slots_move_forward_truncate
  BEFORE TRUNCATE ON "guard_roster_slots"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Shifts: what the end records, and a row that moves forward only.
-- ----------------------------------------------------------------------------
ALTER TABLE "guard_shifts"
  ADD COLUMN "overtime_minutes" INTEGER,
  ADD COLUMN "unscheduled_minutes" INTEGER;
ALTER TABLE "guard_shifts"
  -- Recorded at the end: overtime for a shift that filled a slot,
  -- unscheduled minutes for one that filled none. Never both; shifts ended
  -- before ADR 0050 have neither.
  ADD CONSTRAINT "guard_shifts_minutes_at_end"
    CHECK (num_nonnulls("overtime_minutes", "unscheduled_minutes") <= 1
           AND ("ended_at" IS NOT NULL
                OR num_nonnulls("overtime_minutes", "unscheduled_minutes") = 0)),
  ADD CONSTRAINT "guard_shifts_minutes_range"
    CHECK (COALESCE("overtime_minutes", 0) >= 0
           AND COALESCE("unscheduled_minutes", 0) >= 0);

-- Who worked where, and from when, never changes; a shift ends once, and
-- what its end records is written once.
CREATE FUNCTION guard_shift_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."started_at" = OLD."started_at"
     AND ((NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
           AND NEW."end_reason" IS NOT DISTINCT FROM OLD."end_reason")
          OR OLD."ended_at" IS NULL)
     AND ((NEW."overtime_minutes" IS NOT DISTINCT FROM OLD."overtime_minutes"
           AND NEW."unscheduled_minutes" IS NOT DISTINCT FROM OLD."unscheduled_minutes")
          OR (OLD."overtime_minutes" IS NULL AND OLD."unscheduled_minutes" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_shifts: a shift keeps who, where and when, ends once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_shifts_move_forward
  BEFORE UPDATE OR DELETE ON "guard_shifts"
  FOR EACH ROW EXECUTE FUNCTION guard_shift_moves_forward();
CREATE TRIGGER guard_shifts_move_forward_truncate
  BEFORE TRUNCATE ON "guard_shifts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "guard_roster_templates", "guard_roster_slots" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_roster_templates", "guard_roster_slots" TO jiwar_app;

ALTER TABLE "guard_roster_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_roster_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_roster_templates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "guard_roster_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_roster_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_roster_slots"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
