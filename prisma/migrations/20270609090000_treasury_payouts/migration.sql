-- ============================================================================
-- Payouts move through the treasury (ADR 0085, 0089): a vendor's payout
-- names the bank or cash account it was paid from, and writes its movement
-- there, once.
--
-- - `finance_vendor_payouts.cash_account_id`: set exactly when something is
--   paid (net above zero); a payout set off whole moves no money. No payout
--   exists yet anywhere: both tables are new in this release.
-- - A `payout` movement: the payout's net, out (negative), on the payout's
--   account and day; one per payout. Checked at commit against its payout.
-- - A payout may be larger than the treasury's own movements: the amount
--   range lets a payout go to a vendor invoice's limit.
-- - Dated after ADR 0089's and ADR 0088's migrations, which recreate the
--   counters' and the inbox's CHECKs: both are recreated here with every
--   value (the custody hand-in's counter, the inbox's custody types), so a
--   fresh database and an existing one both end with all of them.
-- No row changes.
-- ============================================================================

ALTER TABLE "finance_vendor_payouts" ADD COLUMN "cash_account_id" UUID;
ALTER TABLE "finance_vendor_payouts" ADD CONSTRAINT "finance_vendor_payouts_cash_account_fkey"
  FOREIGN KEY ("tenant_id", "cash_account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_vendor_payouts" ADD CONSTRAINT "finance_vendor_payouts_cash_account"
  CHECK (("net" > 0) = ("cash_account_id" IS NOT NULL));

ALTER TABLE "finance_cash_movements" ADD COLUMN "payout_id" UUID;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_payout_fkey"
  FOREIGN KEY ("tenant_id", "payout_id") REFERENCES "finance_vendor_payouts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "finance_cash_movements_one_per_payout"
  ON "finance_cash_movements"("tenant_id", "payout_id") WHERE "payout_id" IS NOT NULL;

ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_kind_known";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_known"
  CHECK ("kind" IN ('opening', 'handin', 'recovery', 'transfer', 'cheque',
                    'statement_payment', 'adjustment', 'reversal', 'payout'));
ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_amount_range";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_amount_range"
  CHECK ("amount" <> 0
     AND (abs("amount") <= 10000000 OR ("kind" = 'payout' AND abs("amount") <= 999999999.99)));
-- What each kind names, and only that; a payout only takes money out.
ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_kind_shape";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_shape"
  CHECK ((("kind" IN ('handin', 'recovery')) = ("handin_id" IS NOT NULL))
     AND (("kind" = 'transfer') = ("transfer_id" IS NOT NULL))
     AND (("kind" = 'cheque') = ("cheque_id" IS NOT NULL))
     AND (("kind" = 'statement_payment') <= ("match_id" IS NOT NULL))
     AND (("kind" IN ('statement_payment', 'adjustment', 'reversal')) >= ("match_id" IS NOT NULL))
     AND (("kind" = 'reversal') = ("reverses_id" IS NOT NULL))
     AND (("kind" = 'adjustment') = ("reason_code" IS NOT NULL))
     AND (("kind" = 'payout') = ("payout_id" IS NOT NULL))
     AND ("kind" IN ('transfer', 'adjustment', 'reversal', 'payout') OR "amount" > 0)
     AND ("kind" <> 'payout' OR "amount" < 0));

-- ADR 0085's commit check, recreated whole: a payout's movement is its
-- payout's net, out, on its account and day.
CREATE OR REPLACE FUNCTION finance_cash_movements_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  legs int;
  total numeric;
  target record;
  paid record;
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
  ELSIF NEW."kind" = 'payout' THEN
    SELECT p."cash_account_id", p."net", p."paid_on" INTO paid
      FROM "finance_vendor_payouts" p
     WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."payout_id";
    IF NOT FOUND OR paid."cash_account_id" IS DISTINCT FROM NEW."account_id"
       OR paid."net" <> -NEW."amount"
       OR paid."paid_on" <> NEW."on_day" THEN
      RAISE EXCEPTION 'movement % violates its payout: its net, out, on its account and day', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- A payout that paid something has its movement, checked at commit.
CREATE FUNCTION finance_vendor_payouts_moved() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."net" > 0 AND NOT EXISTS (
       SELECT 1 FROM "finance_cash_movements" m
        WHERE m."tenant_id" = NEW."tenant_id" AND m."payout_id" = NEW."id") THEN
    RAISE EXCEPTION 'payout % violates its account''s register: paid with no movement', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_vendor_payouts_moved
  AFTER INSERT ON "finance_vendor_payouts" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_payouts_moved();

-- ----------------------------------------------------------------------------
-- The CHECKs later-dated migrations recreated after ADR 0085's, with every
-- value.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit', 'vendor_invoice', 'disbursement', 'payout', 'handin'));
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance'));
