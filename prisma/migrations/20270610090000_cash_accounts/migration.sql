-- ============================================================================
-- Treasury (ADR 0085): the compound's bank and cash accounts, as registers.
-- Not a ledger: an account's balance is the sum of its movements, each an
-- append-only row that says where the money came from (an opening balance,
-- a custody hand-in, a shortage recovered, a transfer between two accounts,
-- a cheque cleared, a bank transfer a statement line showed, an adjustment
-- by hand, or the reversal of one of the last two when a match is undone).
-- Nothing personal here: names are the compound's own, and a bank account
-- shows only its last four digits.
-- ============================================================================

CREATE TABLE "finance_cash_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bank_name" TEXT,
    "number_last4" TEXT,
    "opened_on" DATE NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    CONSTRAINT "finance_cash_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_cash_accounts_tenant_id_id_key" ON "finance_cash_accounts"("tenant_id", "id");
-- Two live accounts never share a name.
CREATE UNIQUE INDEX "finance_cash_accounts_live_name_key"
  ON "finance_cash_accounts"("tenant_id", lower("name")) WHERE "retired_at" IS NULL;
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_retired_by_fkey"
  FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_kind_known"
  CHECK ("kind" IN ('bank', 'cash'));
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_name_length"
  CHECK (char_length("name") BETWEEN 1 AND 100);
-- A bank account may say its bank and its last four digits; a cash box
-- neither.
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_bank_shape"
  CHECK (("bank_name" IS NULL OR ("kind" = 'bank' AND char_length("bank_name") BETWEEN 1 AND 100))
     AND ("number_last4" IS NULL OR ("kind" = 'bank' AND "number_last4" ~ '^[0-9]{4}$')));
ALTER TABLE "finance_cash_accounts" ADD CONSTRAINT "finance_cash_accounts_retired_shape"
  CHECK (("retired_at" IS NULL) = ("retired_by_account_id" IS NULL));

-- The kind, the day it opened and who opened it are fixed; retired once,
-- and a retired account never changes.
CREATE FUNCTION "finance_cash_accounts_fixed"() RETURNS trigger AS $$
BEGIN
  IF OLD."retired_at" IS NOT NULL
     OR NEW."kind" <> OLD."kind"
     OR NEW."opened_on" <> OLD."opened_on"
     OR NEW."created_by_account_id" <> OLD."created_by_account_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'a cash account keeps its kind and opening, and is retired once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "finance_cash_accounts_fixed" BEFORE UPDATE ON "finance_cash_accounts"
  FOR EACH ROW EXECUTE FUNCTION "finance_cash_accounts_fixed"();
CREATE TRIGGER "finance_cash_accounts_no_delete"
  BEFORE DELETE ON "finance_cash_accounts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Movements. Append-only. The source columns of the other tables
-- (hand-ins, cheques, statement matches) get their foreign keys in the
-- migrations that create those tables.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_cash_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "on_day" DATE NOT NULL,
    "handin_id" UUID,
    "transfer_id" UUID,
    "cheque_id" UUID,
    "match_id" UUID,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_cash_movements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_cash_movements_tenant_id_id_key" ON "finance_cash_movements"("tenant_id", "id");
CREATE INDEX "finance_cash_movements_account_idx"
  ON "finance_cash_movements"("tenant_id", "account_id", "on_day" DESC, "created_at" DESC, "id" DESC);
-- Each source moves money once.
CREATE UNIQUE INDEX "finance_cash_movements_one_per_handin"
  ON "finance_cash_movements"("tenant_id", "handin_id") WHERE "kind" = 'handin';
CREATE UNIQUE INDEX "finance_cash_movements_one_recovery"
  ON "finance_cash_movements"("tenant_id", "handin_id") WHERE "kind" = 'recovery';
CREATE UNIQUE INDEX "finance_cash_movements_one_per_cheque"
  ON "finance_cash_movements"("tenant_id", "cheque_id") WHERE "cheque_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_cash_movements_one_per_match"
  ON "finance_cash_movements"("tenant_id", "match_id") WHERE "match_id" IS NOT NULL AND "kind" <> 'reversal';
CREATE UNIQUE INDEX "finance_cash_movements_one_reversal"
  ON "finance_cash_movements"("tenant_id", "reverses_id") WHERE "reverses_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_cash_movements_transfer_leg"
  ON "finance_cash_movements"("tenant_id", "transfer_id", "account_id") WHERE "transfer_id" IS NOT NULL;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_reverses_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "finance_cash_movements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_known"
  CHECK ("kind" IN ('opening', 'handin', 'recovery', 'transfer', 'cheque',
                    'statement_payment', 'adjustment', 'reversal'));
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_amount_range"
  CHECK ("amount" <> 0 AND abs("amount") <= 10000000);
-- What each kind names, and only that. Money only comes in from an
-- opening, a hand-in, a recovery, a cheque and a bank transfer; a transfer,
-- an adjustment and a reversal go either way.
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_shape"
  CHECK ((("kind" IN ('handin', 'recovery')) = ("handin_id" IS NOT NULL))
     AND (("kind" = 'transfer') = ("transfer_id" IS NOT NULL))
     AND (("kind" = 'cheque') = ("cheque_id" IS NOT NULL))
     AND (("kind" = 'statement_payment') <= ("match_id" IS NOT NULL))
     AND (("kind" IN ('statement_payment', 'adjustment', 'reversal')) >= ("match_id" IS NOT NULL))
     AND (("kind" = 'reversal') = ("reverses_id" IS NOT NULL))
     AND (("kind" = 'adjustment') = ("reason_code" IS NOT NULL))
     AND ("kind" IN ('transfer', 'adjustment', 'reversal') OR "amount" > 0));
-- REASON_CODES.cashAdjust; a unit test keeps the two in step.
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('bank_charge', 'interest', 'refund_paid', 'counting_correction', 'other'));
CREATE TRIGGER finance_cash_movements_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_cash_movements"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_cash_movements_immutable_truncate
  BEFORE TRUNCATE ON "finance_cash_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A transfer is two legs, on two accounts, adding up to zero; a reversal
-- undoes its movement exactly, on the same account. Checked at commit.
CREATE FUNCTION finance_cash_movements_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  legs int;
  total numeric;
  target record;
BEGIN
  IF NEW."kind" = 'transfer' THEN
    SELECT count(*), SUM(m."amount") INTO legs, total
      FROM "finance_cash_movements" m
     WHERE m."tenant_id" = NEW."tenant_id" AND m."transfer_id" = NEW."transfer_id";
    IF legs <> 2 OR total <> 0 THEN
      RAISE EXCEPTION 'transfer %: two legs adding up to zero', NEW."transfer_id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'reversal' THEN
    SELECT m."account_id", m."amount", m."kind" INTO target
      FROM "finance_cash_movements" m
     WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."reverses_id";
    IF target."kind" NOT IN ('statement_payment', 'adjustment')
       OR target."account_id" <> NEW."account_id"
       OR target."amount" <> -NEW."amount" THEN
      RAISE EXCEPTION 'movement %: a reversal undoes a matched movement exactly', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_cash_movements_balanced
  AFTER INSERT ON "finance_cash_movements" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_cash_movements_balanced();

REVOKE ALL ON "finance_cash_accounts", "finance_cash_movements" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_cash_accounts" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_cash_movements" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_cash_accounts', 'finance_cash_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
