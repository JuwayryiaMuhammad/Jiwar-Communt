-- ============================================================================
-- Phase R6b — invoice disputes (ADR 0048). Someone who sees a unit's money
-- disputes an invoice with a reason's code, optional words (1–1000) and an
-- optional photo; one open dispute per invoice. While it is open the invoice
-- is frozen: no reminder, no automatic allocation, no manual credit note.
-- Staff accept it (a credit note of the system reason `dispute`, full or
-- partial) or reject it with a reason's code. The resident's words and photo
-- are cleared when they are erased: the only change besides the decision.
-- ============================================================================

CREATE TYPE "invoice_dispute_status" AS ENUM ('open', 'accepted', 'rejected');

CREATE TABLE "invoice_disputes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "opened_by_account_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "text" TEXT,
    "photo_file_id" UUID,
    "text_cleared_at" TIMESTAMPTZ(3),
    "status" "invoice_dispute_status" NOT NULL DEFAULT 'open',
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_disputes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_disputes_tenant_id_id_key" ON "invoice_disputes"("tenant_id", "id");
-- One open dispute per invoice; decided ones stay as history.
CREATE UNIQUE INDEX "invoice_disputes_one_open" ON "invoice_disputes"("tenant_id", "invoice_id")
  WHERE "status" = 'open';
CREATE INDEX "invoice_disputes_invoice_idx" ON "invoice_disputes"("tenant_id", "invoice_id", "created_at");
CREATE INDEX "invoice_disputes_created_idx" ON "invoice_disputes"("tenant_id", "created_at", "id");
CREATE INDEX "invoice_disputes_opened_by_idx" ON "invoice_disputes"("tenant_id", "opened_by_account_id");
ALTER TABLE "invoice_disputes"
  ADD CONSTRAINT "invoice_disputes_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_disputes_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_disputes_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_disputes_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_disputes_tenant_id_photo_file_id_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.invoiceDispute; a unit test keeps the three in step.
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_reason"
  CHECK ("reason_code" IN ('already_paid', 'wrong_amount', 'not_my_unit', 'service_not_provided', 'duplicate_invoice', 'other'));
-- REASON_CODES.invoiceDisputeReject.
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_decision_reason"
  CHECK ("decision_reason_code" IS NULL
      OR "decision_reason_code" IN ('charge_is_correct', 'payment_not_found', 'outside_policy', 'no_longer_owed', 'other'));
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_text_length"
  CHECK ("text" IS NULL OR char_length("text") BETWEEN 1 AND 1000);
-- Decided ⇔ who and when; rejected ⇔ the reason (an acceptance's credit
-- note is checked at commit, below).
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_decision_shape"
  CHECK (("status" = 'open') = ("decided_at" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("status" = 'rejected') = ("decision_reason_code" IS NOT NULL));
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_cleared_shape"
  CHECK ("text_cleared_at" IS NULL OR ("text" IS NULL AND "photo_file_id" IS NULL));

-- A dispute is decided once, and its opener's words and photo are cleared
-- once; in either order, nothing else ever changes.
CREATE FUNCTION invoice_dispute_moves() RETURNS trigger
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
              AND NEW."text" IS NULL AND NEW."photo_file_id" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice_disputes: only a decision, once, and the clearing of the words may change a dispute (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER invoice_disputes_moves
  BEFORE UPDATE OR DELETE ON "invoice_disputes"
  FOR EACH ROW EXECUTE FUNCTION invoice_dispute_moves();
CREATE TRIGGER invoice_disputes_immutable_truncate
  BEFORE TRUNCATE ON "invoice_disputes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An acceptance's credit note names its dispute (one per dispute), and only
-- such a note does. The link runs one way: the dispute finds its note.
-- ----------------------------------------------------------------------------
ALTER TABLE "credit_notes" ADD COLUMN "dispute_id" UUID;
CREATE UNIQUE INDEX "credit_notes_one_per_dispute" ON "credit_notes"("tenant_id", "dispute_id");
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_tenant_id_dispute_id_fkey"
  FOREIGN KEY ("tenant_id", "dispute_id") REFERENCES "invoice_disputes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_dispute_link"
  CHECK (("reason_code" = 'dispute') = ("dispute_id" IS NOT NULL));
-- REASON_CODES.creditNote + REASON_CODES.creditNoteSystem.
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_reason";
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_reason"
  CHECK ("reason_code" IN ('billing_error', 'waiver', 'duplicate', 'goodwill', 'other', 'instalment_plan', 'dispute'));

-- At commit: a dispute is accepted exactly when a credit note names it,
-- and that note is on the dispute's own invoice.
CREATE FUNCTION finance_dispute_credit_note_matches() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  d uuid;
  accepted boolean;
  dispute_invoice uuid;
  notes integer;
  on_other integer;
BEGIN
  IF TG_TABLE_NAME = 'invoice_disputes' THEN
    d := NEW."id";
  ELSE
    d := NEW."dispute_id";
    IF d IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT x."status" = 'accepted', x."invoice_id" INTO accepted, dispute_invoice
    FROM "invoice_disputes" x WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = d;
  SELECT count(*), count(*) FILTER (WHERE c."invoice_id" <> dispute_invoice)
    INTO notes, on_other
    FROM "credit_notes" c WHERE c."tenant_id" = NEW."tenant_id" AND c."dispute_id" = d;
  IF accepted <> (notes = 1) OR on_other > 0 THEN
    RAISE EXCEPTION 'dispute %: accepted (%) must have exactly one credit note on its invoice (% found)', d, accepted, notes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER invoice_disputes_credit_note
  AFTER INSERT OR UPDATE ON "invoice_disputes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_dispute_credit_note_matches();
CREATE CONSTRAINT TRIGGER credit_notes_dispute
  AFTER INSERT ON "credit_notes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_dispute_credit_note_matches();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A dispute is updated by its decision and its clearing.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "invoice_disputes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "invoice_disputes" TO jiwar_app;
ALTER TABLE "invoice_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_disputes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_disputes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
