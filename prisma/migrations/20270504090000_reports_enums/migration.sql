-- ============================================================================
-- The reports platform (ADR 0086): the file purposes the phase uses, alone
-- in their migration because a new enum value cannot be used in the
-- transaction that adds it.
--
-- `report_file`: a scheduled report's file (a PDF, a workbook or CSV), drawn
-- by the server and attached to its run. `compound_export`: the compound's
-- operational data, a zip of fixed tables, built by the server.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'report_file';
ALTER TYPE "file_purpose" ADD VALUE 'compound_export';
