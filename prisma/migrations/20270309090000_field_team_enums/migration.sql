-- ============================================================================
-- The field team (ADR 0078): the enum values the phase's tables use, alone
-- in their migration because a new enum value cannot be used in the
-- transaction that adds it.
--
-- `staff_crew` says whose roster a template or a slot is: the guards'
-- (`security`, ADR 0050) or the technicians' (`maintenance`). One roster,
-- one engine, two crews.
--
-- `technicians` is an instruction's audience reaching every field
-- technician; `on_duty` records a technician reached when they became
-- available while it was live, as `shift_start` does for a guard.
--
-- A technician's help request asks for more hands, someone who knows the
-- fault, parts, or a second person for safety, and moves forward only.
-- ============================================================================

CREATE TYPE "staff_crew" AS ENUM ('security', 'maintenance');

ALTER TYPE "guard_instruction_audience" ADD VALUE 'technicians';
ALTER TYPE "guard_instruction_via" ADD VALUE 'on_duty';

CREATE TYPE "technician_help_kind" AS ENUM ('extra_hands', 'expertise', 'parts', 'safety');
CREATE TYPE "technician_help_status" AS ENUM ('open', 'taken', 'resolved', 'cancelled');
