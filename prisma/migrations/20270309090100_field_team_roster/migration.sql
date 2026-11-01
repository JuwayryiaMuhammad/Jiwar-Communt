-- ============================================================================
-- The field team (ADR 0078): one roster for the guards and the technicians.
-- ============================================================================
--
-- The guards' roster (ADR 0050) gains a crew. A `security` template or slot
-- is what it was: a guard at a post (a gate or a zone), filled by a shift.
-- A `maintenance` one is a technician's: no gate, an optional zone, filled
-- when the technician becomes available (`duty_started_at`, with its
-- lateness) and closed when they stop (`duty_ended_at`, with the overtime
-- beyond the slot). Every row so far is the guards': the default says so.
-- Templates and slots keep their crew; the rules of ADR 0050 hold for both.

ALTER TABLE "guard_roster_templates"
  ADD COLUMN "crew" "staff_crew" NOT NULL DEFAULT 'security';

ALTER TABLE "guard_roster_slots"
  ADD COLUMN "crew" "staff_crew" NOT NULL DEFAULT 'security',
  ADD COLUMN "duty_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "duty_ended_at" TIMESTAMPTZ(3),
  ADD COLUMN "overtime_minutes" INTEGER;

-- A guard's post is a gate or a zone, exactly one; a technician's is a zone
-- or none, never a gate.
ALTER TABLE "guard_roster_templates"
  DROP CONSTRAINT "guard_roster_templates_one_post",
  ADD CONSTRAINT "guard_roster_templates_one_post"
    CHECK (("crew" = 'security' AND num_nonnulls("gate_id", "place_id") = 1)
        OR ("crew" = 'maintenance' AND "gate_id" IS NULL));

ALTER TABLE "guard_roster_slots"
  DROP CONSTRAINT "guard_roster_slots_one_post",
  ADD CONSTRAINT "guard_roster_slots_one_post"
    CHECK (("crew" = 'security' AND num_nonnulls("gate_id", "place_id") = 1)
        OR ("crew" = 'maintenance' AND "gate_id" IS NULL)),
  -- A guard's slot is filled by a shift; a technician's by going on duty,
  -- and closed by going off it with its overtime. Lateness comes with the
  -- filling either way, and a filled slot was not cancelled.
  DROP CONSTRAINT "guard_roster_slots_filled_shape",
  ADD CONSTRAINT "guard_roster_slots_filled_shape"
    CHECK ((("crew" = 'security'
             AND "duty_started_at" IS NULL AND "duty_ended_at" IS NULL
             AND "overtime_minutes" IS NULL
             AND ("shift_id" IS NULL) = ("late_minutes" IS NULL))
         OR ("crew" = 'maintenance'
             AND "shift_id" IS NULL
             AND ("duty_started_at" IS NULL) = ("late_minutes" IS NULL)
             AND ("duty_ended_at" IS NULL OR "duty_started_at" IS NOT NULL)
             AND ("duty_ended_at" IS NULL) = ("overtime_minutes" IS NULL)))
        AND (("shift_id" IS NULL AND "duty_started_at" IS NULL)
             OR "status" = 'scheduled')),
  ADD CONSTRAINT "guard_roster_slots_duty_order"
    CHECK ("duty_ended_at" IS NULL OR "duty_ended_at" >= "duty_started_at"),
  ADD CONSTRAINT "guard_roster_slots_overtime_range"
    CHECK ("overtime_minutes" IS NULL OR "overtime_minutes" >= 0);

-- What a template says never changes, its crew included; it is ended once.
CREATE OR REPLACE FUNCTION guard_roster_template_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."crew" = OLD."crew"
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

-- A slot keeps its crew, its post and its times. It is cancelled once,
-- filled once (by a shift, or by going on duty), closed once (going off
-- duty), marked absent once; a guard's changes hands only by a swap, while
-- nobody has opened it (`swapped_at` moves with the guard). A technician's
-- is never swapped. Once cancelled, nothing changes.
CREATE OR REPLACE FUNCTION guard_roster_slot_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."crew" = OLD."crew"
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
           AND NEW."duty_started_at" IS NOT DISTINCT FROM OLD."duty_started_at"
           AND NEW."late_minutes" IS NOT DISTINCT FROM OLD."late_minutes")
          OR (OLD."shift_id" IS NULL AND OLD."duty_started_at" IS NULL))
     AND ((NEW."duty_ended_at" IS NOT DISTINCT FROM OLD."duty_ended_at"
           AND NEW."overtime_minutes" IS NOT DISTINCT FROM OLD."overtime_minutes")
          OR OLD."duty_ended_at" IS NULL)
     AND (NEW."absent_at" IS NOT DISTINCT FROM OLD."absent_at"
          OR OLD."absent_at" IS NULL)
     AND ((NEW."guard_account_id" = OLD."guard_account_id"
           AND NEW."swapped_at" IS NOT DISTINCT FROM OLD."swapped_at")
          OR (OLD."crew" = 'security'
              AND OLD."shift_id" IS NULL AND NEW."shift_id" IS NULL
              AND NEW."status" = 'scheduled'
              AND NEW."swapped_at" IS NOT NULL
              AND NEW."swapped_at" IS DISTINCT FROM OLD."swapped_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_roster_slots: a slot keeps its post and times, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- A technician's slot still running and on duty, found when they go off.
CREATE INDEX "guard_roster_slots_on_duty_idx"
  ON "guard_roster_slots" ("tenant_id", "guard_account_id")
  WHERE "crew" = 'maintenance' AND "duty_started_at" IS NOT NULL
    AND "duty_ended_at" IS NULL;
