-- ============================================================================
-- Phase 4.3 — the resident_photo purpose (ADR 0031): images only (the
-- content-type CHECK already allows a PDF for documents alone) and, like a
-- worker's photo, 5 MB. The old CHECK ended in ELSE 10 MB, which would have
-- given the new purpose the document limit.
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           ELSE 10485760 END);
