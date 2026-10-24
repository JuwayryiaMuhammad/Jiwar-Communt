-- ============================================================================
-- Decision appeals (ADR 0059): what the appealed decisions keep.
--
-- Permits: an appeal's mark (the purge leaves a marked permit), its
-- closing, and an overturn that approves the rejected permit once, by the
-- manager who decided it or by the board (no account). The rejection's
-- reason, time and decider stay as history; the trigger is recreated with
-- the move rejected -> approved, only with the overturn.
--
-- Workers: when a review decided an engagement, and a rejection's code
-- (REASON_CODES.workerReject, or the system's `underage`); before this,
-- neither was kept, so older rejections cannot be appealed.
--
-- Neighbour notices: withdrawn once, by an overturned appeal; the notice
-- and its recipients otherwise stay as sent.
-- ============================================================================

ALTER TABLE "unit_permits"
  ADD COLUMN "decision_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "decision_appeal_closed_at" TIMESTAMPTZ(3),
  ADD COLUMN "appeal_overturned_at" TIMESTAMPTZ(3),
  ADD COLUMN "appeal_overturned_by_account_id" UUID;
ALTER TABLE "unit_permits"
  ADD CONSTRAINT "unit_permits_tenant_id_appeal_overturned_by_fkey"
  FOREIGN KEY ("tenant_id", "appeal_overturned_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_decision_appeal"
  CHECK (("decision_appeal_closed_at" IS NULL OR "decision_appeal_at" IS NOT NULL)
     AND ("appeal_overturned_at" IS NULL OR "decision_appeal_closed_at" IS NOT NULL)
     AND ("appeal_overturned_by_account_id" IS NULL OR "appeal_overturned_at" IS NOT NULL));
-- A rejected permit has its reason; an overturned one keeps it.
ALTER TABLE "unit_permits" DROP CONSTRAINT "unit_permits_state_shape";
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_state_shape"
  CHECK (("decided_at" IS NULL) = ("decision_source" IS NULL)
     AND ("decided_by_account_id" IS NULL OR "decided_at" IS NOT NULL)
     AND ("staff_note" IS NULL OR "decided_at" IS NOT NULL)
     AND ("status" <> 'pending' OR ("decided_at" IS NULL AND "cancelled_at" IS NULL))
     AND ("status" <> 'rejected' OR "reject_reason" IS NOT NULL)
     AND ("reject_reason" IS NULL OR "status" = 'rejected' OR "appeal_overturned_at" IS NOT NULL)
     AND ("status" NOT IN ('approved', 'rejected', 'revoked', 'used') OR "decided_at" IS NOT NULL)
     AND ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
     AND ("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL)
     AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
     AND ("revoke_note" IS NULL OR "revoked_at" IS NOT NULL)
     AND ("status" = 'used') = ("used_at" IS NOT NULL)
     AND ("used_at" IS NULL) = ("used_by_account_id" IS NULL)
     AND ("used_at" IS NULL) = ("used_gate_id" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_side" IS NULL));

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
     AND (NEW."decision_appeal_closed_at" IS NOT DISTINCT FROM OLD."decision_appeal_closed_at"
          OR OLD."decision_appeal_closed_at" IS NULL)
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


ALTER TABLE "worker_engagements"
  ADD COLUMN "decided_at" TIMESTAMPTZ(3),
  ADD COLUMN "reject_reason" TEXT;
-- REASON_CODES.workerReject and the system's underage; a unit test keeps
-- them in step.
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_reject_reason"
  CHECK ("reject_reason" IS NULL
      OR ("status" = 'rejected' AND "decided_at" IS NOT NULL
          AND "reject_reason" IN ('documents_invalid', 'not_verified', 'other', 'underage')));
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_decided"
  CHECK ("decided_at" IS NULL OR ("status" <> 'pending_review' AND "reviewed_by" IS NOT NULL));

ALTER TABLE "neighbour_complaint_notices" ADD COLUMN "withdrawn_at" TIMESTAMPTZ(3);
ALTER TABLE "neighbour_complaint_notices" ADD CONSTRAINT "neighbour_complaint_notices_withdrawn"
  CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" >= "created_at");
DROP TRIGGER "neighbour_complaint_notices_immutable_rows" ON "neighbour_complaint_notices";
CREATE FUNCTION neighbour_complaint_notice_withdrawn_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."complaint_id" = OLD."complaint_id"
     AND NEW."body" = OLD."body"
     AND NEW."recipient_kind" = OLD."recipient_kind"
     AND NEW."sent_by_account_id" = OLD."sent_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."withdrawn_at" IS NULL AND NEW."withdrawn_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_complaint_notices: a notice stays as sent; it is withdrawn once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_complaint_notices_withdrawn_once
  BEFORE UPDATE OR DELETE ON "neighbour_complaint_notices"
  FOR EACH ROW EXECUTE FUNCTION neighbour_complaint_notice_withdrawn_once();
GRANT UPDATE ("withdrawn_at") ON "neighbour_complaint_notices" TO jiwar_app;
