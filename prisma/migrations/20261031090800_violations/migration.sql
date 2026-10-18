-- ============================================================================
-- Security (ADR 0053): violations, as the fines are (ADR 0045).
--
-- A guard on shift, or the office (`violations.issue`), issues one to a
-- unit: a kind (noise, waste, pets, contractor_hours, other), a works
-- permit for contractor hours, a place, a photo, a note the unit reads,
-- the local day, and an amount in EGP, or none (a warning). The unit
-- appeals it once, within 30 days; `violations.manage` decides. Paid at
-- the office with `fines.billing`: payments are append-only, a payment is
-- reversed once, a violation is paid exactly while a payment without its
-- reversal holds it. A warning is never paid.
--
-- * Its terms never change; the appeal is written once and only its words
--   and photo go, once (an erasure); a decision and a cancellation are
--   final. Never deleted.
-- ============================================================================

CREATE TABLE "unit_violations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "unit_id" UUID NOT NULL,
    -- Contractor hours: the works permit of the unit they worked under.
    "permit_id" UUID,
    -- Always 'works': the foreign key below points at a works permit only.
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "place_id" UUID,
    "note" TEXT,
    "photo_file_id" UUID,
    -- NULL: a warning.
    "amount" DECIMAL(10,2),
    "currency" TEXT,
    "occurred_on" DATE NOT NULL,
    "issued_by_account_id" UUID NOT NULL,
    -- A guard's: their shift and its post, for the daily report.
    "issued_shift_id" UUID,
    "post_gate_id" UUID,
    "post_place_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "appeal_text" TEXT,
    "appeal_photo_file_id" UUID,
    "appealed_by_account_id" UUID,
    "appealed_at" TIMESTAMPTZ(3),
    "appeal_cleared_at" TIMESTAMPTZ(3),
    "appeal_decision" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_violations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_violations_tenant_id_id_key" ON "unit_violations"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_violations_number_key" ON "unit_violations"("tenant_id", "number");
CREATE UNIQUE INDEX "unit_violations_photo_key" ON "unit_violations"("photo_file_id");
CREATE UNIQUE INDEX "unit_violations_appeal_photo_key" ON "unit_violations"("appeal_photo_file_id");
CREATE INDEX "unit_violations_unit_idx"
  ON "unit_violations"("tenant_id", "unit_id", "status", "created_at", "id");
CREATE INDEX "unit_violations_status_idx"
  ON "unit_violations"("tenant_id", "status", "created_at", "id");
CREATE INDEX "unit_violations_appellant_idx"
  ON "unit_violations"("tenant_id", "appealed_by_account_id")
  WHERE "appealed_by_account_id" IS NOT NULL;
