-- ============================================================================
-- Inspection requests for a closed unit, and the unit_preparation topic
-- (ADR 0063)
-- ============================================================================
--
-- The owner of a closed unit, or its proxy with `inspections`, asks the
-- management for a guard's visit, with a preferred day; one live request
-- per unit. The management (`guard_tasks.manage`) schedules it as a
-- closed-unit inspection task (ADR 0050) that names the request; the
-- task's completion marks it done, its cancellation cancels it. Either
-- side cancels an open request with a code. A request moves forward only.
--
-- The compound gains the topic `unit_preparation`: the resident asks the
-- management to prepare a closed unit before they come back (air it,
-- switch the water on), as any request (src/management/settings/defaults.ts
-- UNIT_TOPICS; a unit test keeps the backfill in step).

CREATE TABLE "unit_inspection_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "preferred_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3),
    "done_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    CONSTRAINT "unit_inspection_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_inspection_requests_tenant_id_id_key"
  ON "unit_inspection_requests"("tenant_id", "id");
-- Its reference (IR-), numbered under an advisory lock per compound.
CREATE UNIQUE INDEX "unit_inspection_requests_number_key"
  ON "unit_inspection_requests"("tenant_id", "number");
-- One live request per unit.
CREATE UNIQUE INDEX "unit_inspection_requests_one_live"
  ON "unit_inspection_requests"("unit_id") WHERE "status" IN ('open', 'scheduled');
CREATE INDEX "unit_inspection_requests_unit_idx"
  ON "unit_inspection_requests"("tenant_id", "unit_id", "created_at" DESC);
CREATE INDEX "unit_inspection_requests_open_idx"
  ON "unit_inspection_requests"("tenant_id", "preferred_on") WHERE "status" = 'open';
ALTER TABLE "unit_inspection_requests"
  ADD CONSTRAINT "unit_inspection_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_inspection_requests_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_inspection_requests_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_inspection_requests_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_inspection_requests" ADD CONSTRAINT "unit_inspection_requests_shape"
  CHECK ("number" >= 1
     AND "status" IN ('open', 'scheduled', 'done', 'cancelled')
     AND ("status" NOT IN ('scheduled', 'done') OR "scheduled_at" IS NOT NULL)
     AND ("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_by" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('not_needed', 'unit_reopened', 'other', 'task_cancelled'))
     AND ("scheduled_at" IS NULL OR "scheduled_at" >= "created_at")
     AND ("done_at" IS NULL OR "done_at" >= "created_at")
     AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
CREATE FUNCTION unit_inspection_request_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requested_by" = OLD."requested_by"
     AND NEW."preferred_on" = OLD."preferred_on"
     AND NEW."created_at" = OLD."created_at"
     AND ((OLD."status" = 'open' AND NEW."status" IN ('scheduled', 'cancelled'))
          OR (OLD."status" = 'scheduled' AND NEW."status" IN ('done', 'cancelled')
              AND NEW."scheduled_at" = OLD."scheduled_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_inspection_requests: a request moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_inspection_requests_move_forward
  BEFORE UPDATE OR DELETE ON "unit_inspection_requests"
  FOR EACH ROW EXECUTE FUNCTION unit_inspection_request_moves_forward();
CREATE TRIGGER unit_inspection_requests_no_truncate
  BEFORE TRUNCATE ON "unit_inspection_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
GRANT SELECT, INSERT, UPDATE ON "unit_inspection_requests" TO jiwar_app;
ALTER TABLE "unit_inspection_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_inspection_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_inspection_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- A closed-unit inspection task names the request it answers, once.
-- ----------------------------------------------------------------------------
ALTER TABLE "guard_tasks" ADD COLUMN "request_id" UUID;
ALTER TABLE "guard_tasks"
  ADD CONSTRAINT "guard_tasks_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "unit_inspection_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "guard_tasks_request_id_key" ON "guard_tasks"("request_id")
  WHERE "request_id" IS NOT NULL;
ALTER TABLE "guard_tasks" ADD CONSTRAINT "guard_tasks_request_kind"
  CHECK ("request_id" IS NULL OR "kind" = 'closed_unit_inspection');

CREATE OR REPLACE FUNCTION guard_task_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."title" IS NOT DISTINCT FROM OLD."title"
     AND NEW."details" IS NOT DISTINCT FROM OLD."details"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."due_at" IS NOT DISTINCT FROM OLD."due_at"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     -- The request it answers is set at its creation (ADR 0063).
     AND NEW."request_id" IS NOT DISTINCT FROM OLD."request_id"
     -- Carried: to another post, from a shift's end, while not over.
     AND ((NEW."assignee_account_id" IS NOT DISTINCT FROM OLD."assignee_account_id"
           AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
           AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
           AND NEW."carried_from_shift_id" IS NOT DISTINCT FROM OLD."carried_from_shift_id")
          OR (OLD."status" IN ('open', 'in_progress') AND NEW."status" = 'open'
              AND NEW."carried_from_shift_id" IS NOT NULL
              AND NEW."carried_from_shift_id" IS DISTINCT FROM OLD."carried_from_shift_id"))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'open' AND NEW."status" IN ('in_progress', 'cancelled'))
          OR (OLD."status" = 'in_progress' AND NEW."status" IN ('open', 'done', 'cancelled')))
     -- Taken once per stretch: held, or let go only by a carry.
     AND ((NEW."taken_by_account_id" IS NOT DISTINCT FROM OLD."taken_by_account_id"
           AND NEW."taken_at" IS NOT DISTINCT FROM OLD."taken_at")
          OR OLD."taken_by_account_id" IS NULL
          OR (NEW."status" = 'open' AND NEW."taken_by_account_id" IS NULL))
     AND (OLD."status" NOT IN ('done', 'cancelled')
          OR (NEW."status" = OLD."status"
              AND NEW."taken_by_account_id" IS NOT DISTINCT FROM OLD."taken_by_account_id"
              AND NEW."done_at" IS NOT DISTINCT FROM OLD."done_at"
              AND NEW."outcome" IS NOT DISTINCT FROM OLD."outcome"
              AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
              AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason"
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
              AND (NEW."result_note" IS NOT DISTINCT FROM OLD."result_note"
                   AND NEW."result_cleared_at" IS NOT DISTINCT FROM OLD."result_cleared_at"
                   OR (OLD."result_cleared_at" IS NULL AND NEW."result_cleared_at" IS NOT NULL
                       AND NEW."result_note" IS NULL)))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_tasks: a task keeps what it asks, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


-- ----------------------------------------------------------------------------
-- The topic `unit_preparation`, seeded in every compound.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "management_request_topics" ("id", "tenant_id", "key", "name_ar", "name_en", "target_response_hours", "updated_at")
    SELECT gen_random_uuid(), t, s.key, s.name_ar, s.name_en, s.hours, CURRENT_TIMESTAMP
      FROM (VALUES ('unit_preparation', 'تجهيز الوحدة قبل العودة', 'Preparing the unit before I return', 72)) AS s(key, name_ar, name_en, hours)
     WHERE NOT EXISTS (
       SELECT 1 FROM "management_request_topics" m WHERE m."tenant_id" = t AND m."key" = s.key);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
