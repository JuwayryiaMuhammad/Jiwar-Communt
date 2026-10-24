-- ============================================================================
-- The board's new kinds of appeal (ADR 0059, on ADR 0055).
--
-- `management_appeal`: a decision appeal the management upheld, taken to
-- the board by an owner of the unit or its primary within 15 days. The
-- decision appeal carries the board's mark (set once, closed once); a
-- board overturn applies the same domain effect, through the same checks
-- (no manager decides it: what needs one is left to follow up). A permit
-- re-opens its appeal mark for it, so the purge waits for the board too.
--
-- `management_complaint`: an owner or a unit's primary complains about the
-- management to the board: a category, the request it is about (its
-- number, optional) and the grounds, which are the board appeal's. Lodged
-- as the board appeal at once; overturned means founded, followed up by
-- the management. At most three open per owner (the service counts them
-- under the owner's lock). The staff never see the unit or the grounds.
-- ============================================================================

ALTER TABLE "governance_board_appeals" DROP CONSTRAINT "governance_board_appeals_kind";
ALTER TABLE "governance_board_appeals" ADD CONSTRAINT "governance_board_appeals_kind"
  CHECK ("kind" IN ('vehicle_fine', 'unit_violation', 'booking_suspension', 'invoice_dispute', 'management_appeal', 'management_complaint'));

ALTER TABLE "decision_appeals"
  ADD COLUMN "board_appeal_at" TIMESTAMPTZ(3),
  ADD COLUMN "board_appeal_closed_at" TIMESTAMPTZ(3);
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_board_appeal"
  CHECK (("board_appeal_closed_at" IS NULL OR "board_appeal_at" IS NOT NULL)
     AND ("board_appeal_at" IS NULL OR "status" = 'upheld'));
CREATE OR REPLACE FUNCTION decision_appeal_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."kind" = OLD."kind"
     AND NEW."subject_id" = OLD."subject_id" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."appellant_account_id" = OLD."appellant_account_id"
     AND NEW."decision_at" = OLD."decision_at"
     AND NEW."decision_by_account_id" IS NOT DISTINCT FROM OLD."decision_by_account_id"
     AND NEW."lodged_at" = OLD."lodged_at"
     AND ((NEW."grounds" IS NOT DISTINCT FROM OLD."grounds"
           AND NEW."grounds_cleared_at" IS NOT DISTINCT FROM OLD."grounds_cleared_at")
          OR (OLD."grounds_cleared_at" IS NULL AND NEW."grounds" IS NULL))
     AND (NEW."status" = OLD."status" OR OLD."status" = 'pending')
     AND ((NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decider_role_key" IS NOT DISTINCT FROM OLD."decider_role_key"
           AND NEW."decider_role_name" IS NOT DISTINCT FROM OLD."decider_role_name"
           AND NEW."rationale" IS NOT DISTINCT FROM OLD."rationale")
          OR OLD."status" = 'pending')
     AND (NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at" OR OLD."withdrawn_at" IS NULL)
     AND ((NEW."effect" IS NOT DISTINCT FROM OLD."effect"
           AND NEW."effect_reason" IS NOT DISTINCT FROM OLD."effect_reason")
          OR OLD."effect" IS NULL)
     AND (NEW."board_appeal_at" IS NOT DISTINCT FROM OLD."board_appeal_at" OR OLD."board_appeal_at" IS NULL)
     AND (NEW."board_appeal_closed_at" IS NOT DISTINCT FROM OLD."board_appeal_closed_at"
          OR OLD."board_appeal_closed_at" IS NULL)
     AND ((NEW."followed_up_at" IS NOT DISTINCT FROM OLD."followed_up_at"
           AND NEW."followed_up_by_account_id" IS NOT DISTINCT FROM OLD."followed_up_by_account_id")
          OR OLD."followed_up_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'decision_appeals: an appeal is kept as lodged and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

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

CREATE TABLE "management_complaints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "request_number" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "management_complaints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_complaints_tenant_id_id_key"
  ON "management_complaints"("tenant_id", "id");
CREATE INDEX "management_complaints_author_idx"
  ON "management_complaints"("tenant_id", "author_account_id", "created_at");
ALTER TABLE "management_complaints"
  ADD CONSTRAINT "management_complaints_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_complaints_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_complaints_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- MANAGEMENT_COMPLAINT_CATEGORIES; a unit test keeps them in step.
ALTER TABLE "management_complaints" ADD CONSTRAINT "management_complaints_category"
  CHECK ("category" IN ('conduct', 'delay', 'unfair_decision', 'service_quality', 'other'));
ALTER TABLE "management_complaints" ADD CONSTRAINT "management_complaints_request_number"
  CHECK ("request_number" IS NULL OR "request_number" >= 1);
CREATE TRIGGER management_complaints_immutable_rows
  BEFORE UPDATE OR DELETE ON "management_complaints"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER management_complaints_immutable_truncate
  BEFORE TRUNCATE ON "management_complaints"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "management_complaints" FROM jiwar_app;
-- UPDATE only so the board appeal's lodge may lock it (the trigger refuses
-- every change).
GRANT SELECT, INSERT, UPDATE ON "management_complaints" TO jiwar_app;
ALTER TABLE "management_complaints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "management_complaints" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "management_complaints"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
