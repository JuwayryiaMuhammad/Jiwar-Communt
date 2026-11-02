-- ============================================================================
-- Transfers, dues and closed units, and the market's completion (ADR 0083):
-- the enum values its later migrations use, alone in their migration.
--
-- - `file_purpose.unit_entry_photo`: an emergency entry's photo, an image of
--   10 MB at most, like any image purpose (files_content_type_for_purpose
--   takes an image for every purpose it does not exclude;
--   files_size_for_purpose's default is 10 MB), so neither CHECK changes.
-- - `group_offer_status.reconfirming` and `.contracted`: a confirmed offer's
--   contract, held while the participants it costs more re-confirm.
-- ============================================================================
ALTER TYPE "file_purpose" ADD VALUE 'unit_entry_photo';
ALTER TYPE "group_offer_status" ADD VALUE 'reconfirming';
ALTER TYPE "group_offer_status" ADD VALUE 'contracted';
