-- ============================================================================
-- Phase R6b — the ledger and the reports (ADR 0048) read a compound's money
-- rows by the local day they count on: an invoice's issue day, a payment's
-- paid day, a refund's day, and otherwise when it was recorded. These are
-- the indexes those period reads need that R6a's do not give (reversals,
-- refunds' reversals and releases already have a (tenant, created_at)
-- index).
-- ============================================================================

CREATE INDEX "invoices_issued_idx" ON "invoices"("tenant_id", "issued_on");
CREATE INDEX "finance_payments_paid_idx" ON "finance_payments"("tenant_id", "paid_on")
  WHERE "kind" = 'payment';
CREATE INDEX "credit_notes_created_idx" ON "credit_notes"("tenant_id", "created_at", "id");
CREATE INDEX "finance_refunds_refunded_idx" ON "finance_refunds"("tenant_id", "refunded_on")
  WHERE "kind" = 'refund';
CREATE INDEX "finance_allocations_from_credit_idx" ON "finance_allocations"("tenant_id", "created_at")
  WHERE "from_credit";
