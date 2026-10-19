-- ============================================================================
-- Visit overstay (ADR 0056). A visit has an expected length: its pass's
-- (`visitor_passes.expected_minutes`, set by the host), otherwise the
-- compound's (`gate_settings.visit_expected_minutes`, 240 by default; null
-- turns the alert off). A visitor still inside past it alerts the guards on
-- shift at the gate they came in by, and the host, once per visit: the
-- `in` entry is the key of `visit_overstay_alerts`, so two sweeps at once
-- alert once. Nothing else happens: no exit is recorded, nobody is refused.
--
-- At most 12 hours (720 minutes): a visitor inside longer gets the system's
-- unconfirmed exit (GATE_UNCONFIRMED_EXIT_HOURS) and is no longer inside.
-- The alerts name entries, gates and units only, and are never changed.
-- ============================================================================

ALTER TABLE "visitor_passes" ADD COLUMN "expected_minutes" SMALLINT;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_expected_minutes"
  CHECK ("expected_minutes" IS NULL OR "expected_minutes" BETWEEN 15 AND 720);

ALTER TABLE "gate_settings" ADD COLUMN "visit_expected_minutes" SMALLINT DEFAULT 240;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_visit_expected"
  CHECK ("visit_expected_minutes" IS NULL OR "visit_expected_minutes" BETWEEN 15 AND 720);

CREATE TABLE "visit_overstay_alerts" (
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "subject_type" "gate_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "expected_minutes" SMALLINT NOT NULL,
    "alerted_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "visit_overstay_alerts_pkey" PRIMARY KEY ("tenant_id", "entry_id")
);
CREATE INDEX "visit_overstay_alerts_alerted_idx"
  ON "visit_overstay_alerts"("tenant_id", "alerted_at" DESC);
ALTER TABLE "visit_overstay_alerts"
  ADD CONSTRAINT "visit_overstay_alerts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visit_overstay_alerts_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visit_overstay_alerts_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "visit_overstay_alerts"
  -- Visitors only: a pass's, a gate request's, a field exception's.
  ADD CONSTRAINT "visit_overstay_alerts_subject"
    CHECK ("subject_type" IN ('visitor_pass', 'gate_request', 'field_exception')),
  ADD CONSTRAINT "visit_overstay_alerts_minutes"
    CHECK ("expected_minutes" BETWEEN 15 AND 720),
  ADD CONSTRAINT "visit_overstay_alerts_after_due"
    CHECK ("alerted_at" >= "entered_at" + make_interval(mins => "expected_minutes"));

CREATE TRIGGER visit_overstay_alerts_immutable
  BEFORE UPDATE OR DELETE ON "visit_overstay_alerts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER visit_overstay_alerts_immutable_truncate
  BEFORE TRUNCATE ON "visit_overstay_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "visit_overstay_alerts" FROM jiwar_app;
GRANT SELECT, INSERT ON "visit_overstay_alerts" TO jiwar_app;
ALTER TABLE "visit_overstay_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "visit_overstay_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "visit_overstay_alerts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
