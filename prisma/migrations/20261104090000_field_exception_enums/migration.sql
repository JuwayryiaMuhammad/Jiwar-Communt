-- ============================================================================
-- Field exceptions (ADR 0056): a guard asks the on-duty management to let
-- in, once, someone the gate refused. A gate entry may be about the
-- exception (a visitor or a vehicle let in on it), and is then recorded by
-- `exception`; the exceptions are numbered in the safety counters' series.
-- Alone in their migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "gate_subject_type" ADD VALUE 'field_exception';
ALTER TYPE "gate_entry_method" ADD VALUE 'exception';
ALTER TYPE "safety_counter_series" ADD VALUE 'field_exception';
