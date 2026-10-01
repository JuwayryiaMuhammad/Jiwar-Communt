-- ============================================================================
-- Phase 4 — the gate log (ADR 0028). Append-only like the audit tables
-- (ADR 0014): jiwar_app may SELECT and INSERT, and triggers reject UPDATE,
-- DELETE and TRUNCATE for every role, the owner included. A correction is a
-- new entry, never an edit.
--
-- No foreign keys, for the same reason as the audit tables: an immutable row
-- must survive whatever happens to what it names, and a foreign key would
-- make the tables it points at impossible to truncate in the test setup.
-- The service resolves every id in its own tenant transaction before
-- writing; RLS keeps every row in its compound. `visitor_details_id` is a
-- pointer to data that is deleted when it expires.
-- ============================================================================

CREATE TYPE "gate_subject_type" AS ENUM ('visitor_pass', 'worker_engagement', 'gate_request');
CREATE TYPE "gate_direction" AS ENUM ('in', 'out');
-- code: an `in` after a verified code; approval: an `in` the household
-- approved; guard: an `out` the guard recorded; system: an unconfirmed `out`.
CREATE TYPE "gate_entry_method" AS ENUM ('code', 'approval', 'guard', 'system');

CREATE TABLE "gate_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID,
    "guard_account_id" UUID,
    "subject_type" "gate_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "direction" "gate_direction" NOT NULL,
    "method" "gate_entry_method" NOT NULL,
    "approval_request_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "visitor_details_id" UUID,
    CONSTRAINT "gate_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gate_entries_tenant_id_subject_idx"
  ON "gate_entries"("tenant_id", "subject_type", "subject_id", "occurred_at" DESC);
CREATE INDEX "gate_entries_tenant_id_occurred_at_idx"
  ON "gate_entries"("tenant_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "gate_entries_tenant_id_unit_id_idx"
  ON "gate_entries"("tenant_id", "unit_id", "occurred_at" DESC);
-- A guard records inside a shift; only the system records without one.
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_system_has_no_guard"
  CHECK (("method" = 'system') = ("guard_account_id" IS NULL)
     AND ("guard_account_id" IS NULL) = ("shift_id" IS NULL));
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_unconfirmed_is_system_out"
  CHECK (NOT "unconfirmed" OR ("method" = 'system' AND "direction" = 'out'));
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_method_matches_direction"
  CHECK (("direction" = 'in') = ("method" IN ('code', 'approval')));

REVOKE ALL ON "gate_entries" FROM jiwar_app;
GRANT SELECT, INSERT ON "gate_entries" TO jiwar_app;

CREATE FUNCTION gate_entries_are_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gate entries are immutable (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_entries_immutable_rows
  BEFORE UPDATE OR DELETE ON "gate_entries"
  FOR EACH ROW EXECUTE FUNCTION gate_entries_are_immutable();
CREATE TRIGGER gate_entries_immutable_truncate
  BEFORE TRUNCATE ON "gate_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION gate_entries_are_immutable();

ALTER TABLE "gate_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_entries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
