-- ============================================================================
-- Vehicles and security (ADR 0055): a fine or a violation whose appeal the
-- staff upheld, taken to the board. Its marks: when the appeal to the board
-- was lodged, and when it ended, each once and in that order, only on a
-- fine or violation whose first appeal was upheld. While it runs, the
-- office takes no payment and cancels nothing (the services refuse). An
-- overturn cancels it with the system's reason `board_overturned`, the only
-- cancellation without an actor.
--
-- The triggers are recreated: the marks, and a cancellation's actor
-- compared with IS NOT DISTINCT FROM (a board's is NULL, and `=` on NULL
-- would refuse every later change, an erasure's clearing among them).
-- ============================================================================

ALTER TABLE "vehicle_fines"
  ADD COLUMN "board_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "board_appeal_closed_at" TIMESTAMPTZ(3);
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_board_appeal"
  CHECK (("board_appeal_at" IS NULL OR "appeal_decision" IS NOT DISTINCT FROM 'upheld')
     AND ("board_appeal_closed_at" IS NULL OR "board_appeal_at" IS NOT NULL));
ALTER TABLE "vehicle_fines" DROP CONSTRAINT "vehicle_fines_state_shape";
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_state_shape"
  CHECK (("status" = 'under_appeal') = ("appealed_at" IS NOT NULL AND "decided_at" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL OR "cancelled_by_account_id" IS NOT NULL
          OR "cancel_reason" = 'board_overturned'));
-- REASON_CODES.vehicleFineCancel and the system's vehicleFineSystemCancel.
ALTER TABLE "vehicle_fines" DROP CONSTRAINT "vehicle_fines_cancel_reason";
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('appeal_accepted', 'issued_in_error', 'duplicate', 'other', 'board_overturned'));

