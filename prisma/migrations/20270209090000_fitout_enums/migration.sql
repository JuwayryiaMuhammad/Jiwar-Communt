-- ============================================================================
-- Fit-out completion (ADR 0074): the enum values the phase's tables use,
-- alone in their migration because a new enum value cannot be used in the
-- transaction that adds it.
--
-- `permit_drawing` is a works permit's drawing, its requester's (an image or
-- a PDF); `fitout_photo` a photo the management takes of a common area
-- before and after works, or of the damage a claim is for; `damage_appeal_photo`
-- the photo a resident may join to the appeal of a claim. `damage` is the
-- invoice kind of what a damage claim leaves owing past the works deposit:
-- only the charges port issues it, as `facility`, `club` and `fine` (ADR 0070).
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'permit_drawing';
ALTER TYPE "file_purpose" ADD VALUE 'fitout_photo';
ALTER TYPE "file_purpose" ADD VALUE 'damage_appeal_photo';
ALTER TYPE "invoice_kind" ADD VALUE 'damage';
