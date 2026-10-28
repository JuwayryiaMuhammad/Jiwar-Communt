-- ============================================================================
-- Moving in and out (ADR 0063)
-- ============================================================================
--
-- A move belongs to an occupancy: a move-in is planned when a residing
-- occupancy begins, a move-out by the residing primary's notice or by the
-- management. It is planned, then done (a move-in when the management
-- confirms it, a move-out at the occupancy's handover) or cancelled with a
-- code, once. Its checklist is a closed list of steps per direction:
-- the manual ones are ticked here, once each; the others are read from
-- the domains that hold them (a move permit, a utilities request, a
-- clearance, the deposits) and never stored.
--
-- A move permit now says which way it goes and which move it serves.
-- Permits from before this migration have no direction: `legacy_move`
-- marks them (true for every row there now, false for every new one), so
-- the CHECK that a move permit has its direction holds over the whole
-- table, validated, and the trigger keeps the mark as it is.
--
-- The compound gains the topic `utilities`: a resident moving in asks the
-- management to have electricity, water and gas switched on, as any
-- request (src/management/settings/defaults.ts UNIT_TOPICS; a unit test
-- keeps the backfill below in step).

CREATE TABLE "unit_moves" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "occupancy_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "planned_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "done_at" TIMESTAMPTZ(3),
    "done_by" UUID,
    "handover_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    CONSTRAINT "unit_moves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_moves_tenant_id_id_key" ON "unit_moves"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_moves_number_key" ON "unit_moves"("tenant_id", "number");
-- One planned move each way per occupancy.
CREATE UNIQUE INDEX "unit_moves_one_planned" ON "unit_moves"("occupancy_id", "direction")
  WHERE "status" = 'planned';
CREATE INDEX "unit_moves_unit_idx" ON "unit_moves"("tenant_id", "unit_id", "created_at" DESC);
CREATE INDEX "unit_moves_board_idx" ON "unit_moves"("tenant_id", "planned_on")
  WHERE "status" = 'planned';
ALTER TABLE "unit_moves"
  ADD CONSTRAINT "unit_moves_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_moves_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_moves_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_moves_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_moves_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_moves_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_moves" ADD CONSTRAINT "unit_moves_shape"
  CHECK ("number" >= 1
     AND "direction" IN ('in', 'out')
     AND "status" IN ('planned', 'done', 'cancelled')
     AND ("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("done_by" IS NULL OR "done_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_by" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('plans_changed', 'data_error', 'occupancy_ended', 'other'))
     -- Only a move-out is handed over, and only with a code when the unit
     -- had no clearance (REASON_CODES.handoverWithoutClearance).
     AND ("handover_reason" IS NULL
          OR ("direction" = 'out' AND "status" = 'done'
              AND "handover_reason" IN ('dues_settle_later', 'dues_disputed', 'other')))
     AND ("done_at" IS NULL OR "done_at" >= "created_at")
     AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
CREATE FUNCTION unit_move_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."occupancy_id" = OLD."occupancy_id"
     AND NEW."direction" = OLD."direction"
     AND NEW."planned_on" = OLD."planned_on"
     AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
     AND NEW."created_at" = OLD."created_at"
     -- Planned, then done or cancelled, once.
     AND OLD."status" = 'planned' AND NEW."status" IN ('done', 'cancelled') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_moves: a move is planned, then done or cancelled once, and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_moves_move_forward
  BEFORE UPDATE OR DELETE ON "unit_moves"
  FOR EACH ROW EXECUTE FUNCTION unit_move_moves_forward();
CREATE TRIGGER unit_moves_no_truncate
  BEFORE TRUNCATE ON "unit_moves"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A manual step of a move's checklist, ticked once (the step's key is one
-- of the closed list in src/community/moves/move-checklist.ts).
CREATE TABLE "unit_move_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "move_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "done_by" UUID NOT NULL,
    "done_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_move_steps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_move_steps_once" ON "unit_move_steps"("move_id", "step");
CREATE INDEX "unit_move_steps_move_idx" ON "unit_move_steps"("tenant_id", "move_id");
ALTER TABLE "unit_move_steps"
  ADD CONSTRAINT "unit_move_steps_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_move_steps_move_fkey"
  FOREIGN KEY ("tenant_id", "move_id") REFERENCES "unit_moves"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_move_steps_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_move_steps" ADD CONSTRAINT "unit_move_steps_shape"
  CHECK ("step" ~ '^[a-z][a-z_]{1,39}$' AND "side" IN ('resident', 'management'));
CREATE TRIGGER unit_move_steps_immutable
  BEFORE UPDATE OR DELETE ON "unit_move_steps"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER unit_move_steps_no_truncate
  BEFORE TRUNCATE ON "unit_move_steps"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT, UPDATE ON "unit_moves" TO jiwar_app;
GRANT SELECT, INSERT ON "unit_move_steps" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_moves', 'unit_move_steps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- A move permit's direction and move. Every row here now is a legacy one;
-- every new row is not (the default changes after the column is added).
-- ----------------------------------------------------------------------------
ALTER TABLE "unit_permits"
  ADD COLUMN "move_direction" TEXT,
  ADD COLUMN "move_id" UUID,
  ADD COLUMN "legacy_move" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "unit_permits" ALTER COLUMN "legacy_move" SET DEFAULT false;
ALTER TABLE "unit_permits"
  ADD CONSTRAINT "unit_permits_move_fkey"
  FOREIGN KEY ("tenant_id", "move_id") REFERENCES "unit_moves"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "unit_permits_move_idx" ON "unit_permits"("tenant_id", "move_id")
  WHERE "move_id" IS NOT NULL;
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_move_direction"
  CHECK (("move_direction" IS NULL OR "move_direction" IN ('in', 'out'))
     AND ("kind" = 'move' OR ("move_direction" IS NULL AND "move_id" IS NULL))
     AND ("kind" <> 'move' OR "move_direction" IS NOT NULL OR "legacy_move"));

CREATE OR REPLACE FUNCTION unit_permit_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."kind" = OLD."kind"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."created_at" = OLD."created_at"
     -- A move's direction and its move are the request's (ADR 0063).
     AND NEW."move_direction" IS NOT DISTINCT FROM OLD."move_direction"
     AND NEW."move_id" IS NOT DISTINCT FROM OLD."move_id"
     AND NEW."legacy_move" = OLD."legacy_move"
     AND NEW."work_type" IS NOT DISTINCT FROM OLD."work_type"
     AND NEW."daily_from" IS NOT DISTINCT FROM OLD."daily_from"
     AND NEW."daily_to" IS NOT DISTINCT FROM OLD."daily_to"
     AND NEW."guest_limit" IS NOT DISTINCT FROM OLD."guest_limit"
     -- The resident's words stay, or go together, once.
     AND ((NEW."contractor_company" IS NOT DISTINCT FROM OLD."contractor_company"
           AND NEW."description" IS NOT DISTINCT FROM OLD."description"
           AND NEW."items_description" IS NOT DISTINCT FROM OLD."items_description"
           AND NEW."items" IS NOT DISTINCT FROM OLD."items"
           AND NEW."title" IS NOT DISTINCT FROM OLD."title"
           AND NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at")
          OR (OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL))
     -- The plate goes once, with the purge.
     AND ((NEW."truck_plate" IS NOT DISTINCT FROM OLD."truck_plate"
           AND NEW."purged_at" IS NOT DISTINCT FROM OLD."purged_at")
          OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL))
     -- The photo goes with either, never comes back.
     AND (NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
          OR (NEW."photo_file_id" IS NULL
              AND ((OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL)
                   OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL))))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
          OR (OLD."status" = 'approved' AND NEW."status" IN ('cancelled', 'revoked', 'used'))
          -- An overturned appeal approves a rejected permit, once (ADR 0059).
          OR (OLD."status" = 'rejected' AND NEW."status" = 'approved'
              AND OLD."appeal_overturned_at" IS NULL AND NEW."appeal_overturned_at" IS NOT NULL))
     -- The appeal's mark, its closing and its overturn, once each.
     AND (NEW."decision_appeal_at" IS NOT DISTINCT FROM OLD."decision_appeal_at"
          OR (OLD."decision_appeal_at" IS NULL AND OLD."status" = 'rejected'))
     -- Closed once; re-opened only while it stands rejected, when the
     -- management's decision is taken to the board (ADR 0059).
     AND (NEW."decision_appeal_closed_at" IS NOT DISTINCT FROM OLD."decision_appeal_closed_at"
          OR OLD."decision_appeal_closed_at" IS NULL
          OR (NEW."decision_appeal_closed_at" IS NULL AND OLD."status" = 'rejected'
              AND NEW."status" = 'rejected'))
     AND ((NEW."appeal_overturned_at" IS NOT DISTINCT FROM OLD."appeal_overturned_at"
           AND NEW."appeal_overturned_by_account_id" IS NOT DISTINCT FROM OLD."appeal_overturned_by_account_id")
          OR OLD."appeal_overturned_at" IS NULL)
     AND ((NEW."decision_source" IS NOT DISTINCT FROM OLD."decision_source"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."reject_reason" IS NOT DISTINCT FROM OLD."reject_reason"
           AND NEW."staff_note" IS NOT DISTINCT FROM OLD."staff_note")
          OR OLD."decided_at" IS NULL)
     AND ((NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
           AND NEW."revoked_by_account_id" IS NOT DISTINCT FROM OLD."revoked_by_account_id"
           AND NEW."revoke_reason" IS NOT DISTINCT FROM OLD."revoke_reason"
           AND NEW."revoke_note" IS NOT DISTINCT FROM OLD."revoke_note")
          OR OLD."revoked_at" IS NULL)
     AND ((NEW."used_at" IS NOT DISTINCT FROM OLD."used_at"
           AND NEW."used_by_account_id" IS NOT DISTINCT FROM OLD."used_by_account_id"
           AND NEW."used_gate_id" IS NOT DISTINCT FROM OLD."used_gate_id")
          OR OLD."used_at" IS NULL)
     AND ((NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancel_side" IS NOT DISTINCT FROM OLD."cancel_side"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."cancelled_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_permits: a permit keeps what it asks, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


-- ----------------------------------------------------------------------------
-- The topic `utilities`, seeded in every compound.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "management_request_topics" ("id", "tenant_id", "key", "name_ar", "name_en", "target_response_hours", "updated_at")
    SELECT gen_random_uuid(), t, s.key, s.name_ar, s.name_en, s.hours, CURRENT_TIMESTAMP
      FROM (VALUES ('utilities', 'المرافق: كهرباء ومياه وغاز', 'Utilities: electricity, water and gas', 72)) AS s(key, name_ar, name_en, hours)
     WHERE NOT EXISTS (
       SELECT 1 FROM "management_request_topics" m WHERE m."tenant_id" = t AND m."key" = s.key);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
