-- ============================================================================
-- Phase R1 — account deletion (ADR 0036): a request past its cooling-off
-- that something blocks goes to the managers' queue, where it is executed
-- or closed. Alone in its migration: new enum values cannot be used in the
-- transaction that adds them.
-- ============================================================================

ALTER TYPE "deletion_request_status" ADD VALUE 'queued';
ALTER TYPE "deletion_request_status" ADD VALUE 'closed';
