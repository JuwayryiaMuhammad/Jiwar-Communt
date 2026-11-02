-- ============================================================================
-- Commitments (ADR 0089): budget a line keeps for what was agreed and not
-- yet invoiced — a contract's unpaid payment due within the line's budget
-- year, or an approved purchase request. A line's available is its
-- allowance less what was spent, what is committed and what is approved to
-- pay; a commitment is reserved within it.
--
-- - A commitment's terms never change. It is released by rows of its own,
--   append-only: by an approved invoice (its amount, up to what is open),
--   or wholly when its source changes, is cancelled or terminated, or is
--   paid by hand. Fully released, it is closed once (checked at commit).
-- - One open commitment an item: a contract's payment, a purchase request.
-- - A contract's payment is named by its id, not a key: the schedule's
--   unpaid lines are replaced whole (ADR 0077), and the commitment keeps it
--   as history once released.
-- ============================================================================

CREATE TABLE "finance_commitments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "contract_id" UUID,
    "contract_payment_id" UUID,
    "purchase_request_id" UUID,
    "vendor_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "due_on" DATE,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_commitments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_commitments_tenant_id_id_key" ON "finance_commitments"("tenant_id", "id");
-- One open commitment an item.
CREATE UNIQUE INDEX "finance_commitments_open_payment_key"
  ON "finance_commitments"("tenant_id", "contract_payment_id")
  WHERE "closed_at" IS NULL AND "contract_payment_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_commitments_open_purchase_key"
  ON "finance_commitments"("tenant_id", "purchase_request_id")
  WHERE "closed_at" IS NULL AND "purchase_request_id" IS NOT NULL;
-- What a line's figures read, and a source's sync.
CREATE INDEX "finance_commitments_line_idx"
  ON "finance_commitments"("tenant_id", "line_id") WHERE "closed_at" IS NULL;
CREATE INDEX "finance_commitments_contract_idx"
  ON "finance_commitments"("tenant_id", "contract_id") WHERE "closed_at" IS NULL;
CREATE INDEX "finance_commitments_due_idx"
  ON "finance_commitments"("tenant_id", "due_on", "id") WHERE "closed_at" IS NULL;
CREATE INDEX "finance_commitments_created_idx"
  ON "finance_commitments"("tenant_id", "created_at", "id");
ALTER TABLE "finance_commitments"
  ADD CONSTRAINT "finance_commitments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitments_line_fkey"
  FOREIGN KEY ("tenant_id", "line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitments_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitments_purchase_fkey"
  FOREIGN KEY ("tenant_id", "purchase_request_id") REFERENCES "purchase_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitments_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitments_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_commitments" ADD CONSTRAINT "finance_commitments_shape"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99
     AND "source" IN ('contract', 'purchase_request')
     AND (("source" = 'contract')
          = ("contract_id" IS NOT NULL AND "contract_payment_id" IS NOT NULL))
     AND (("source" = 'purchase_request') = ("purchase_request_id" IS NOT NULL))
     AND ("source" <> 'purchase_request'
          OR ("contract_id" IS NULL AND "contract_payment_id" IS NULL)));

-- Terms fixed; closed once.
CREATE FUNCTION finance_commitments_close_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."line_id" = OLD."line_id" AND NEW."source" = OLD."source"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."contract_payment_id" IS NOT DISTINCT FROM OLD."contract_payment_id"
     AND NEW."purchase_request_id" IS NOT DISTINCT FROM OLD."purchase_request_id"
     AND NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."due_on" IS NOT DISTINCT FROM OLD."due_on"
     AND NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."closed_at" IS NULL AND NEW."closed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_commitments: a commitment keeps its terms and closes once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_commitments_close_once
  BEFORE UPDATE OR DELETE ON "finance_commitments"
  FOR EACH ROW EXECUTE FUNCTION finance_commitments_close_once();
CREATE TRIGGER finance_commitments_truncate
  BEFORE TRUNCATE ON "finance_commitments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Releases. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_commitment_releases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "commitment_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "vendor_invoice_id" UUID,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_commitment_releases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_commitment_releases_tenant_id_id_key"
  ON "finance_commitment_releases"("tenant_id", "id");
CREATE INDEX "finance_commitment_releases_commitment_idx"
  ON "finance_commitment_releases"("tenant_id", "commitment_id");
CREATE INDEX "finance_commitment_releases_created_idx"
  ON "finance_commitment_releases"("tenant_id", "created_at", "id");
ALTER TABLE "finance_commitment_releases"
  ADD CONSTRAINT "finance_commitment_releases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitment_releases_commitment_fkey"
  FOREIGN KEY ("tenant_id", "commitment_id") REFERENCES "finance_commitments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_commitment_releases_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The invoice's key is added with its table (20270601090200).
ALTER TABLE "finance_commitment_releases" ADD CONSTRAINT "finance_commitment_releases_shape"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99
     AND "reason" IN ('invoiced', 'changed', 'cancelled', 'terminated', 'paid_outside')
     AND (("reason" = 'invoiced') = ("vendor_invoice_id" IS NOT NULL)));
CREATE TRIGGER finance_commitment_releases_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_commitment_releases"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_commitment_releases_immutable_truncate
  BEFORE TRUNCATE ON "finance_commitment_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- At commit: a commitment is never released past its amount, and it is
-- closed exactly when it is released whole.
CREATE FUNCTION finance_commitments_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cid uuid;
  c record;
  released numeric;
BEGIN
  IF TG_TABLE_NAME = 'finance_commitments' THEN
    cid := NEW."id";
  ELSE
    cid := NEW."commitment_id";
  END IF;
  SELECT "id", "amount", "closed_at" INTO c FROM "finance_commitments" WHERE "id" = cid;
  SELECT COALESCE(sum("amount"), 0) INTO released
    FROM "finance_commitment_releases" WHERE "commitment_id" = c."id";
  IF released > c."amount" OR ((released = c."amount") <> (c."closed_at" IS NOT NULL)) THEN
    RAISE EXCEPTION 'commitment %: released at most whole, and closed when it is', c."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_commitment_releases_balanced
  AFTER INSERT ON "finance_commitment_releases" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_commitments_balanced();
CREATE CONSTRAINT TRIGGER finance_commitments_balanced
  AFTER INSERT OR UPDATE ON "finance_commitments" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_commitments_balanced();

REVOKE ALL ON "finance_commitments", "finance_commitment_releases" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_commitments" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_commitment_releases" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_commitments', 'finance_commitment_releases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
