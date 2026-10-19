-- ============================================================================
-- Facilities (ADR 0055): a suspension from booking taken to the board by
-- an owner of the unit or its primary, while it is in force, within 15
-- days of its start. Its marks: when the appeal was lodged and when it
-- ended, each once and in that order. An overturn lifts it, if still in
-- force, with the system's `board_overturned`: the only lift without an
-- actor. The trigger is recreated with the marks, and with a lift's actor
-- compared IS NOT DISTINCT FROM.
-- ============================================================================

ALTER TABLE "booking_suspensions"
  ADD COLUMN "board_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "board_appeal_closed_at" TIMESTAMPTZ(3);
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_board_appeal"
  CHECK (("board_appeal_closed_at" IS NULL OR "board_appeal_at" IS NOT NULL)
     AND ("board_appeal_at" IS NULL OR "board_appeal_at" >= "starts_at"));
ALTER TABLE "booking_suspensions" DROP CONSTRAINT "booking_suspensions_lifted_shape";
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_lifted_shape"
  CHECK (("lifted_at" IS NULL) = ("lift_reason_code" IS NULL)
     AND ("lifted_by_account_id" IS NULL OR "lifted_at" IS NOT NULL)
     AND ("lifted_at" IS NULL OR "lifted_by_account_id" IS NOT NULL
          OR "lift_reason_code" = 'board_overturned'));
-- REASON_CODES.bookingSuspensionLift and the system's bookingSuspensionSystemLift.
ALTER TABLE "booking_suspensions" DROP CONSTRAINT "booking_suspensions_lift_reason";
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_lift_reason"
  CHECK ("lift_reason_code" IS NULL
      OR "lift_reason_code" IN ('staff_error', 'exception_granted', 'other', 'board_overturned'));

CREATE OR REPLACE FUNCTION booking_suspension_keeps_its_window() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."trigger_booking_id" = OLD."trigger_booking_id"
     AND NEW."no_show_count" = OLD."no_show_count"
     AND NEW."created_at" = OLD."created_at"
     AND (
       (NEW."lifted_at" IS NOT DISTINCT FROM OLD."lifted_at"
        AND NEW."lifted_by_account_id" IS NOT DISTINCT FROM OLD."lifted_by_account_id"
        AND NEW."lift_reason_code" IS NOT DISTINCT FROM OLD."lift_reason_code")
       OR OLD."lifted_at" IS NULL
     )
     -- The board appeal's marks (ADR 0055): each once.
     AND (NEW."board_appeal_at" IS NOT DISTINCT FROM OLD."board_appeal_at" OR OLD."board_appeal_at" IS NULL)
     AND (NEW."board_appeal_closed_at" IS NOT DISTINCT FROM OLD."board_appeal_closed_at" OR OLD."board_appeal_closed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_suspensions: a suspension keeps its window and is lifted once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
