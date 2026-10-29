-- ============================================================================
-- A ticket's costs, its completion and the technician's quotes (ADR 0065).
--
-- ticket_cost_entries        what a job cost: labour, a contractor, other
--                            costs dispatch records, and the parts the store
--                            issued (and took back) for it. An entry is
--                            voided once, never edited; a part's entry is
--                            the store's, undone by a return, never voided.
-- ticket_completions         what the technician did, each time they
--                            completed the job: a code from a closed list
--                            and a note for the staff. Never changes.
-- ticket_quote_suggestions   a price the technician found on site, for
--                            dispatch to send as the ticket's quote (ADR
--                            0058) or to dismiss, once.
--
-- Money is EGP with two decimals; quantities have three. An entry's amount
-- is its quantity times its unit amount, rounded to the piastre.
-- ============================================================================

CREATE TABLE "ticket_cost_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_amount" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entered_by_account_id" UUID,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_account_id" UUID,
    "void_reason" TEXT,
    CONSTRAINT "ticket_cost_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_cost_entries_tenant_id_id_key" ON "ticket_cost_entries"("tenant_id", "id");
CREATE INDEX "ticket_cost_entries_ticket_idx" ON "ticket_cost_entries"("tenant_id", "ticket_id", "entered_at", "id");
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_entered_by_fkey"
  FOREIGN KEY ("tenant_id", "entered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_voided_by_fkey"
  FOREIGN KEY ("tenant_id", "voided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_kind_known"
  CHECK ("kind" IN ('labour', 'contractor', 'part', 'other'));
-- What dispatch records says what it was; a part's entry names its item
-- (the store's migration adds the item and the movement, and the CHECK
-- that a part entry has them).
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_description_shape"
  CHECK (("kind" = 'part' AND "description" IS NULL)
      OR ("kind" <> 'part' AND "description" IS NOT NULL
          AND char_length("description") BETWEEN 1 AND 200));
-- Recorded costs count up; a part's entry is negative when it was returned.
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_amounts"
  CHECK ("unit_amount" >= 0
     AND "quantity" <> 0
     AND ("kind" = 'part' OR "quantity" > 0)
     AND "amount" = round("quantity" * "unit_amount", 2));
-- Voided once, with who and why (REASON_CODES.ticketCostVoid); a part's
-- entry never.
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_void_shape"
  CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL)
     AND ("void_reason" IS NULL OR ("kind" <> 'part'
          AND "void_reason" IN ('entered_in_error', 'duplicate', 'other')))
     AND ("voided_at" IS NULL OR "voided_at" >= "entered_at"));

-- Only the void is ever written, once.
CREATE FUNCTION "ticket_cost_entries_void_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a cost entry is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voided_at" IS NULL AND NEW."voided_at" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id" AND NEW."kind" = OLD."kind"
     AND NEW."description" IS NOT DISTINCT FROM OLD."description"
     AND NEW."quantity" = OLD."quantity" AND NEW."unit_amount" = OLD."unit_amount"
     AND NEW."amount" = OLD."amount"
     AND NEW."entered_by_account_id" IS NOT DISTINCT FROM OLD."entered_by_account_id"
     AND NEW."entered_at" = OLD."entered_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a cost entry is voided once and never edited' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "ticket_cost_entries_void_once" BEFORE UPDATE OR DELETE ON "ticket_cost_entries"
  FOR EACH ROW EXECUTE FUNCTION "ticket_cost_entries_void_once"();
CREATE TRIGGER "ticket_cost_entries_immutable_truncate" BEFORE TRUNCATE ON "ticket_cost_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "ticket_completions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "action_code" TEXT NOT NULL,
    "note" TEXT,
    "technician_account_id" UUID,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_completions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_completions_tenant_id_id_key" ON "ticket_completions"("tenant_id", "id");