CREATE OR REPLACE FUNCTION vehicle_fine_keeps_its_terms() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."vehicle_id" IS NOT DISTINCT FROM OLD."vehicle_id"
     AND NEW."plate" = OLD."plate"
     AND NEW."reason" = OLD."reason"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."amount" = OLD."amount"
     AND NEW."currency" = OLD."currency"
     AND NEW."occurred_on" = OLD."occurred_on"
     AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
     AND NEW."issued_by_account_id" = OLD."issued_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     -- The appeal is written once; then only its words and photo go, once.
     AND (OLD."appealed_at" IS NULL
          OR (NEW."appealed_at" = OLD."appealed_at"
              AND NEW."appealed_by_account_id" = OLD."appealed_by_account_id"
              AND ((NEW."appeal_text" IS NOT DISTINCT FROM OLD."appeal_text"
                    AND NEW."appeal_photo_file_id" IS NOT DISTINCT FROM OLD."appeal_photo_file_id"
                    AND NEW."appeal_cleared_at" IS NOT DISTINCT FROM OLD."appeal_cleared_at")
                   OR (OLD."appeal_cleared_at" IS NULL
                       AND NEW."appeal_cleared_at" IS NOT NULL
                       AND NEW."appeal_text" IS NULL
                       AND NEW."appeal_photo_file_id" IS NULL))))
     -- A decision is final.
     AND (OLD."decided_at" IS NULL
          OR (NEW."decided_at" = OLD."decided_at"
              AND NEW."appeal_decision" = OLD."appeal_decision"
              AND NEW."decided_by_account_id" = OLD."decided_by_account_id"))
     -- A cancellation is final.
     AND (OLD."status" <> 'cancelled'
          OR (NEW."status" = 'cancelled'
              AND NEW."cancelled_at" = OLD."cancelled_at"
              AND NEW."cancel_reason" = OLD."cancel_reason"
              -- NULL when the board's overturn cancelled it (ADR 0055).
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"))
     -- The board appeal's marks (ADR 0055): each once.
     AND (NEW."board_appeal_at" IS NOT DISTINCT FROM OLD."board_appeal_at" OR OLD."board_appeal_at" IS NULL)
     AND (NEW."board_appeal_closed_at" IS NOT DISTINCT FROM OLD."board_appeal_closed_at" OR OLD."board_appeal_closed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vehicle_fines: a fine keeps its terms, one appeal and one decision (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

ALTER TABLE "unit_violations"
  ADD COLUMN "board_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "board_appeal_closed_at" TIMESTAMPTZ(3);
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_board_appeal"
  CHECK (("board_appeal_at" IS NULL OR "appeal_decision" IS NOT DISTINCT FROM 'upheld')
     AND ("board_appeal_closed_at" IS NULL OR "board_appeal_at" IS NOT NULL));
ALTER TABLE "unit_violations" DROP CONSTRAINT "unit_violations_state_shape";
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_state_shape"
  CHECK ("status" IN ('open', 'under_appeal', 'paid', 'cancelled')
     AND ("status" = 'under_appeal') = ("appealed_at" IS NOT NULL AND "decided_at" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL OR "cancelled_by_account_id" IS NOT NULL
          OR "cancel_reason" = 'board_overturned')
     AND ("status" <> 'paid' OR "amount" IS NOT NULL));
-- REASON_CODES.violationCancel and the system's violationSystemCancel.
ALTER TABLE "unit_violations" DROP CONSTRAINT "unit_violations_cancel_reason";
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('appeal_accepted', 'issued_in_error', 'duplicate', 'other', 'board_overturned'));

CREATE OR REPLACE FUNCTION unit_violation_keeps_its_terms() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."kind" = OLD."kind"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."permit_id" IS NOT DISTINCT FROM OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
     AND NEW."amount" IS NOT DISTINCT FROM OLD."amount"
     AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."occurred_on" = OLD."occurred_on"
     AND NEW."issued_by_account_id" = OLD."issued_by_account_id"
     AND NEW."issued_shift_id" IS NOT DISTINCT FROM OLD."issued_shift_id"
     AND NEW."post_gate_id" IS NOT DISTINCT FROM OLD."post_gate_id"
     AND NEW."post_place_id" IS NOT DISTINCT FROM OLD."post_place_id"
     AND NEW."created_at" = OLD."created_at"
     -- The appeal is written once; then only its words and photo go, once.
     AND (OLD."appealed_at" IS NULL
          OR (NEW."appealed_at" = OLD."appealed_at"
              AND NEW."appealed_by_account_id" = OLD."appealed_by_account_id"
              AND ((NEW."appeal_text" IS NOT DISTINCT FROM OLD."appeal_text"
                    AND NEW."appeal_photo_file_id" IS NOT DISTINCT FROM OLD."appeal_photo_file_id"
                    AND NEW."appeal_cleared_at" IS NOT DISTINCT FROM OLD."appeal_cleared_at")
                   OR (OLD."appeal_cleared_at" IS NULL
                       AND NEW."appeal_cleared_at" IS NOT NULL
                       AND NEW."appeal_text" IS NULL
                       AND NEW."appeal_photo_file_id" IS NULL))))
     -- A decision is final.
     AND (OLD."decided_at" IS NULL
          OR (NEW."decided_at" = OLD."decided_at"
              AND NEW."appeal_decision" = OLD."appeal_decision"
              AND NEW."decided_by_account_id" = OLD."decided_by_account_id"))
     -- A cancellation is final.
     AND (OLD."status" <> 'cancelled'
          OR (NEW."status" = 'cancelled'
              AND NEW."cancelled_at" = OLD."cancelled_at"
              AND NEW."cancel_reason" = OLD."cancel_reason"
              -- NULL when the board's overturn cancelled it (ADR 0055).
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"))
     -- The board appeal's marks (ADR 0055): each once.
     AND (NEW."board_appeal_at" IS NOT DISTINCT FROM OLD."board_appeal_at" OR OLD."board_appeal_at" IS NULL)
     AND (NEW."board_appeal_closed_at" IS NOT DISTINCT FROM OLD."board_appeal_closed_at" OR OLD."board_appeal_closed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_violations: a violation keeps its terms, one appeal and one decision, and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
