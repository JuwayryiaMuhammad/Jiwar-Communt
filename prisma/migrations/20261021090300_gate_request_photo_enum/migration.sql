-- ============================================================================
-- Gate card, visitors (ADR 0043): the file purpose of the photo a guard
-- takes of a visitor waiting at the gate. Alone in its migration: a new enum
-- value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'gate_request_photo';
