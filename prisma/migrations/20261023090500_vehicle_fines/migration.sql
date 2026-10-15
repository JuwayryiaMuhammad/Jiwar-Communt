-- ============================================================================
-- Vehicles and parking (ADR 0045): fines to a unit, their one appeal, and
-- the payments made at the office.
--
-- A fine names the unit, the plate (a vehicle's, snapshotted, or as the
-- staff typed it), a reason code, an amount in EGP and the local day it
-- happened; none of that ever changes. It is `unpaid`, `under_appeal`
-- (appealed once: the appeal's fields are written once), `paid` while a
-- payment without a reversal holds it, or `cancelled` (final). An erased
-- appellant's words and photo are cleared, nothing else of the appeal.
-- Payments are append-only: a wrong one is reversed by a new record, once.
-- The fine carries nothing of a parking report it may have come from.
-- ============================================================================

CREATE TYPE "vehicle_fine_status" AS ENUM ('unpaid', 'under_appeal', 'paid', 'cancelled');
CREATE TYPE "vehicle_fine_decision" AS ENUM ('upheld', 'cancelled');
CREATE TYPE "vehicle_fine_payment_kind" AS ENUM ('payment', 'reversal');

CREATE TABLE "vehicle_fines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "plate" TEXT NOT NULL,
    "plate_key" TEXT GENERATED ALWAYS AS (
      translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789')
    ) STORED,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "occurred_on" DATE NOT NULL,
    "photo_file_id" UUID,
    "issued_by_account_id" UUID NOT NULL,
    "status" "vehicle_fine_status" NOT NULL DEFAULT 'unpaid',
    "appeal_text" TEXT,
    "appeal_photo_file_id" UUID,
    "appealed_by_account_id" UUID,
    "appealed_at" TIMESTAMPTZ(3),
    "appeal_cleared_at" TIMESTAMPTZ(3),
    "appeal_decision" "vehicle_fine_decision",
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vehicle_fines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_fines_tenant_id_id_key" ON "vehicle_fines"("tenant_id", "id");
CREATE UNIQUE INDEX "vehicle_fines_number_key" ON "vehicle_fines"("tenant_id", "number");
CREATE INDEX "vehicle_fines_unit_idx" ON "vehicle_fines"("tenant_id", "unit_id", "status", "created_at", "id");
CREATE INDEX "vehicle_fines_status_idx" ON "vehicle_fines"("tenant_id", "status", "created_at", "id");
CREATE INDEX "vehicle_fines_plate_key_idx" ON "vehicle_fines"("tenant_id", "plate_key");
CREATE INDEX "vehicle_fines_appellant_idx" ON "vehicle_fines"("tenant_id", "appealed_by_account_id")
  WHERE "appealed_by_account_id" IS NOT NULL;
ALTER TABLE "vehicle_fines"
  ADD CONSTRAINT "vehicle_fines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_vehicle_id_fkey"
  FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_appeal_photo_fkey"
  FOREIGN KEY ("tenant_id", "appeal_photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_issued_by_fkey"
  FOREIGN KEY ("tenant_id", "issued_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_appealed_by_fkey"
  FOREIGN KEY ("tenant_id", "appealed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fines_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_plate_length"
  CHECK (char_length("plate") BETWEEN 1 AND 12);
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_amount"
  CHECK ("amount" > 0 AND "amount" <= 100000 AND "currency" = 'EGP');
-- REASON_CODES.vehicleFineReason; a unit test keeps the two in step.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_reason"
  CHECK ("reason" IN ('parked_in_visitor_slot', 'parked_in_others_slot', 'blocking',
                      'no_permit', 'fire_lane', 'other'));
-- The appeal: written together, once; cleared (words and photo) only.
-- Nullable columns only under IS [NOT] NULL.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_appeal_shape"
  CHECK (("appealed_at" IS NULL) = ("appealed_by_account_id" IS NULL)
     AND ("appealed_at" IS NOT NULL
          OR ("appeal_text" IS NULL AND "appeal_photo_file_id" IS NULL AND "appeal_cleared_at" IS NULL))
     AND ("appeal_text" IS NOT NULL OR "appealed_at" IS NULL OR "appeal_cleared_at" IS NOT NULL)
     AND ("appeal_cleared_at" IS NULL OR ("appeal_text" IS NULL AND "appeal_photo_file_id" IS NULL)));
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_appeal_text_length"
  CHECK ("appeal_text" IS NULL OR char_length("appeal_text") BETWEEN 1 AND 1000);
-- A decision follows an appeal. Nullable columns only under IS [NOT] NULL.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_decision_shape"
  CHECK (("appeal_decision" IS NULL) = ("decided_at" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("decided_at" IS NULL OR "appealed_at" IS NOT NULL));
-- Under appeal exactly while appealed and undecided; cancelled with its
-- reason and who. Status is NOT NULL.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_state_shape"
  CHECK (("status" = 'under_appeal') = ("appealed_at" IS NOT NULL AND "decided_at" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL));
-- An appeal decided "cancelled" is a cancellation, with its reason code.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_accepted_cancels"
  CHECK ("appeal_decision" IS NULL OR "appeal_decision" <> 'cancelled'
      OR "status" = 'cancelled');
-- REASON_CODES.vehicleFineCancel.
ALTER TABLE "vehicle_fines" ADD CONSTRAINT "vehicle_fines_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('appeal_accepted', 'issued_in_error', 'duplicate', 'other'));

CREATE FUNCTION vehicle_fine_keeps_its_terms() RETURNS trigger
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
              AND NEW."cancelled_by_account_id" = OLD."cancelled_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vehicle_fines: a fine keeps its terms, one appeal and one decision (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER vehicle_fines_keep_terms
  BEFORE UPDATE OR DELETE ON "vehicle_fines"
  FOR EACH ROW EXECUTE FUNCTION vehicle_fine_keeps_its_terms();
CREATE TRIGGER vehicle_fines_keep_terms_truncate
  BEFORE TRUNCATE ON "vehicle_fines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Payments and their reversals: append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "vehicle_fine_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fine_id" UUID NOT NULL,
    "kind" "vehicle_fine_payment_kind" NOT NULL,
    "amount" DECIMAL(10,2),
    "currency" TEXT,
    "receipt_number" TEXT,
    "paid_on" DATE,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehicle_fine_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_fine_payments_tenant_id_id_key" ON "vehicle_fine_payments"("tenant_id", "id");
CREATE UNIQUE INDEX "vehicle_fine_payments_one_reversal" ON "vehicle_fine_payments"("tenant_id", "reverses_id");
-- A receipt is recorded once among the compound's fine payments.
CREATE UNIQUE INDEX "vehicle_fine_payments_receipt_key"
  ON "vehicle_fine_payments"("tenant_id", "receipt_number") WHERE "kind" = 'payment';
CREATE INDEX "vehicle_fine_payments_fine_idx"
  ON "vehicle_fine_payments"("tenant_id", "fine_id", "created_at", "id");
ALTER TABLE "vehicle_fine_payments"
  ADD CONSTRAINT "vehicle_fine_payments_tenant_id_fine_id_fkey"
  FOREIGN KEY ("tenant_id", "fine_id") REFERENCES "vehicle_fines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fine_payments_tenant_id_reverses_id_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "vehicle_fine_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_fine_payments_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A payment sets what was paid and when; a reversal names the payment and
-- why. Nullable columns appear only under IS [NOT] NULL here.
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_kind_shape"
  CHECK (("kind" = 'payment') = ("amount" IS NOT NULL)
     AND ("kind" = 'payment') = ("currency" IS NOT NULL)
     AND ("kind" = 'payment') = ("receipt_number" IS NOT NULL)
     AND ("kind" = 'payment') = ("paid_on" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL));
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 100000));
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_currency"
  CHECK ("currency" IS NULL OR "currency" = 'EGP');
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_receipt_shape"
  CHECK ("receipt_number" IS NULL OR "receipt_number" ~ '^[A-Za-z0-9/-]{1,40}$');
-- REASON_CODES.vehicleFinePaymentReverse.
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('entered_in_error', 'refunded', 'other'));
CREATE TRIGGER vehicle_fine_payments_immutable_rows
  BEFORE UPDATE OR DELETE ON "vehicle_fine_payments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER vehicle_fine_payments_immutable_truncate
  BEFORE TRUNCATE ON "vehicle_fine_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted; payments are never updated.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "vehicle_fines", "vehicle_fine_payments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "vehicle_fines" TO jiwar_app;
GRANT SELECT, INSERT ON "vehicle_fine_payments" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle_fines', 'vehicle_fine_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
