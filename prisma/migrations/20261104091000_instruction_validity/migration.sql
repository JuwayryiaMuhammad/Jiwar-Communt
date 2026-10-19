-- ============================================================================
-- Instructions with validity (ADR 0056): for a season or an exception, an
-- instruction may hold from a compound day and/or until one (inclusive),
-- set when it is sent and never changed. A guard sees, and acknowledges,
-- only those valid today; the management sees all, with their state.
--
-- A recipient is told once (`notified_at`), on the first day it is valid
-- for them: pushed at the send when it is valid that day; otherwise pushed
-- at their first shift start on a day it is valid. One added at a shift
-- start while it is valid is added silently, as before, and counts as told.
--
-- Both triggers are recreated: the validity is kept with what was sent,
-- and `notified_at` is written once.
-- ============================================================================

ALTER TABLE "guard_instructions"
  ADD COLUMN "valid_from" DATE,
  ADD COLUMN "valid_until" DATE;
ALTER TABLE "guard_instructions" ADD CONSTRAINT "guard_instructions_validity"
  CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" >= "valid_from");

ALTER TABLE "guard_instruction_recipients" ADD COLUMN "notified_at" TIMESTAMPTZ(3);
-- Every instruction before this migration holds every day: everyone it
-- reached was told (at the send) or added silently (at a shift start).
UPDATE "guard_instruction_recipients" SET "notified_at" = "added_at";

CREATE OR REPLACE FUNCTION guard_instruction_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."title" = OLD."title"
     AND NEW."body" = OLD."body"
     AND NEW."urgent" = OLD."urgent"
     AND NEW."audience" = OLD."audience"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."valid_from" IS NOT DISTINCT FROM OLD."valid_from"
     AND NEW."valid_until" IS NOT DISTINCT FROM OLD."valid_until"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."archived_at" IS NOT DISTINCT FROM OLD."archived_at"
           AND NEW."archived_by_account_id" IS NOT DISTINCT FROM OLD."archived_by_account_id")
          OR OLD."archived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_instructions: an instruction keeps what it says, is archived once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION guard_instruction_recipient_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."instruction_id" = OLD."instruction_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."added_via" = OLD."added_via"
     AND NEW."added_at" = OLD."added_at"
     AND (NEW."acknowledged_at" IS NOT DISTINCT FROM OLD."acknowledged_at"
          OR OLD."acknowledged_at" IS NULL)
     AND (NEW."notified_at" IS NOT DISTINCT FROM OLD."notified_at"
          OR OLD."notified_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_instruction_recipients: a recipient is acknowledged once and never removed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
