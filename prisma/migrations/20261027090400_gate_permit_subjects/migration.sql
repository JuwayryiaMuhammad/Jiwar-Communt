-- ============================================================================
-- Permits at the gate (ADR 0049): who a gate entry may be about — a works
-- permit's contractor worker, an event's guest, a move's truck — and how
-- the guard let them in: against the permit (`permit`): the worker's face
-- and the last four of their ID, the guest's name on the list, the truck's
-- plate. Alone in their migration: a new enum value cannot be used in the
-- transaction that adds it (the CHECK is recreated in the next one).
-- ============================================================================

ALTER TYPE "gate_subject_type" ADD VALUE 'permit_worker';
ALTER TYPE "gate_subject_type" ADD VALUE 'event_guest';
ALTER TYPE "gate_subject_type" ADD VALUE 'move_permit';
ALTER TYPE "gate_entry_method" ADD VALUE 'permit';
