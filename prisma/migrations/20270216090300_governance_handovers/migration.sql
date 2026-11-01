-- ============================================================================
-- Handovers (ADR 0075).
--
-- The board's: when a board starts to sit (appointed, or seated by an
-- election's certification) a handover pack is written, once per term: a
-- snapshot of what the board before it left open — pending requests and
-- appeals, approved requests not yet implemented, open objections and
-- agenda proposals, open action items, the latest minutes — and what the
-- domains register (contracts ending soon, the active budget). It never
-- changes; the PDF is drawn from it on demand.
--
-- The manager's: a manager prepares a handover (notes in their own words)
-- and delivers it, once: a snapshot of what waits for the office then.
-- While a board sits, an active manager's account is not deactivated
-- until they delivered one or the board approved going without
-- (`manager_handover_override`, a new approval type naming the manager):
-- 409 HANDOVER_PENDING. With no board sitting nobody could approve it, so
-- nothing blocks.
-- ============================================================================

-- The new approval type, `manager_handover_override`, is in 20270518090610:
-- dated after experience and recovery's own widening of the same CHECKs.

-- ----------------------------------------------------------------------------
-- The board's handover packs: one per term, written when it starts.
-- ----------------------------------------------------------------------------
CREATE TABLE "board_handover_packs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "previous_term_id" UUID,
    "contents" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "board_handover_packs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_handover_packs_tenant_id_id_key" ON "board_handover_packs"("tenant_id", "id");
CREATE UNIQUE INDEX "board_handover_packs_term_key" ON "board_handover_packs"("tenant_id", "term_id");
ALTER TABLE "board_handover_packs"
  ADD CONSTRAINT "board_handover_packs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_handover_packs_tenant_id_term_fkey"
  FOREIGN KEY ("tenant_id", "term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_handover_packs_tenant_id_previous_term_fkey"
  FOREIGN KEY ("tenant_id", "previous_term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "board_handover_packs" ADD CONSTRAINT "board_handover_packs_contents"
  CHECK (jsonb_typeof("contents") = 'object');
CREATE TRIGGER board_handover_packs_immutable_rows
  BEFORE UPDATE OR DELETE ON "board_handover_packs"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER board_handover_packs_immutable_truncate
  BEFORE TRUNCATE ON "board_handover_packs"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The manager's handover: drafted, then delivered once with its snapshot.
-- ----------------------------------------------------------------------------
CREATE TABLE "manager_handovers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "notes_cleared_at" TIMESTAMPTZ(3),
    "contents" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    CONSTRAINT "manager_handovers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manager_handovers_tenant_id_id_key" ON "manager_handovers"("tenant_id", "id");
-- One draft per manager at a time.
CREATE UNIQUE INDEX "manager_handovers_one_draft" ON "manager_handovers"("tenant_id", "account_id")
  WHERE "status" = 'draft';
CREATE INDEX "manager_handovers_account_idx" ON "manager_handovers"("tenant_id", "account_id", "status");
CREATE INDEX "manager_handovers_delivered_idx" ON "manager_handovers"("tenant_id", "delivered_at", "id");
ALTER TABLE "manager_handovers"
  ADD CONSTRAINT "manager_handovers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "manager_handovers_tenant_id_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- HANDOVER_STATUSES and HANDOVER_LIMITS; a unit test keeps them in step.
-- Delivered with its snapshot, once; the notes cleared once, at an erasure.
ALTER TABLE "manager_handovers" ADD CONSTRAINT "manager_handovers_shape"
  CHECK ("status" IN ('draft', 'delivered')
     AND ("status" = 'delivered') = ("delivered_at" IS NOT NULL)
     AND ("delivered_at" IS NULL) = ("contents" IS NULL)
     AND ("contents" IS NULL OR jsonb_typeof("contents") = 'object')
     AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 4000)
     AND ("notes_cleared_at" IS NULL OR "notes" IS NULL));

CREATE FUNCTION manager_handover_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."status" = 'draft'
          OR (NEW."status" = OLD."status"
              AND NEW."contents" IS NOT DISTINCT FROM OLD."contents"
              AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
              AND (NEW."notes" IS NOT DISTINCT FROM OLD."notes"
                   OR (OLD."notes_cleared_at" IS NULL AND NEW."notes" IS NULL
                       AND NEW."notes_cleared_at" IS NOT NULL)))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'manager_handovers: a draft changes; delivered, it is kept (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER manager_handovers_moves
  BEFORE UPDATE OR DELETE ON "manager_handovers"
  FOR EACH ROW EXECUTE FUNCTION manager_handover_moves();
CREATE TRIGGER manager_handovers_moves_truncate
  BEFORE TRUNCATE ON "manager_handovers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "board_handover_packs", "manager_handovers" FROM jiwar_app;
GRANT SELECT, INSERT ON "board_handover_packs" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "manager_handovers" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_handover_packs', 'manager_handovers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