CREATE INDEX "ticket_completions_ticket_idx" ON "ticket_completions"("tenant_id", "ticket_id", "completed_at" DESC, "id" DESC);
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_technician_fkey"
  FOREIGN KEY ("tenant_id", "technician_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.ticketCompletionAction.
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_action_known"
  CHECK ("action_code" IN ('repaired', 'part_replaced', 'adjusted', 'cleaned',
                           'no_fault_found', 'referred_to_vendor', 'other'));
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000);
ALTER TABLE "ticket_completions" ADD CONSTRAINT "ticket_completions_cycle_positive"
  CHECK ("cycle" >= 1);
CREATE TRIGGER "ticket_completions_immutable_rows" BEFORE UPDATE OR DELETE ON "ticket_completions"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "ticket_completions_immutable_truncate" BEFORE TRUNCATE ON "ticket_completions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "ticket_quote_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "suggested_by_account_id" UUID,
    "suggested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "dismiss_reason" TEXT,
    "quote_id" UUID,
    CONSTRAINT "ticket_quote_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_quote_suggestions_tenant_id_id_key" ON "ticket_quote_suggestions"("tenant_id", "id");
CREATE INDEX "ticket_quote_suggestions_ticket_idx" ON "ticket_quote_suggestions"("tenant_id", "ticket_id", "suggested_at" DESC, "id" DESC);
-- One waits per ticket; a quote is sent from one suggestion at most.
CREATE UNIQUE INDEX "ticket_quote_suggestions_one_pending" ON "ticket_quote_suggestions"("ticket_id")
  WHERE "status" = 'pending';
CREATE UNIQUE INDEX "ticket_quote_suggestions_quote_key" ON "ticket_quote_suggestions"("quote_id")
  WHERE "quote_id" IS NOT NULL;
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_quote_fkey"
  FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "ticket_quotes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_suggested_by_fkey"
  FOREIGN KEY ("tenant_id", "suggested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Like a quote (ADR 0058): positive, below ten million.
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_amount_range"
  CHECK ("amount" > 0 AND "amount" < 10000000);
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
-- Pending: undecided. Sent: as the quote it names. Dismissed: with a
-- reason (REASON_CODES.quoteSuggestionDismiss).
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_state_shape"
  CHECK (("status" = 'pending' AND "decided_at" IS NULL AND "quote_id" IS NULL AND "dismiss_reason" IS NULL)
      OR ("status" = 'sent' AND "decided_at" IS NOT NULL AND "quote_id" IS NOT NULL AND "dismiss_reason" IS NULL)
      OR ("status" = 'dismissed' AND "decided_at" IS NOT NULL AND "quote_id" IS NULL
          AND "dismiss_reason" IS NOT NULL
          AND "dismiss_reason" IN ('not_needed', 'amount_wrong', 'covered_by_contract', 'other')));
ALTER TABLE "ticket_quote_suggestions" ADD CONSTRAINT "ticket_quote_suggestions_decided_after"
  CHECK ("decided_at" IS NULL OR "decided_at" >= "suggested_at");

-- Decided once; nothing else changes.
CREATE FUNCTION "ticket_quote_suggestions_decided_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a quote suggestion is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" <> 'pending'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id" AND NEW."amount" = OLD."amount"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."suggested_by_account_id" IS NOT DISTINCT FROM OLD."suggested_by_account_id"
     AND NEW."suggested_at" = OLD."suggested_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a quote suggestion is decided once' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "ticket_quote_suggestions_decided_once" BEFORE UPDATE OR DELETE ON "ticket_quote_suggestions"
  FOR EACH ROW EXECUTE FUNCTION "ticket_quote_suggestions_decided_once"();

-- ----------------------------------------------------------------------------
-- Grants: an entry is voided in place and a suggestion decided in place,
-- under the ticket's lock; completions never change.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "ticket_cost_entries", "ticket_completions", "ticket_quote_suggestions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_cost_entries" TO jiwar_app;
GRANT SELECT, INSERT ON "ticket_completions" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_quote_suggestions" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_cost_entries', 'ticket_completions', 'ticket_quote_suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
