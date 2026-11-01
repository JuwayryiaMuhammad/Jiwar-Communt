-- ============================================================================
-- Vendors (ADR 0077): a vendor's document is a file purpose of its own. The
-- enum value is alone in its migration (a new value can't be used in the
-- transaction that adds it); the next migration recreates the files CHECKs.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'vendor_document';
