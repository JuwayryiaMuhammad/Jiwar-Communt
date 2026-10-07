-- ============================================================================
-- Resident escalation (ADR 0038): a resident asks for attention on a ticket
-- whose SLA commitment is overdue and still unmet. Once per SLA cycle (the
-- SLA's own cycle, ADR 0034): the unique index is the backstop for two at
-- once; the service decides under the ticket's lock.
--
-- Append-only like the other ticket histories: SELECT and INSERT for the
-- app, the immutability triggers for every role, no foreign keys (an erased
-- account stays a pointer to its tombstone).
-- ============================================================================

CREATE TABLE "ticket_escalations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "sla_cycle" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_escalations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_escalations_once_per_cycle"
  ON "ticket_escalations"("tenant_id", "ticket_id", "sla_cycle");
ALTER TABLE "ticket_escalations" ADD CONSTRAINT "ticket_escalations_cycle_positive"
  CHECK ("sla_cycle" >= 1);

CREATE TRIGGER ticket_escalations_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_escalations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_escalations_immutable_truncate
  BEFORE TRUNCATE ON "ticket_escalations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "ticket_escalations" FROM jiwar_app;
GRANT SELECT, INSERT ON "ticket_escalations" TO jiwar_app;

ALTER TABLE "ticket_escalations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_escalations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_escalations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
