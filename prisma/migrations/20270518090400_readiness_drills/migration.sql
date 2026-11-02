-- ============================================================================
-- Drills (ADR 0087): a readiness item of kind `drill` — a fire drill, an
-- evacuation, a lockdown drill, a medical one — with its type, and, once it
-- is done, its outcome, how many took part and how many minutes it took.
-- The kind CHECK is recreated whole with the new kind; the end trigger is
-- recreated with the drill's columns: its type never changes, its result
-- is written once with its done.
-- No row changes: no item is a drill yet.
-- ============================================================================

ALTER TABLE "readiness_items" ADD COLUMN "drill_type" TEXT;
ALTER TABLE "readiness_items" ADD COLUMN "drill_outcome" TEXT;
ALTER TABLE "readiness_items" ADD COLUMN "drill_participants" INTEGER;
ALTER TABLE "readiness_items" ADD COLUMN "drill_minutes" INTEGER;

-- READINESS_ITEM_KINDS in src/maintenance/readiness/readiness-rules.ts.
ALTER TABLE "readiness_items" DROP CONSTRAINT "readiness_items_kind_known";
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_kind_known"
  CHECK ("kind" IN ('task', 'inspection_campaign', 'contract_review', 'estimate', 'drill'));
-- A drill names its type (DRILL_TYPES) and nothing else does. Its outcome
-- (REASON_CODES.drillOutcome) and headcount come with its done, and only
-- then; its minutes too, when they were counted.
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_drill_shape"
  CHECK (("drill_type" IS NOT NULL) = ("kind" = 'drill')
     AND ("drill_type" IS NULL
          OR "drill_type" IN ('fire', 'evacuation', 'lockdown', 'medical', 'earthquake', 'other'))
     AND ("drill_outcome" IS NULL
          OR ("kind" = 'drill' AND "done_at" IS NOT NULL
              AND "drill_outcome" IN ('passed', 'issues_found', 'failed')))
     AND ("kind" <> 'drill' OR "done_at" IS NULL
          OR ("drill_outcome" IS NOT NULL AND "drill_participants" IS NOT NULL))
     AND ("drill_participants" IS NULL
          OR ("drill_outcome" IS NOT NULL AND "drill_participants" BETWEEN 0 AND 10000))
     AND ("drill_minutes" IS NULL
          OR ("drill_outcome" IS NOT NULL AND "drill_minutes" BETWEEN 1 AND 600)));

-- As 20261222090000, with the drill's type kept and its result written
-- once with its done.
CREATE OR REPLACE FUNCTION "readiness_items_end_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a readiness item is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."program_id" <> OLD."program_id" OR NEW."kind" <> OLD."kind"
     OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
     OR NEW."checklist_id" IS DISTINCT FROM OLD."checklist_id"
     OR NEW."copied_from_id" IS DISTINCT FROM OLD."copied_from_id"
     OR NEW."drill_type" IS DISTINCT FROM OLD."drill_type"
     OR NEW."created_at" <> OLD."created_at"
     OR (NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
         AND NEW."created_by_account_id" IS NOT NULL)
     OR (OLD."overdue_notified_at" IS NOT NULL
         AND NEW."overdue_notified_at" IS DISTINCT FROM OLD."overdue_notified_at"
         AND NOT (NEW."overdue_notified_at" IS NULL AND NEW."due_on" > OLD."due_on"))
     OR ((OLD."done_at" IS NOT NULL OR OLD."cancelled_at" IS NOT NULL) AND (
          NEW."done_at" IS DISTINCT FROM OLD."done_at"
       OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
       OR NEW."decision" IS DISTINCT FROM OLD."decision"
       OR NEW."drill_outcome" IS DISTINCT FROM OLD."drill_outcome"
       OR NEW."drill_participants" IS DISTINCT FROM OLD."drill_participants"
       OR NEW."drill_minutes" IS DISTINCT FROM OLD."drill_minutes"
       OR NEW."title" <> OLD."title"
       OR NEW."due_on" <> OLD."due_on"
       OR NEW."estimate_amount" IS DISTINCT FROM OLD."estimate_amount"
       OR NEW."owner_account_id" <> OLD."owner_account_id"
       OR (NEW."done_by_account_id" IS DISTINCT FROM OLD."done_by_account_id"
           AND NEW."done_by_account_id" IS NOT NULL)
       OR (NEW."cancelled_by_account_id" IS DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancelled_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a readiness item keeps what it names, and is done or called off once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
