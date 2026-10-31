-- ============================================================================
-- Charges (ADR 0070): what a facility booking, a club membership request and
-- a vehicle fine cost reaches the unit as an invoice of its own kind, raised
-- by the domain through the core charges port and owed, paid and credited as
-- any invoice is. Alone in its migration: a new enum value cannot be used in
-- the transaction that adds it. Only the port issues these kinds; the staff's
-- issue and the billing plans keep theirs (a CHECK in 20270112090600).
-- ============================================================================

ALTER TYPE "invoice_kind" ADD VALUE 'facility';
ALTER TYPE "invoice_kind" ADD VALUE 'club';
ALTER TYPE "invoice_kind" ADD VALUE 'fine';
