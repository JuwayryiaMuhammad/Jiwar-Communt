-- ============================================================================
-- Phase R1 — personal-data export (ADR 0036): the archive is a file of its
-- own purpose. Alone in its migration: a new enum value cannot be used in
-- the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'data_export';
