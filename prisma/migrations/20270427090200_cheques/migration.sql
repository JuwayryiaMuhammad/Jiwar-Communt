-- ============================================================================
-- The cheque register (ADR 0085): every cheque a unit pays with, from the
-- day it is received. One dated today or earlier pays at once, as an office
-- payment by cheque always did (ADR 0046); a post-dated one is held, and
-- pays when it is deposited, from its due day. Received → deposited →
-- cleared or bounced; a cheque not yet deposited may be given back. A
-- bounce, or giving back a cheque that paid, reverses its payment through
-- the payments' own reversal. The number is the cheque's, never the
-- payer's account; no drawer's name is kept.
-- ============================================================================

CREATE TABLE "finance_cheques" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "bank_name" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "due_on" DATE NOT NULL,
    "received_on" DATE NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "payment_id" UUID,
    "deposited_to_account_id" UUID,
    "deposited_on" DATE,
    "deposited_by_account_id" UUID,
    "cleared_on" DATE,
    "cleared_by_account_id" UUID,
    "bounced_on" DATE,
    "bounced_by_account_id" UUID,
    "bounce_reason" TEXT,
    "returned_on" DATE,
    "returned_by_account_id" UUID,
    "return_reason" TEXT,
    "due_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_cheques_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_cheques_tenant_id_id_key" ON "finance_cheques"("tenant_id", "id");
-- A payment is one cheque's.
CREATE UNIQUE INDEX "finance_cheques_payment_key"
  ON "finance_cheques"("tenant_id", "payment_id") WHERE "payment_id" IS NOT NULL;
CREATE INDEX "finance_cheques_list_idx" ON "finance_cheques"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "finance_cheques_unit_idx" ON "finance_cheques"("tenant_id", "unit_id", "created_at" DESC);
-- The due sweep's: held cheques by due day, not yet told.
CREATE INDEX "finance_cheques_due_idx"
  ON "finance_cheques"("tenant_id", "due_on") WHERE "status" = 'received' AND "due_notified_at" IS NULL;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_deposited_to_fkey"
  FOREIGN KEY ("tenant_id", "deposited_to_account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_deposited_by_fkey"
  FOREIGN KEY ("tenant_id", "deposited_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_cleared_by_fkey"
  FOREIGN KEY ("tenant_id", "cleared_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_bounced_by_fkey"
  FOREIGN KEY ("tenant_id", "bounced_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_returned_by_fkey"
  FOREIGN KEY ("tenant_id", "returned_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_terms"
  CHECK ("number" ~ '^[A-Za-z0-9/-]{1,40}$'
     AND ("bank_name" IS NULL OR char_length("bank_name") BETWEEN 1 AND 100)
     AND "amount" > 0 AND "amount" <= 1000000);
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_status_known"
  CHECK ("status" IN ('received', 'deposited', 'cleared', 'bounced', 'returned'));
-- Each step says when and who, exactly when the cheque took it; a bounce
-- and a return have their reason codes.
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_state_shape"
  CHECK ((("status" IN ('deposited', 'cleared', 'bounced')) = ("deposited_on" IS NOT NULL))
     AND (("deposited_on" IS NULL) = ("deposited_to_account_id" IS NULL))
     AND (("deposited_on" IS NULL) = ("deposited_by_account_id" IS NULL))
     AND (("status" = 'cleared') = ("cleared_on" IS NOT NULL))
     AND (("cleared_on" IS NULL) = ("cleared_by_account_id" IS NULL))
     AND (("status" = 'bounced') = ("bounced_on" IS NOT NULL))
     AND (("bounced_on" IS NULL) = ("bounced_by_account_id" IS NULL))
     AND (("bounced_on" IS NULL) = ("bounce_reason" IS NULL))
     AND (("status" = 'returned') = ("returned_on" IS NOT NULL))
     AND (("returned_on" IS NULL) = ("returned_by_account_id" IS NULL))
     AND (("returned_on" IS NULL) = ("return_reason" IS NULL))
     AND ("status" = 'received' OR "status" = 'returned' OR "payment_id" IS NOT NULL));
-- REASON_CODES.chequeBounce and .chequeReturn; a unit test keeps them in step.
ALTER TABLE "finance_cheques" ADD CONSTRAINT "finance_cheques_codes"
  CHECK (("bounce_reason" IS NULL
          OR "bounce_reason" IN ('insufficient_funds', 'signature_mismatch', 'stopped', 'stale',
                                 'account_closed', 'other'))
     AND ("return_reason" IS NULL
          OR "return_reason" IN ('replaced', 'paid_otherwise', 'payer_asked', 'other')));

-- The terms are fixed; the status moves forward only (received → deposited
-- or returned; deposited → cleared or bounced) and an ended cheque never
-- changes; its payment is named once; it is told due once.
CREATE FUNCTION "finance_cheques_forward_only"() RETURNS trigger AS $$
BEGIN
  IF NEW."unit_id" <> OLD."unit_id"
     OR NEW."number" <> OLD."number"
     OR NEW."bank_name" IS DISTINCT FROM OLD."bank_name"
     OR NEW."amount" <> OLD."amount"
     OR NEW."due_on" <> OLD."due_on"
     OR NEW."received_on" <> OLD."received_on"
     OR NEW."recorded_by_account_id" <> OLD."recorded_by_account_id"
     OR NEW."created_at" <> OLD."created_at"
     OR (OLD."payment_id" IS NOT NULL AND NEW."payment_id" IS DISTINCT FROM OLD."payment_id")
     OR (OLD."due_notified_at" IS NOT NULL AND NEW."due_notified_at" IS DISTINCT FROM OLD."due_notified_at")
     OR OLD."status" IN ('cleared', 'bounced', 'returned')
     OR (OLD."status" = 'received' AND NEW."status" NOT IN ('received', 'deposited', 'returned'))
     OR (OLD."status" = 'deposited' AND NEW."status" NOT IN ('cleared', 'bounced')) THEN
    RAISE EXCEPTION 'a cheque keeps its terms and moves forward once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "finance_cheques_forward_only" BEFORE UPDATE ON "finance_cheques"
  FOR EACH ROW EXECUTE FUNCTION "finance_cheques_forward_only"();
CREATE TRIGGER "finance_cheques_no_delete"
  BEFORE DELETE ON "finance_cheques"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- A cheque's payment is a cheque payment of its unit, for its amount.
CREATE FUNCTION finance_cheques_payment_matches() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  IF NEW."payment_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT x."kind", x."method", x."unit_id", x."amount" INTO p
    FROM "finance_payments" x WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = NEW."payment_id";
  IF p."kind" IS DISTINCT FROM 'payment' OR p."method" IS DISTINCT FROM 'cheque'
     OR p."unit_id" IS DISTINCT FROM NEW."unit_id" OR p."amount" IS DISTINCT FROM NEW."amount" THEN
    RAISE EXCEPTION 'cheque %: its payment violates the register: a cheque payment of its unit, for its amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_cheques_payment_matches
  BEFORE INSERT OR UPDATE OF "payment_id" ON "finance_cheques"
  FOR EACH ROW EXECUTE FUNCTION finance_cheques_payment_matches();

-- The movements' cheque source: a cleared cheque's money in its bank.
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_cheque_fkey"
  FOREIGN KEY ("tenant_id", "cheque_id") REFERENCES "finance_cheques"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "finance_cheques" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_cheques" TO jiwar_app;
ALTER TABLE "finance_cheques" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_cheques" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_cheques"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
