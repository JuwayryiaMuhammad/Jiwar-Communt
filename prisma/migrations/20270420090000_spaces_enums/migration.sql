-- ============================================================================
-- Spaces (ADR 0084): the file purposes the phase's tables use, alone in their
-- migration because a new enum value cannot be used in the transaction that
-- adds it.
--
-- `site_map` is the compound's one site map image, `floor_plan` a building
-- floor's plan: images of 10 MB at most like any image purpose, so neither
-- files CHECK names them (files_content_type_for_purpose,
-- files_size_for_purpose). Uploaded by `spaces.manage` only.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'site_map';
ALTER TYPE "file_purpose" ADD VALUE 'floor_plan';
