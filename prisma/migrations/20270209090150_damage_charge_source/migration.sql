-- ============================================================================
-- Fit-out completion (ADR 0074): a damage claim owes what its works deposit
-- does not cover through the charges port (ADR 0070), as an invoice of its
-- own kind, `damage`. The source CHECK is recreated with the new pair
-- (CHARGE_SOURCES and CHARGE_KINDS in src/core/charges/charges.ts); no row
-- changes. A damage charge is never cancelled by the system: its cancel
-- reasons stay as they are.
-- ============================================================================

ALTER TABLE "finance_charges" DROP CONSTRAINT "finance_charges_source_kind";
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_source_kind"
  CHECK (("source" = 'booking' AND "kind" = 'facility')
      OR ("source" = 'club_request' AND "kind" = 'club')
      OR ("source" = 'vehicle_fine' AND "kind" = 'fine')
      OR ("source" = 'damage_claim' AND "kind" = 'damage'));
