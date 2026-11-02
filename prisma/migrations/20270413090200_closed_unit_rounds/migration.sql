-- ============================================================================
-- Closed units' rounds (ADR 0083, amends 0050 and 0063)
-- ============================================================================
--
-- A closed unit is looked at every N days (the compound's gate setting
-- `closed_unit_round_days`, 30 by default, 7 to 180): a round falls due N
-- days after the unit closed or was last inspected, whichever is later.
-- The hourly sweep makes it due; it waits in the staff inbox until the
-- management schedules it as a closed-unit inspection task (`task_id`).
-- The task done makes the round done; the task cancelled cancels it (the
-- sweep makes another due), and so does the unit reopening while it is
-- due. One live (due or scheduled) per unit. No personal data here.
-- ============================================================================

ALTER TABLE "gate_settings" ADD COLUMN "closed_unit_round_days" SMALLINT NOT NULL DEFAULT 30;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_closed_unit_round_days"
  CHECK ("closed_unit_round_days" BETWEEN 7 AND 180);

CREATE TABLE "closed_unit_rounds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'due',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "task_id" UUID,
    "scheduled_at" TIMESTAMPTZ(3),
    "done_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    CONSTRAINT "closed_unit_rounds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "closed_unit_rounds_tenant_id_id_key" ON "closed_unit_rounds"("tenant_id", "id");
CREATE UNIQUE INDEX "closed_unit_rounds_one_live_per_unit"
  ON "closed_unit_rounds"("tenant_id", "unit_id") WHERE "status" IN ('due', 'scheduled');
CREATE UNIQUE INDEX "closed_unit_rounds_task_key"
  ON "closed_unit_rounds"("tenant_id", "task_id") WHERE "task_id" IS NOT NULL;
CREATE INDEX "closed_unit_rounds_due_idx"
  ON "closed_unit_rounds"("tenant_id", "created_at", "id") WHERE "status" = 'due';
CREATE INDEX "closed_unit_rounds_unit_idx"
  ON "closed_unit_rounds"("tenant_id", "unit_id", "created_at" DESC);
ALTER TABLE "closed_unit_rounds"
  ADD CONSTRAINT "closed_unit_rounds_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "closed_unit_rounds_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "closed_unit_rounds_task_fkey"
  FOREIGN KEY ("tenant_id", "task_id") REFERENCES "guard_tasks"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Due: nothing more. Scheduled: its task and when. Done: also when.
-- Cancelled: when and why, with or without the task it had.
ALTER TABLE "closed_unit_rounds" ADD CONSTRAINT "closed_unit_rounds_state_shape"
  CHECK ("status" IN ('due', 'scheduled', 'done', 'cancelled')
     AND (("status" IN ('scheduled', 'done')) <= ("task_id" IS NOT NULL))
     AND ("status" <> 'due' OR ("task_id" IS NULL AND "scheduled_at" IS NULL))
     AND (("task_id" IS NULL) = ("scheduled_at" IS NULL))
     AND (("status" = 'done') = ("done_at" IS NOT NULL))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('unit_reopened', 'task_cancelled')));

-- Forward only: due, then scheduled or cancelled; scheduled, then done or
-- cancelled; once each. The unit, its day and when it fell due never
-- change, nor the task once given. Never deleted.
CREATE FUNCTION "closed_unit_rounds_move_forward"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id" AND NEW."due_on" = OLD."due_on"
     AND NEW."created_at" = OLD."created_at"
     AND ((OLD."status" = 'due' AND NEW."status" IN ('scheduled', 'cancelled'))
          OR (OLD."status" = 'scheduled' AND NEW."status" IN ('done', 'cancelled')
              AND NEW."task_id" = OLD."task_id"
              AND NEW."scheduled_at" = OLD."scheduled_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'closed_unit_rounds: a round moves forward once, and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "closed_unit_rounds_move_forward"
  BEFORE UPDATE OR DELETE ON "closed_unit_rounds"
  FOR EACH ROW EXECUTE FUNCTION "closed_unit_rounds_move_forward"();
CREATE TRIGGER "closed_unit_rounds_no_truncate"
  BEFORE TRUNCATE ON "closed_unit_rounds"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "closed_unit_rounds" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "closed_unit_rounds" TO jiwar_app;
ALTER TABLE "closed_unit_rounds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "closed_unit_rounds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "closed_unit_rounds"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
