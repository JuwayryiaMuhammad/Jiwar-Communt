-- ============================================================================
-- The compound's logo (ADR 0075), on the board's documents: a file purpose
-- of its own (an image, the default size; the logo is set only as a PNG or
-- a JPEG, which a PDF can draw). In a migration of its own: a new enum
-- value is not usable in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'compound_logo';
