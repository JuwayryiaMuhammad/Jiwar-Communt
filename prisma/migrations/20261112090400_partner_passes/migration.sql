-- ============================================================================
-- Phase P1 — the partner's service pass (ADR 0060). An accepted request may
-- give the partner's staff a one-time visitor pass for its window, in the
-- requester's name: the gate's own pass (ADR 0028, 0030, 0043), no new gate
-- logic. The request points at it, once.
-- ============================================================================

ALTER TABLE "partner_requests" ADD COLUMN "pass_id" UUID;
CREATE UNIQUE INDEX "partner_requests_pass_key" ON "partner_requests"("tenant_id", "pass_id");
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_pass_fkey"
  FOREIGN KEY ("tenant_id", "pass_id") REFERENCES "visitor_passes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A pass comes with an acceptance, for a request that asked for one.
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_pass_shape"
  CHECK ("pass_id" IS NULL OR ("gate_pass" AND "accepted_at" IS NOT NULL));

CREATE OR REPLACE FUNCTION partner_request_keeps_what_it_asked() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requester_account_id" = OLD."requester_account_id"
     AND NEW."category" = OLD."category"
     AND NEW."subcategory_id" IS NOT DISTINCT FROM OLD."subcategory_id"
     AND NEW."asked_starts_at" = OLD."asked_starts_at"
     AND NEW."asked_ends_at" = OLD."asked_ends_at"
     AND NEW."gate_pass" = OLD."gate_pass"
     AND NEW."created_at" = OLD."created_at"
     -- The service pass is given once and never changes.
     AND (OLD."pass_id" IS NULL OR NEW."pass_id" = OLD."pass_id")
     -- The note is kept, or cleared once by an erasure.
     AND (NEW."note" IS NOT DISTINCT FROM OLD."note"
          OR (NEW."note" IS NULL AND OLD."note_cleared_at" IS NULL
              AND NEW."note_cleared_at" IS NOT NULL))
     AND (OLD."note_cleared_at" IS NULL
          OR NEW."note_cleared_at" IS NOT DISTINCT FROM OLD."note_cleared_at")
     -- Accepted once: the agreement never changes.
     AND (OLD."accepted_at" IS NULL
          OR (NEW."accepted_at" = OLD."accepted_at"
              AND NEW."agreed_starts_at" = OLD."agreed_starts_at"
              AND NEW."agreed_ends_at" = OLD."agreed_ends_at"
              AND NEW."staff_count" = OLD."staff_count"))
     -- Closed once: how it closed never changes.
     AND (OLD."closed_at" IS NULL
          OR (NEW."status" = OLD."status"
              AND NEW."closed_at" = OLD."closed_at"
              AND NEW."closed_by" = OLD."closed_by"
              AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_requests: a request keeps what it asked and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
