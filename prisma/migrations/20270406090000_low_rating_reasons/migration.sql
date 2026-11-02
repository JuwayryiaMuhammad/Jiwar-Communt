-- ============================================================================
-- Why a rating is low (ADR 0082). A resident who rates a service 1 or 2 out of
-- 5 says why, from one closed list (REASON_CODES.lowRating), on each of the
-- three ratings the compound has: a ticket's confirmation (ADR 0038), a
-- management request's (ADR 0039) and a partner request's (ADR 0060). A
-- higher rating has no reason. Ratings written before this have none either,
-- so the CHECK holds the code to the list and to a low rating; the services
-- require it on a new low rating. A code, never words: not personal data.
-- ============================================================================

ALTER TABLE "ticket_feedback" ADD COLUMN "low_reason_code" TEXT;
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_low_reason"
  CHECK ("low_reason_code" IS NULL
      OR ("kind" = 'confirmed' AND "rating" IS NOT NULL AND "rating" <= 2
          AND "low_reason_code" IN ('not_fixed', 'slow', 'poor_quality', 'staff_conduct',
                                    'no_show', 'poor_communication', 'price', 'other')));
-- The experience sweep and reports read a compound's ratings by when.
CREATE INDEX "ticket_feedback_created_idx" ON "ticket_feedback"("tenant_id", "created_at");

ALTER TABLE "management_request_ratings" ADD COLUMN "low_reason_code" TEXT;
ALTER TABLE "management_request_ratings" ADD CONSTRAINT "management_request_ratings_low_reason"
  CHECK ("low_reason_code" IS NULL
      OR ("rating" <= 2
          AND "low_reason_code" IN ('not_fixed', 'slow', 'poor_quality', 'staff_conduct',
                                    'no_show', 'poor_communication', 'price', 'other')));
CREATE INDEX "management_request_ratings_created_idx"
  ON "management_request_ratings"("tenant_id", "created_at");

ALTER TABLE "partner_ratings" ADD COLUMN "low_reason_code" TEXT;
ALTER TABLE "partner_ratings" ADD CONSTRAINT "partner_ratings_low_reason"
  CHECK ("low_reason_code" IS NULL
      OR ("stars" <= 2
          AND "low_reason_code" IN ('not_fixed', 'slow', 'poor_quality', 'staff_conduct',
                                    'no_show', 'poor_communication', 'price', 'other')));
CREATE INDEX "partner_ratings_created_idx" ON "partner_ratings"("tenant_id", "created_at");

-- A rating never changes but for its comment cleared by an erasure (ADR
-- 0039, 0060): its reason neither. The two functions again, with the code.
CREATE OR REPLACE FUNCTION management_rating_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."author_account_id" IS DISTINCT FROM OLD."author_account_id"
     OR NEW."rating" IS DISTINCT FROM OLD."rating"
     OR NEW."low_reason_code" IS DISTINCT FROM OLD."low_reason_code"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."comment" IS NULL OR NEW."comment" IS NOT NULL THEN
    RAISE EXCEPTION 'a management request rating never changes (only an erasure clears its comment)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION partner_rating_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."request_id" = OLD."request_id"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."rater_account_id" = OLD."rater_account_id"
     AND NEW."stars" = OLD."stars"
     AND NEW."low_reason_code" IS NOT DISTINCT FROM OLD."low_reason_code"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."comment_cleared_at" IS NULL
     AND NEW."comment" IS NULL
     AND NEW."comment_cleared_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_ratings: a rating never changes but for its comment cleared once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
