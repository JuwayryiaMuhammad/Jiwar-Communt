-- ============================================================================
-- Guard shifts and tasks (ADR 0050): tasks.
-- ============================================================================
--
-- The management gives guards work: a closed unit to inspect (with photos)
-- or a task of its own words, for one guard, a gate or a zone. A guard
-- takes it, then completes it with an outcome. At the end of a shift, the
-- tasks the guard had move to the shift's post for the next guard there.
-- Nothing is deleted.

CREATE TYPE "guard_task_kind" AS ENUM ('closed_unit_inspection', 'custom');
CREATE TYPE "guard_task_status" AS ENUM ('open', 'in_progress', 'done', 'cancelled');

CREATE TABLE "guard_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "guard_task_kind" NOT NULL,
    -- The management's words (a custom task's title is required).
    "title" TEXT,
    "details" TEXT,
    "unit_id" UUID,
    -- Who it is for: one guard, a gate or a zone (exactly one).
    "assignee_account_id" UUID,
    "gate_id" UUID,
    "place_id" UUID,
    "due_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "status" "guard_task_status" NOT NULL DEFAULT 'open',
    "taken_by_account_id" UUID,
    "taken_at" TIMESTAMPTZ(3),
    "done_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    -- The guard's words: never in the audit trail or a notification.
    "result_note" TEXT,
    "result_cleared_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    -- The shift whose end last moved it to its post.
    "carried_from_shift_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_tasks_tenant_id_id_key" ON "guard_tasks"("tenant_id", "id");
-- What a guard's work list reads: the open ones of a guard, a gate, a zone.
CREATE INDEX "guard_tasks_assignee_idx"
  ON "guard_tasks"("tenant_id", "assignee_account_id")
  WHERE "status" IN ('open', 'in_progress');
CREATE INDEX "guard_tasks_gate_idx"
  ON "guard_tasks"("tenant_id", "gate_id")
  WHERE "status" IN ('open', 'in_progress');
CREATE INDEX "guard_tasks_place_idx"
  ON "guard_tasks"("tenant_id", "place_id")
  WHERE "status" IN ('open', 'in_progress');
CREATE INDEX "guard_tasks_taken_idx"
  ON "guard_tasks"("tenant_id", "taken_by_account_id")
  WHERE "status" = 'in_progress';
CREATE INDEX "guard_tasks_created_idx"
  ON "guard_tasks"("tenant_id", "created_at", "id");
CREATE INDEX "guard_tasks_unit_idx" ON "guard_tasks"("tenant_id", "unit_id");

ALTER TABLE "guard_tasks"
  ADD CONSTRAINT "guard_tasks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_assignee_account_id_fkey"
    FOREIGN KEY ("tenant_id", "assignee_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_taken_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "taken_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_cancelled_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_tasks_tenant_id_carried_from_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "carried_from_shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guard_tasks"
  ADD CONSTRAINT "guard_tasks_one_assignee"
    CHECK (num_nonnulls("assignee_account_id", "gate_id", "place_id") = 1),
  -- An inspection is of a unit and has no title of its own; a custom task
  -- has a title and no unit.
  ADD CONSTRAINT "guard_tasks_kind_shape"
    CHECK (("kind" = 'closed_unit_inspection' AND "unit_id" IS NOT NULL AND "title" IS NULL)
        OR ("kind" = 'custom' AND "unit_id" IS NULL AND "title" IS NOT NULL)),
  ADD CONSTRAINT "guard_tasks_title_length"
    CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "guard_tasks_details_length"
    CHECK ("details" IS NULL OR char_length("details") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "guard_tasks_result_note_length"
    CHECK ("result_note" IS NULL OR char_length("result_note") BETWEEN 1 AND 2000),
  -- Taken while in progress or done; nobody holds an open one.
  ADD CONSTRAINT "guard_tasks_taken_shape"
    CHECK (("taken_by_account_id" IS NULL) = ("taken_at" IS NULL)
           AND ("status" NOT IN ('in_progress', 'done') OR "taken_by_account_id" IS NOT NULL)
           AND ("status" <> 'open' OR "taken_by_account_id" IS NULL)),
  ADD CONSTRAINT "guard_tasks_done_shape"
    CHECK (("status" = 'done') = ("done_at" IS NOT NULL)
           AND ("done_at" IS NULL) = ("outcome" IS NULL)),
  -- REASON_CODES.guardTaskOutcome (src/core/common/reasons.ts); a unit test
  -- keeps them in step. An inspection ends all clear or with an issue; a
  -- custom task ends done.
  ADD CONSTRAINT "guard_tasks_outcome"
    CHECK ("outcome" IS NULL
        OR ("kind" = 'closed_unit_inspection' AND "outcome" IN ('all_clear', 'issue_found'))
        OR ("kind" = 'custom' AND "outcome" IN ('done'))),
  ADD CONSTRAINT "guard_tasks_cancel_shape"
    CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
           AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)),
  -- REASON_CODES.guardTaskCancel and guardTaskCancelSystem.
  ADD CONSTRAINT "guard_tasks_cancel_reason"
    CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('no_longer_needed', 'duplicate', 'unit_reopened', 'other', 'assignee_left')),
  ADD CONSTRAINT "guard_tasks_cancelled_by"
    CHECK ("cancel_reason" IS NULL
           OR ("cancel_reason" IN ('assignee_left')) = ("cancelled_by_account_id" IS NULL)),
  ADD CONSTRAINT "guard_tasks_cleared_shape"
    CHECK ("result_cleared_at" IS NULL OR "result_note" IS NULL);

-- A task keeps what it asks of whom it was for when made... except that a
-- shift's end moves it to the shift's post (`carried_from_shift_id` moves
-- with it). It moves forward only: open → in progress → done, or
-- cancelled; a carried task goes back to open. Done and cancelled are
-- final; the guard's note goes once (their erasure).
CREATE FUNCTION guard_task_moves_forward() RETURNS trigger
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
CREATE TRIGGER guard_tasks_move_forward
  BEFORE UPDATE OR DELETE ON "guard_tasks"
  FOR EACH ROW EXECUTE FUNCTION guard_task_moves_forward();
CREATE TRIGGER guard_tasks_move_forward_truncate
  BEFORE TRUNCATE ON "guard_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A task's photos: attached at its completion, never detached.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_task_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_task_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_task_photos_tenant_id_id_key" ON "guard_task_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "guard_task_photos_file_id_key" ON "guard_task_photos"("file_id");
CREATE INDEX "guard_task_photos_task_idx" ON "guard_task_photos"("tenant_id", "task_id");
ALTER TABLE "guard_task_photos"
  ADD CONSTRAINT "guard_task_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_task_photos_tenant_id_task_id_fkey"
    FOREIGN KEY ("tenant_id", "task_id") REFERENCES "guard_tasks"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_task_photos_tenant_id_file_id_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_task_photos_tenant_id_uploaded_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER guard_task_photos_immutable
  BEFORE UPDATE OR DELETE ON "guard_task_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER guard_task_photos_immutable_truncate
  BEFORE TRUNCATE ON "guard_task_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "guard_tasks", "guard_task_photos" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_tasks" TO jiwar_app;
GRANT SELECT, INSERT ON "guard_task_photos" TO jiwar_app;

ALTER TABLE "guard_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_tasks"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "guard_task_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_task_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_task_photos"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
