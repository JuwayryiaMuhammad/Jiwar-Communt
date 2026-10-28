-- ============================================================================
-- A works completion inspection's photos (ADR 0063): an image, 10 MB at
-- most, like any image purpose (files_content_type_for_purpose takes an
-- image for every purpose it does not exclude; files_size_for_purpose's
-- default is 10 MB), so neither CHECK changes. Alone in its migration.
-- ============================================================================
ALTER TYPE "file_purpose" ADD VALUE 'works_inspection_photo';
