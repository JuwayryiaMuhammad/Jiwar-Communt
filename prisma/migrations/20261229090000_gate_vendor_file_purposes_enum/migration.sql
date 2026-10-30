-- ============================================================================
-- Guard vendor adapters (ADR 0068): the file purposes of a face probe (the
-- photo a guard checks against the blocklist's faces) and an ID scan (the
-- image a guard has read). Alone in its migration: a new enum value cannot
-- be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'gate_face_probe';
ALTER TYPE "file_purpose" ADD VALUE 'gate_id_scan';
