-- ============================================================================
-- Patrols (ADR 0052): runs.
-- ============================================================================
--
-- A run walks a route's version from its post. A scheduled one is made 7
-- days ahead from the version's weekly start times, once (a unique index
-- that keeps cancelled ones too, so nothing cancelled comes back); it may
-- be started from 15 minutes before its start until its window ends (the
-- expected minutes, 30 at least). A guard on shift at the post may also
-- start one of their own (`adhoc`). One live run per guard. A run moves
-- forward only:
--   scheduled → in_progress | missed | cancelled
--   in_progress → completed | incomplete | timed_out
-- `planned_at` is when it was meant: the scheduled start, or the start of
-- an unscheduled one; the reports count runs by it.

CREATE TYPE "patrol_run_kind" AS ENUM ('scheduled', 'adhoc');
CREATE TYPE "patrol_run_status" AS ENUM (
  'scheduled', 'in_progress', 'completed', 'incomplete', 'timed_out', 'missed', 'cancelled'
);

CREATE TABLE "patrol_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "kind" "patrol_run_kind" NOT NULL,
    "planned_at" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_start" TIMESTAMPTZ(3),
    "window_ends_at" TIMESTAMPTZ(3),
    "status" "patrol_run_status" NOT NULL,
    "guard_account_id" UUID,
    "shift_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "checkpoints_total" INTEGER NOT NULL,
    "scanned_count" INTEGER NOT NULL DEFAULT 0,
    "late_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patrol_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_runs_tenant_id_id_key" ON "patrol_runs"("tenant_id", "id");
-- A version makes each scheduled run once, cancelled ones included.
CREATE UNIQUE INDEX "patrol_runs_scheduled_key"
  ON "patrol_runs"("tenant_id", "version_id", "scheduled_start") WHERE "kind" = 'scheduled';
-- One live run per guard.
CREATE UNIQUE INDEX "patrol_runs_one_live_per_guard"
  ON "patrol_runs"("tenant_id", "guard_account_id") WHERE "status" = 'in_progress';
CREATE INDEX "patrol_runs_planned_idx" ON "patrol_runs"("tenant_id", "planned_at", "id");
CREATE INDEX "patrol_runs_due_idx"
  ON "patrol_runs"("tenant_id", "scheduled_start") WHERE "status" = 'scheduled';
CREATE INDEX "patrol_runs_live_idx"
  ON "patrol_runs"("tenant_id", "started_at") WHERE "status" = 'in_progress';
CREATE INDEX "patrol_runs_route_idx" ON "patrol_runs"("tenant_id", "route_id", "status");
CREATE INDEX "patrol_runs_guard_idx" ON "patrol_runs"("tenant_id", "guard_account_id", "planned_at");

