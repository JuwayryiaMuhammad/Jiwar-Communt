-- ============================================================================
-- Sensitive tickets (ADR 0081). The dispatch marks a ticket sensitive (a
-- reason code, audited); from then on only a staff reader holding
-- `tickets.sensitive` sees it among the compound's tickets: the lists, the
-- search, the export, an asset's timeline and the counts leave it out for
-- everyone else, and a single read answers TICKET_NOT_FOUND. The technician
-- holding it and the residents it is theirs keep their own reach.
--
-- Every staff read of a sensitive ticket is logged: `ticket_sensitive_reads`,
-- one row per ticket and read (`via`: its page or a part of it, a list page,
-- the export, the search). Append-only, no foreign keys, like the history
-- tables; read by `tickets.sensitive` only.
-- ============================================================================

ALTER TABLE "tickets" ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "tickets_sensitive_idx"
  ON "tickets"("tenant_id", "created_at" DESC, "id" DESC) WHERE "sensitive";

CREATE TABLE "ticket_sensitive_reads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "via" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_sensitive_reads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_sensitive_reads_ticket_idx"
  ON "ticket_sensitive_reads"("tenant_id", "ticket_id", "read_at" DESC, "id" DESC);
ALTER TABLE "ticket_sensitive_reads" ADD CONSTRAINT "ticket_sensitive_reads_via_known"
  CHECK ("via" IN ('detail', 'list', 'export', 'search'));

CREATE TRIGGER ticket_sensitive_reads_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_sensitive_reads"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_sensitive_reads_immutable_truncate
  BEFORE TRUNCATE ON "ticket_sensitive_reads"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "ticket_sensitive_reads" FROM jiwar_app;
GRANT SELECT, INSERT ON "ticket_sensitive_reads" TO jiwar_app;
ALTER TABLE "ticket_sensitive_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_sensitive_reads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_sensitive_reads"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
