-- ============================================================================
-- The contractor portal and tenders (ADR 0088): a vendor's contractor is an
-- account kind of its own; a tender's documents and a bid's offer are file
-- purposes of their own; a ticket a vendor's contractor took is an
-- assignment of its own type. Enum values alone in their migration (a new
-- value can't be used in the transaction that adds it); the next migrations
-- use them.
-- ============================================================================

ALTER TYPE "account_type" ADD VALUE 'contractor';
ALTER TYPE "file_purpose" ADD VALUE 'tender_document';
ALTER TYPE "file_purpose" ADD VALUE 'tender_bid';
ALTER TYPE "ticket_assignment_type" ADD VALUE 'vendor';
