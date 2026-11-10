-- ============================================================================
-- The CHECKs ADR 0093 widened, stated last with every value before them, so
-- a fresh database and an existing one both end with all of them: the
-- ledger's sources with a VAT declaration's, a tax payment's and a fiscal
-- year's close and reopening; the finance counters with a withholding
-- certificate's (`withholding_certificate`, WHT-) and a tax payment's
-- (`tax_payment`, TXP-). No row changes.
-- ============================================================================

ALTER TABLE "gl_entries" DROP CONSTRAINT "gl_entries_source_known";
ALTER TABLE "gl_entries" ADD CONSTRAINT "gl_entries_source_known"
  CHECK ("source" IN ('invoice', 'credit_note', 'payment', 'payment_reversal', 'allocation',
                      'allocation_release', 'refund', 'refund_reversal', 'deposit', 'deposit_event',
                      'expense', 'expense_void', 'vendor_invoice', 'vendor_invoice_cancel',
                      'vendor_payout', 'cash_movement', 'custody_handin', 'club_payment',
                      'vehicle_fine_payment', 'violation_payment', 'manual',
                      'vat_declaration', 'tax_payment', 'year_close', 'year_reopen'));

ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit', 'vendor_invoice', 'disbursement', 'payout', 'handin',
                    'journal_entry', 'withholding_certificate', 'tax_payment'));
