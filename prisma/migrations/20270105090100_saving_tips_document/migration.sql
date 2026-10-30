-- ============================================================================
-- R11c-1a (ADR 0069): the compound's saving tips, a guide beside the moving
-- guide — written by the manager, versioned, in both languages, read by
-- everyone through `GET /compound-documents` and never announced.
-- ============================================================================

ALTER TABLE "compound_document_versions" DROP CONSTRAINT "compound_document_versions_kind";
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_kind"
  CHECK ("kind" IN ('bylaws', 'occupant_rights', 'conduct_guide', 'moving_guide', 'saving_tips'));
