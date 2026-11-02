-- ============================================================================
-- The SLA's escalation levels (ADR 0076), per priority:
--
--   at risk   a running clock that has used `at_risk_percent` of its target
--             (75 % by default; 50–95, or NULL for no warning at that
--             priority): the technician holding the ticket and the dispatch
--             (`tickets.dispatch`) are told, once per clock and cycle;
--   breached  as before (ADR 0034): the dispatch and the managers
--             (`maintenance.manage`) are told when it passes its target.
--
-- `ticket_sla_alerts` is the "once": one row per ticket, SLA cycle, clock and
-- level, written with the notices under the ticket's row lock. Append-only,
-- like the SLA's events; no foreign keys, like the history tables.
-- ============================================================================

ALTER TABLE "maintenance_sla_settings"
  ADD COLUMN "at_risk_percent_normal" INTEGER DEFAULT 75,
  ADD COLUMN "at_risk_percent_urgent" INTEGER DEFAULT 75,
  ADD COLUMN "at_risk_percent_emergency" INTEGER DEFAULT 75;
ALTER TABLE "maintenance_sla_settings" ADD CONSTRAINT "maintenance_sla_settings_at_risk_range"
  CHECK (("at_risk_percent_normal" IS NULL OR "at_risk_percent_normal" BETWEEN 50 AND 95)
     AND ("at_risk_percent_urgent" IS NULL OR "at_risk_percent_urgent" BETWEEN 50 AND 95)
     AND ("at_risk_percent_emergency" IS NULL OR "at_risk_percent_emergency" BETWEEN 50 AND 95));

CREATE TABLE "ticket_sla_alerts" (
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "clock" "sla_clock" NOT NULL,
    "level" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_sla_alerts_pkey" PRIMARY KEY ("tenant_id", "ticket_id", "cycle", "clock", "level")
);
ALTER TABLE "ticket_sla_alerts" ADD CONSTRAINT "ticket_sla_alerts_level_known"
  CHECK ("level" IN ('at_risk') AND "cycle" >= 1);

CREATE TRIGGER ticket_sla_alerts_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_sla_alerts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_sla_alerts_immutable_truncate
  BEFORE TRUNCATE ON "ticket_sla_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "ticket_sla_alerts" FROM jiwar_app;
GRANT SELECT, INSERT ON "ticket_sla_alerts" TO jiwar_app;
ALTER TABLE "ticket_sla_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_sla_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_sla_alerts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
