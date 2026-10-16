-- ============================================================================
-- Permits (ADR 0049): materials brought in, as the guard logs them. Bringing
-- materials in needs no permit; the guard writes what came, for which unit,
-- and the works permit it is for when there is one. Taking them out needs a
-- material exit approved in advance (unit_permits).
--
-- Append-only like the gate log (20261003090400_gate_entries): jiwar_app may
-- SELECT and INSERT, and triggers reject UPDATE, DELETE and TRUNCATE for
-- every role. No foreign keys, for the same reason: the service resolves
-- every id in its tenant transaction before writing. The description is the
-- guard's words: staff text, kept through any erasure.
-- ============================================================================

CREATE TABLE "material_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "permit_id" UUID,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "material_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "material_entries_occurred_idx"
  ON "material_entries"("tenant_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "material_entries_unit_idx"
  ON "material_entries"("tenant_id", "unit_id", "occurred_at" DESC);
ALTER TABLE "material_entries" ADD CONSTRAINT "material_entries_description_length"
  CHECK (char_length("description") BETWEEN 1 AND 280);

REVOKE ALL ON "material_entries" FROM jiwar_app;
GRANT SELECT, INSERT ON "material_entries" TO jiwar_app;

CREATE FUNCTION material_entries_are_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'material entries are immutable (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER material_entries_immutable_rows
  BEFORE UPDATE OR DELETE ON "material_entries"
  FOR EACH ROW EXECUTE FUNCTION material_entries_are_immutable();
CREATE TRIGGER material_entries_immutable_truncate
  BEFORE TRUNCATE ON "material_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION material_entries_are_immutable();

ALTER TABLE "material_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "material_entries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
