-- ============================================================================
-- A quote on a ticket (ADR 0058): the dispatch states what the work will
-- cost before it starts; the reporter or the unit's primary approves or
-- declines it. While a quote waits, or the last one was declined, the work
-- does not start (checked under the ticket's lock, which every quote write
-- takes first). The terms never change; a quote is decided or withdrawn
-- once.
-- ============================================================================

CREATE TABLE "ticket_quotes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "amount" DECIMAL(12, 2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposed_by_account_id" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "withdrawn_by_account_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    CONSTRAINT "ticket_quotes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_quotes_tenant_id_id_key" ON "ticket_quotes"("tenant_id", "id");
-- One quote waits at a time.
CREATE UNIQUE INDEX "ticket_quotes_one_proposed"
  ON "ticket_quotes"("tenant_id", "ticket_id") WHERE "status" = 'proposed';
CREATE INDEX "ticket_quotes_ticket_idx"
  ON "ticket_quotes"("tenant_id", "ticket_id", "proposed_at", "id");
ALTER TABLE "ticket_quotes"
  ADD CONSTRAINT "ticket_quotes_ticket_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_quotes_proposed_by_fkey"
    FOREIGN KEY ("tenant_id", "proposed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_quotes_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_quotes_withdrawn_by_fkey"
    FOREIGN KEY ("tenant_id", "withdrawn_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_quotes"
  ADD CONSTRAINT "ticket_quotes_amount_range"
    CHECK ("amount" > 0 AND "amount" < 10000000),
  ADD CONSTRAINT "ticket_quotes_note_length"
    CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "ticket_quotes_status_known"
    CHECK ("status" IN ('proposed', 'approved', 'declined', 'withdrawn')),
  ADD CONSTRAINT "ticket_quotes_decline_reason_known"
    CHECK ("decline_reason" IS NULL
        OR "decline_reason" IN ('too_expensive', 'not_needed', 'own_arrangement', 'other')),
  -- Each status has exactly its own fields.
  ADD CONSTRAINT "ticket_quotes_state_shape"
    CHECK (CASE "status"
      WHEN 'proposed' THEN "decided_at" IS NULL AND "decided_by_account_id" IS NULL
        AND "decline_reason" IS NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
      WHEN 'approved' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "decline_reason" IS NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
      WHEN 'declined' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "decline_reason" IS NOT NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
      WHEN 'withdrawn' THEN "decided_at" IS NULL AND "decided_by_account_id" IS NULL
        AND "decline_reason" IS NULL AND "withdrawn_at" IS NOT NULL AND "withdrawn_by_account_id" IS NOT NULL
      ELSE false END);

-- The terms are fixed; a proposed quote is decided or withdrawn once, and
-- nothing is ever deleted.
CREATE OR REPLACE FUNCTION ticket_quote_moves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."proposed_by_account_id" = OLD."proposed_by_account_id"
     AND NEW."proposed_at" = OLD."proposed_at"
     AND OLD."status" = 'proposed'
     AND NEW."status" <> 'proposed' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ticket_quotes: a quote keeps its terms and is decided or withdrawn once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER ticket_quotes_moves_once
  BEFORE UPDATE OR DELETE ON "ticket_quotes"
  FOR EACH ROW EXECUTE FUNCTION ticket_quote_moves_once();
CREATE TRIGGER ticket_quotes_no_truncate
  BEFORE TRUNCATE ON "ticket_quotes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_quote_moves_once();

REVOKE ALL ON "ticket_quotes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_quotes" TO jiwar_app;
ALTER TABLE "ticket_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_quotes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