ALTER TABLE "patrol_runs"
  ADD CONSTRAINT "patrol_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_route_id_fkey"
    FOREIGN KEY ("tenant_id", "route_id") REFERENCES "patrol_routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_version_id_fkey"
    FOREIGN KEY ("tenant_id", "version_id") REFERENCES "patrol_route_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_runs_tenant_id_cancelled_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_runs"
  ADD CONSTRAINT "patrol_runs_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  -- A scheduled run has its start and window; an unscheduled one neither,
  -- and is never scheduled, missed or cancelled.
  ADD CONSTRAINT "patrol_runs_kind_shape"
    CHECK (("kind" = 'scheduled') = ("scheduled_start" IS NOT NULL)
           AND ("scheduled_start" IS NULL) = ("window_ends_at" IS NULL)
           AND ("kind" = 'scheduled' OR "status" NOT IN ('scheduled', 'missed', 'cancelled'))
           AND ("kind" = 'scheduled' OR "late_at" IS NULL)),
  ADD CONSTRAINT "patrol_runs_planned"
    CHECK ("planned_at" = COALESCE("scheduled_start", "started_at")),
  ADD CONSTRAINT "patrol_runs_window_after_start"
    CHECK ("scheduled_start" IS NULL OR "window_ends_at" > "scheduled_start"),
  -- Started exactly when it is, or was, under way: by a guard, in a shift.
  ADD CONSTRAINT "patrol_runs_started_shape"
    CHECK (("status" IN ('in_progress', 'completed', 'incomplete', 'timed_out')) = ("started_at" IS NOT NULL)
           AND ("started_at" IS NULL) = ("guard_account_id" IS NULL)
           AND ("started_at" IS NULL) = ("shift_id" IS NULL)),
  -- Ended exactly when it is final.
  ADD CONSTRAINT "patrol_runs_ended_shape"
    CHECK (("status" IN ('scheduled', 'in_progress')) = ("ended_at" IS NULL)
           AND ("started_at" IS NULL OR "ended_at" IS NULL OR "ended_at" >= "started_at")),
  ADD CONSTRAINT "patrol_runs_end_reason"
    CHECK (("status" = 'incomplete') = ("end_reason" IS NOT NULL)
           AND ("end_reason" IS NULL OR "end_reason" IN ('guard', 'shift_ended'))),
  ADD CONSTRAINT "patrol_runs_cancel_reason"
    CHECK (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL)
           AND ("cancel_reason" IS NULL
                OR "cancel_reason" IN ('not_needed', 'post_closed', 'other', 'route_changed', 'route_retired', 'post_out_of_service'))
           AND ("cancelled_by_account_id" IS NULL OR "cancel_reason" IS NOT NULL)),
  -- The system cancels with its own reasons, the management with theirs.
  ADD CONSTRAINT "patrol_runs_cancelled_by"
    CHECK ("cancel_reason" IS NULL
           OR ("cancelled_by_account_id" IS NULL) = ("cancel_reason" IN ('route_changed', 'route_retired', 'post_out_of_service'))),
  ADD CONSTRAINT "patrol_runs_counts"
    CHECK ("checkpoints_total" BETWEEN 1 AND 50
           AND "scanned_count" BETWEEN 0 AND "checkpoints_total"),
  -- Completed means every checkpoint scanned.
  ADD CONSTRAINT "patrol_runs_completed_shape"
    CHECK ("status" <> 'completed' OR "scanned_count" = "checkpoints_total");

-- What a run is never changes; it moves forward only; who started it,
-- when, and how it ended are written once; late once; the scanned count
-- only grows. Never deleted.
CREATE FUNCTION patrol_run_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."route_id" = OLD."route_id"
     AND NEW."version_id" = OLD."version_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."planned_at" = OLD."planned_at"
     AND NEW."scheduled_start" IS NOT DISTINCT FROM OLD."scheduled_start"
     AND NEW."window_ends_at" IS NOT DISTINCT FROM OLD."window_ends_at"
     AND NEW."checkpoints_total" = OLD."checkpoints_total"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'scheduled' AND NEW."status" IN ('in_progress', 'missed', 'cancelled'))
          OR (OLD."status" = 'in_progress' AND NEW."status" IN ('completed', 'incomplete', 'timed_out')))
     AND (OLD."started_at" IS NULL
          OR (NEW."started_at" = OLD."started_at"
              AND NEW."guard_account_id" = OLD."guard_account_id"
              AND NEW."shift_id" = OLD."shift_id"))
     AND (OLD."ended_at" IS NULL
          OR (NEW."ended_at" = OLD."ended_at"
              AND NEW."end_reason" IS NOT DISTINCT FROM OLD."end_reason"
              AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason"
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"))
     AND (OLD."late_at" IS NULL OR NEW."late_at" = OLD."late_at")
     AND NEW."scanned_count" >= OLD."scanned_count" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_runs: a run moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_runs_move_forward
  BEFORE UPDATE OR DELETE ON "patrol_runs"
  FOR EACH ROW EXECUTE FUNCTION patrol_run_moves_forward();
CREATE TRIGGER patrol_runs_move_forward_truncate
  BEFORE TRUNCATE ON "patrol_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_runs" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "patrol_runs" TO jiwar_app;

ALTER TABLE "patrol_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_runs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
