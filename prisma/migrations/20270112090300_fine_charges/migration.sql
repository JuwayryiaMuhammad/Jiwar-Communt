-- ============================================================================
-- Vehicle fines through finance (ADR 0070): a fine issued from now on is
-- owed through a `fine` invoice the charges port raises, payable online as
-- any invoice. The office still takes it on the fine's own route: its cash
-- is a payment of that invoice in finance, and the fine's payment record
-- points at it; reversing the record reverses it. Older fines stay paid at
-- the office only. Points at most one finance payment each, once.
-- ============================================================================

ALTER TABLE "vehicle_fine_payments" ADD COLUMN "finance_payment_id" UUID;
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_finance_payment_fkey"
  FOREIGN KEY ("tenant_id", "finance_payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "vehicle_fine_payments_finance_payment_key"
  ON "vehicle_fine_payments"("tenant_id", "finance_payment_id");
ALTER TABLE "vehicle_fine_payments" ADD CONSTRAINT "vehicle_fine_payments_finance_payment"
  CHECK ("finance_payment_id" IS NULL OR "kind" = 'payment');
