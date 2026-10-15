-- ============================================================================
-- Emergencies and gate services (ADR 0047): the notification category
-- `safety`, and the file purpose of a suspicious-activity report's photo
-- (the resident's). Alone in their migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'safety';
ALTER TYPE "file_purpose" ADD VALUE 'gate_service_photo';
