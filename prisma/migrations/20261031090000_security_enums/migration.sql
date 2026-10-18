-- ============================================================================
-- Security (ADR 0053): the enum values alone. A new enum value cannot be
-- used in the transaction that adds it.
--
-- File purposes:
--   `incident_photo`          a guard's or the management's photo of an incident;
--   `blocklist_photo`         the face of a banned or watched person;
--   `violation_photo`         a violation's photo, the guard's or the office's;
--   `violation_appeal_photo`  a resident's photo backing an appeal.
--
-- Safety numbers: incidents (I-) and violations (V-) count in the compound's
-- safety counters, beside emergencies and gate services (ADR 0047).
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'incident_photo';
ALTER TYPE "file_purpose" ADD VALUE 'blocklist_photo';
ALTER TYPE "file_purpose" ADD VALUE 'violation_photo';
ALTER TYPE "file_purpose" ADD VALUE 'violation_appeal_photo';

ALTER TYPE "safety_counter_series" ADD VALUE 'incident';
ALTER TYPE "safety_counter_series" ADD VALUE 'violation';
