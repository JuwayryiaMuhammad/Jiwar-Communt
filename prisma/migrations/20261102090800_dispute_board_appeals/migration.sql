-- ============================================================================
-- Finance (ADR 0055): a rejected invoice dispute taken to the board. Its
-- mark: when the appeal was lodged, and when it ended (upheld, overturned
-- or withdrawn), each once and in that order, only on a rejected dispute.
-- An overturn does nothing here by itself: the management follows it up
-- (a credit note of its own).
-- ============================================================================

ALTER TABLE "invoice_disputes"
  ADD COLUMN "board_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "board_appeal_closed_at" TIMESTAMPTZ(3);
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_board_appeal"
  CHECK (("board_appeal_at" IS NULL OR "status" = 'rejected')
     AND ("board_appeal_closed_at" IS NULL OR "board_appeal_at" IS NOT NULL));

CREATE OR REPLACE FUNCTION invoice_dispute_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."invoice_id" = OLD."invoice_id" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."opened_by_account_id" = OLD."opened_by_account_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."created_at" = OLD."created_at"
     -- The decision: unchanged, or made now on an open dispute.
     AND ((NEW."status" = OLD."status"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."decision_reason_code" IS NOT DISTINCT FROM OLD."decision_reason_code")
          OR (OLD."status" = 'open' AND NEW."status" IN ('accepted', 'rejected')))
     -- The opener's words and photo: unchanged, or cleared now.
     AND ((NEW."text" IS NOT DISTINCT FROM OLD."text"
           AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
           AND NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at")
          OR (OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL
              AND NEW."text" IS NULL AND NEW."photo_file_id" IS NULL))
     -- The board appeal's marks (ADR 0055): each once.
     AND (NEW."board_appeal_at" IS NOT DISTINCT FROM OLD."board_appeal_at" OR OLD."board_appeal_at" IS NULL)
     AND (NEW."board_appeal_closed_at" IS NOT DISTINCT FROM OLD."board_appeal_closed_at" OR OLD."board_appeal_closed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice_disputes: only a decision, once, the clearing of the words and the board appeal''s marks may change a dispute (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