ALTER TABLE "unit_violations"
  ADD CONSTRAINT "unit_violations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_place_fkey"
  FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_appeal_photo_fkey"
  FOREIGN KEY ("tenant_id", "appeal_photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_issued_by_fkey"
  FOREIGN KEY ("tenant_id", "issued_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_shift_fkey"
  FOREIGN KEY ("tenant_id", "issued_shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_post_gate_fkey"
  FOREIGN KEY ("tenant_id", "post_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_post_place_fkey"
  FOREIGN KEY ("tenant_id", "post_place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_appealed_by_fkey"
  FOREIGN KEY ("tenant_id", "appealed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violations_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_kind"
  CHECK ("kind" IN ('noise', 'waste', 'pets', 'contractor_hours', 'other'));
-- A permit only for contractor hours, and always a works permit.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_permit"
  CHECK ("permit_kind" = 'works'
     AND ("permit_id" IS NULL OR "kind" = 'contractor_hours'));
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
-- An amount in EGP, or none: a warning.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_amount"
  CHECK (("amount" IS NULL) = ("currency" IS NULL)
     AND ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 100000 AND "currency" = 'EGP')));
-- A guard's names its shift and post, one of a gate and a zone.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_post"
  CHECK (("issued_shift_id" IS NULL AND "post_gate_id" IS NULL AND "post_place_id" IS NULL)
      OR ("issued_shift_id" IS NOT NULL AND num_nonnulls("post_gate_id", "post_place_id") = 1));
-- The appeal: written together, once; cleared (words and photo) only.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_appeal_shape"
  CHECK (("appealed_at" IS NULL) = ("appealed_by_account_id" IS NULL)
     AND ("appealed_at" IS NOT NULL
          OR ("appeal_text" IS NULL AND "appeal_photo_file_id" IS NULL AND "appeal_cleared_at" IS NULL))
     AND ("appeal_text" IS NOT NULL OR "appealed_at" IS NULL OR "appeal_cleared_at" IS NOT NULL)
     AND ("appeal_cleared_at" IS NULL OR ("appeal_text" IS NULL AND "appeal_photo_file_id" IS NULL)));
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_appeal_text_length"
  CHECK ("appeal_text" IS NULL OR char_length("appeal_text") BETWEEN 1 AND 1000);
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_decision_shape"
  CHECK (("appeal_decision" IS NULL) = ("decided_at" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("decided_at" IS NULL OR "appealed_at" IS NOT NULL)
     AND ("appeal_decision" IS NULL OR "appeal_decision" IN ('upheld', 'cancelled')));
-- Under appeal exactly while appealed and undecided; cancelled with its
-- reason and who; paid only with an amount. status is NOT NULL.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_state_shape"
  CHECK ("status" IN ('open', 'under_appeal', 'paid', 'cancelled')
     AND ("status" = 'under_appeal') = ("appealed_at" IS NOT NULL AND "decided_at" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL)
     AND ("status" <> 'paid' OR "amount" IS NOT NULL));
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_accepted_cancels"
  CHECK ("appeal_decision" IS NULL OR "appeal_decision" <> 'cancelled'
      OR "status" = 'cancelled');
-- REASON_CODES.violationCancel.
ALTER TABLE "unit_violations" ADD CONSTRAINT "unit_violations_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('appeal_accepted', 'issued_in_error', 'duplicate', 'other'));

CREATE FUNCTION unit_violation_keeps_its_terms() RETURNS trigger
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
              AND NEW."cancelled_by_account_id" = OLD."cancelled_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_violations: a violation keeps its terms, one appeal and one decision, and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_violations_keep_terms
  BEFORE UPDATE OR DELETE ON "unit_violations"
  FOR EACH ROW EXECUTE FUNCTION unit_violation_keeps_its_terms();
CREATE TRIGGER unit_violations_keep_terms_truncate
  BEFORE TRUNCATE ON "unit_violations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Payments and their reversals: append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "unit_violation_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "violation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "currency" TEXT,
    "receipt_number" TEXT,
    "paid_on" DATE,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_violation_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_violation_payments_tenant_id_id_key" ON "unit_violation_payments"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_violation_payments_one_reversal"
  ON "unit_violation_payments"("tenant_id", "reverses_id");
-- A receipt is recorded once among the compound's violation payments.
CREATE UNIQUE INDEX "unit_violation_payments_receipt_key"
  ON "unit_violation_payments"("tenant_id", "receipt_number") WHERE "kind" = 'payment';
CREATE INDEX "unit_violation_payments_violation_idx"
  ON "unit_violation_payments"("tenant_id", "violation_id", "created_at", "id");
ALTER TABLE "unit_violation_payments"
  ADD CONSTRAINT "unit_violation_payments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violation_payments_violation_fkey"
  FOREIGN KEY ("tenant_id", "violation_id") REFERENCES "unit_violations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violation_payments_reverses_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "unit_violation_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_violation_payments_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_violation_payments" ADD CONSTRAINT "unit_violation_payments_kind_shape"
  CHECK ("kind" IN ('payment', 'reversal')
     AND ("kind" = 'payment') = ("amount" IS NOT NULL)
     AND ("kind" = 'payment') = ("currency" IS NOT NULL)
     AND ("kind" = 'payment') = ("receipt_number" IS NOT NULL)
     AND ("kind" = 'payment') = ("paid_on" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL));
ALTER TABLE "unit_violation_payments" ADD CONSTRAINT "unit_violation_payments_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 100000));
ALTER TABLE "unit_violation_payments" ADD CONSTRAINT "unit_violation_payments_currency"
  CHECK ("currency" IS NULL OR "currency" = 'EGP');
ALTER TABLE "unit_violation_payments" ADD CONSTRAINT "unit_violation_payments_receipt_shape"
  CHECK ("receipt_number" IS NULL OR "receipt_number" ~ '^[A-Za-z0-9/-]{1,40}$');
-- REASON_CODES.violationPaymentReverse.
ALTER TABLE "unit_violation_payments" ADD CONSTRAINT "unit_violation_payments_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('entered_in_error', 'refunded', 'other'));
CREATE TRIGGER unit_violation_payments_immutable_rows
  BEFORE UPDATE OR DELETE ON "unit_violation_payments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER unit_violation_payments_immutable_truncate
  BEFORE TRUNCATE ON "unit_violation_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
REVOKE ALL ON "unit_violations", "unit_violation_payments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_violations" TO jiwar_app;
GRANT SELECT, INSERT ON "unit_violation_payments" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_violations', 'unit_violation_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
