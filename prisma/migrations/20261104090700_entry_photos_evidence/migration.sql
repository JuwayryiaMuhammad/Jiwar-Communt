-- ============================================================================
-- The visitor's photo at entry, and an incident's evidence (ADR 0056).
--
-- `gate_entry_photos`: the photo a guard took of a visitor coming in (a
-- pass's, a gate request's, a field exception's), one per `in` entry. Seen
-- by the guards on shift and the management only: never the household, a
-- notification or the audit. Deleted 30 days after the entry (`purge_after`,
-- by the gate.visitor_photos sweep: the row, then the file), unless an
-- incident keeps it.
--
-- `incident_evidence`: what an incident keeps beyond its own photos — a
-- visitor's photo at entry. Added by the reporting guard or the incidents'
-- keepers, never removed: the incident is kept, and so is its evidence. The
-- photo's row cannot be deleted while evidence names it (the key below
-- restricts it), whatever the sweep does.
-- ============================================================================

CREATE TABLE "gate_entry_photos" (
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "subject_type" "gate_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "taken_by_account_id" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "purge_after" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_entry_photos_pkey" PRIMARY KEY ("tenant_id", "entry_id")
);
CREATE UNIQUE INDEX "gate_entry_photos_file_key" ON "gate_entry_photos"("tenant_id", "file_id");
CREATE INDEX "gate_entry_photos_purge_idx" ON "gate_entry_photos"("tenant_id", "purge_after");
ALTER TABLE "gate_entry_photos"
  ADD CONSTRAINT "gate_entry_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_entry_photos_file_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_entry_photos_gate_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_entry_photos_unit_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_entry_photos_taken_by_fkey"
    FOREIGN KEY ("tenant_id", "taken_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_entry_photos"
  -- Visitors only.
  ADD CONSTRAINT "gate_entry_photos_subject"
    CHECK ("subject_type" IN ('visitor_pass', 'gate_request', 'field_exception')),
  -- 30 days after the entry, in hours: never a calendar day that a clock
  -- change makes 23 or 25 hours long.
  ADD CONSTRAINT "gate_entry_photos_purge_after"
    CHECK ("purge_after" = "entered_at" + interval '720 hours');

-- Never changed; deleted only by the purge (the app's DELETE).
CREATE TRIGGER gate_entry_photos_immutable
  BEFORE UPDATE ON "gate_entry_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_entry_photos_immutable_truncate
  BEFORE TRUNCATE ON "gate_entry_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_entry_photos" FROM jiwar_app;
-- UPDATE only for the row locks (a link FOR SHARE, the purge FOR UPDATE SKIP
-- LOCKED need it); the trigger above refuses every change.
GRANT SELECT, INSERT, UPDATE, DELETE ON "gate_entry_photos" TO jiwar_app;
ALTER TABLE "gate_entry_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_entry_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_entry_photos"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "incident_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entry_id" UUID,
    "linked_by_account_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "incident_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_evidence_tenant_id_id_key" ON "incident_evidence"("tenant_id", "id");
-- Each piece once per incident.
CREATE UNIQUE INDEX "incident_evidence_entry_key"
  ON "incident_evidence"("tenant_id", "incident_id", "entry_id") WHERE "entry_id" IS NOT NULL;
CREATE INDEX "incident_evidence_incident_idx"
  ON "incident_evidence"("tenant_id", "incident_id", "linked_at");
CREATE INDEX "incident_evidence_entry_idx"
  ON "incident_evidence"("tenant_id", "entry_id") WHERE "entry_id" IS NOT NULL;
ALTER TABLE "incident_evidence"
  ADD CONSTRAINT "incident_evidence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_evidence_incident_fkey"
    FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Kept while evidence names it: the purge cannot delete it.
  ADD CONSTRAINT "incident_evidence_entry_photo_fkey"
    FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "gate_entry_photos"("tenant_id", "entry_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_evidence_linked_by_fkey"
    FOREIGN KEY ("tenant_id", "linked_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_evidence"
  ADD CONSTRAINT "incident_evidence_kind"
    CHECK ("kind" IN ('visitor_photo')),
  ADD CONSTRAINT "incident_evidence_shape"
    CHECK (("kind" = 'visitor_photo') = ("entry_id" IS NOT NULL));

CREATE TRIGGER incident_evidence_immutable
  BEFORE UPDATE OR DELETE ON "incident_evidence"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER incident_evidence_immutable_truncate
  BEFORE TRUNCATE ON "incident_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "incident_evidence" FROM jiwar_app;
GRANT SELECT, INSERT ON "incident_evidence" TO jiwar_app;
ALTER TABLE "incident_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "incident_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "incident_evidence"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
