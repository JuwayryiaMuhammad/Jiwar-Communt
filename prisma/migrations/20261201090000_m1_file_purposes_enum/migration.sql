-- ============================================================================
-- Assets and inspections (ADR 0064): the file purposes of an asset's
-- documents, a checklist answer's photos and an imported sheet. Alone in
-- its migration: a new enum value cannot be used in the transaction that
-- adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'asset_document';
ALTER TYPE "file_purpose" ADD VALUE 'checklist_photo';
ALTER TYPE "file_purpose" ADD VALUE 'data_import';
