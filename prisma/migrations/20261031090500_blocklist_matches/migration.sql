-- ============================================================================
-- Security (ADR 0053): where the blocklist met someone at the gate.
--
-- * `blocklist_matches`: an append-only log, like the gate's entries: which
--   entry, its kind then, where it was met (a pass or a permit being made, a
--   verify, an entry, a gate request, a plate or ID lookup), on what, at
--   which gate and shift, by whom, and what came of it (refused, flagged,
--   noted). Read by `blocklist.manage` only. The subject is a pointer (the
--   gate's subjects, no foreign key), as on the gate's entries.
-- * `security_refusals`: the one record that a pass, a guest or a move was
--   refused by security, so its household is told once, and never why.
-- ============================================================================

CREATE TABLE "blocklist_matches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "gate_id" UUID,
    "shift_id" UUID,
    "actor_account_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blocklist_matches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "blocklist_matches_tenant_id_id_key" ON "blocklist_matches"("tenant_id", "id");
CREATE INDEX "blocklist_matches_entry_idx"
  ON "blocklist_matches"("tenant_id", "entry_id", "created_at", "id");
ALTER TABLE "blocklist_matches"
  ADD CONSTRAINT "blocklist_matches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_matches_tenant_id_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "blocklist_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_matches_tenant_id_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_matches_tenant_id_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_matches_tenant_id_actor_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_kind"
  CHECK ("kind" IN ('ban', 'watch'));
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_source"
  CHECK ("source" IN ('visitor_pass', 'move_permit', 'event_guest', 'gate_request', 'verify', 'entry', 'plate_lookup', 'id_lookup'));
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_outcome"
  CHECK ("outcome" IN ('refused', 'flagged', 'noted'));
-- A subject is a type and an id together, of the gate's subjects.
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_subject"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
     AND ("subject_type" IS NULL
          OR "subject_type" IN ('visitor_pass', 'gate_request', 'event_guest', 'move_permit')));
CREATE TRIGGER blocklist_matches_immutable_rows
  BEFORE UPDATE OR DELETE ON "blocklist_matches"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER blocklist_matches_immutable_truncate
  BEFORE TRUNCATE ON "blocklist_matches"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "security_refusals" (
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "security_refusals_pkey" PRIMARY KEY ("tenant_id", "subject_type", "subject_id")
);
ALTER TABLE "security_refusals" ADD CONSTRAINT "security_refusals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "security_refusals" ADD CONSTRAINT "security_refusals_subject"
  CHECK ("subject_type" IN ('visitor_pass', 'event_guest', 'move_permit'));
CREATE TRIGGER security_refusals_immutable_rows
  BEFORE UPDATE OR DELETE ON "security_refusals"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER security_refusals_immutable_truncate
  BEFORE TRUNCATE ON "security_refusals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "blocklist_matches", "security_refusals" FROM jiwar_app;
GRANT SELECT, INSERT ON "blocklist_matches", "security_refusals" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['blocklist_matches', 'security_refusals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
