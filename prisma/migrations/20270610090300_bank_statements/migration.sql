-- ============================================================================
-- Bank statements (ADR 0085), in two steps as the unit register's sheets
-- (ADR 0072). Uploading a CSV checks it whole — a dry run that says how many
-- lines are new, how many were imported before and what is wrong
-- (`{ line, field, code }`, never a cell's text). Applying a valid one,
-- within a day, imports its new lines and matches on their own those that
-- name exactly one payment, cheque or transfer. A line is known by a hash
-- of the account, its day, amount, reference, description and its place
-- among identical lines of its file: the same file twice imports nothing
-- new. A line nothing matched waits for a manual match.
--
-- A line's description is the bank's words and may name a payer, so the
-- file itself is let go once the import can no longer be applied; the
-- lines keep only their day, amount, reference and a description of at
-- most 200 characters, the compound's own bank record.
-- ============================================================================

CREATE TABLE "finance_statement_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "file_id" UUID,
    "status" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "new_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "applied_by_account_id" UUID,
    "imported_count" INTEGER,
    "matched_count" INTEGER,
    CONSTRAINT "finance_statement_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_statement_imports_tenant_id_id_key" ON "finance_statement_imports"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_statement_imports_file_id_key" ON "finance_statement_imports"("file_id")
  WHERE "file_id" IS NOT NULL;
CREATE INDEX "finance_statement_imports_list_idx"
  ON "finance_statement_imports"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "finance_statement_imports_valid_idx" ON "finance_statement_imports"("tenant_id", "created_at")
  WHERE "status" = 'valid';
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_applied_by_fkey"
  FOREIGN KEY ("tenant_id", "applied_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_status_known"
  CHECK ("status" IN ('valid', 'invalid', 'applied', 'expired'));
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_counts_range"
  CHECK ("row_count" BETWEEN 0 AND 2000 AND "error_count" >= 0
     AND "new_count" >= 0 AND "duplicate_count" >= 0
     AND "new_count" + "duplicate_count" <= "row_count"
     AND jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 100);
-- Valid: no error, never applied; invalid: errors, never applied; applied:
-- once, with what it imported and matched; expired: valid once, never
-- applied. The file is kept only while the import may be applied.
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_state_shape"
  CHECK (("status" IN ('valid', 'expired') AND "error_count" = 0 AND "applied_at" IS NULL AND "applied_by_account_id" IS NULL AND "imported_count" IS NULL AND "matched_count" IS NULL)
      OR ("status" = 'invalid' AND "error_count" > 0 AND "applied_at" IS NULL AND "applied_by_account_id" IS NULL AND "imported_count" IS NULL AND "matched_count" IS NULL)
      OR ("status" = 'applied' AND "error_count" = 0 AND "applied_at" IS NOT NULL AND "applied_by_account_id" IS NOT NULL AND "imported_count" IS NOT NULL AND "matched_count" IS NOT NULL));
ALTER TABLE "finance_statement_imports" ADD CONSTRAINT "finance_statement_imports_file_kept"
  CHECK (("status" = 'valid') = ("file_id" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- The lines imported: once per account and hash. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_statement_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "booked_on" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "line_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_statement_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_statement_lines_tenant_id_id_key" ON "finance_statement_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_statement_lines_hash_key"
  ON "finance_statement_lines"("tenant_id", "account_id", "line_hash");
CREATE INDEX "finance_statement_lines_account_idx"
  ON "finance_statement_lines"("tenant_id", "account_id", "booked_on" DESC, "id" DESC);
ALTER TABLE "finance_statement_lines" ADD CONSTRAINT "finance_statement_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_lines" ADD CONSTRAINT "finance_statement_lines_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_lines" ADD CONSTRAINT "finance_statement_lines_import_fkey"
  FOREIGN KEY ("tenant_id", "import_id") REFERENCES "finance_statement_imports"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_lines" ADD CONSTRAINT "finance_statement_lines_terms"
  CHECK ("line_no" > 1 AND "amount" <> 0 AND abs("amount") <= 10000000
     AND "line_hash" ~ '^[0-9a-f]{64}$'
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100)
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 200));
CREATE TRIGGER finance_statement_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_statement_lines_immutable_truncate
  BEFORE TRUNCATE ON "finance_statement_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A line's match: a bank transfer payment, a cheque deposited to the
-- account, a transfer's leg on it, or an adjustment (a bank charge, an
-- interest, a refund paid). One live match a line and a live match a
-- target; undone once, never edited.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_statement_matches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payment_id" UUID,
    "cheque_id" UUID,
    "movement_id" UUID,
    "reason_code" TEXT,
    "auto" BOOLEAN NOT NULL,
    "matched_by_account_id" UUID NOT NULL,
    "matched_at" TIMESTAMPTZ(3) NOT NULL,
    "undone_at" TIMESTAMPTZ(3),
    "undone_by_account_id" UUID,
    CONSTRAINT "finance_statement_matches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_statement_matches_tenant_id_id_key" ON "finance_statement_matches"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_statement_matches_one_per_line"
  ON "finance_statement_matches"("tenant_id", "line_id") WHERE "undone_at" IS NULL;
CREATE UNIQUE INDEX "finance_statement_matches_one_per_payment"
  ON "finance_statement_matches"("tenant_id", "payment_id") WHERE "undone_at" IS NULL AND "payment_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_statement_matches_one_per_cheque"
  ON "finance_statement_matches"("tenant_id", "cheque_id") WHERE "undone_at" IS NULL AND "cheque_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_statement_matches_one_per_movement"
  ON "finance_statement_matches"("tenant_id", "movement_id") WHERE "undone_at" IS NULL AND "movement_id" IS NOT NULL;
CREATE INDEX "finance_statement_matches_line_idx"
  ON "finance_statement_matches"("tenant_id", "line_id", "matched_at" DESC);
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_line_fkey"
  FOREIGN KEY ("tenant_id", "line_id") REFERENCES "finance_statement_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_cheque_fkey"
  FOREIGN KEY ("tenant_id", "cheque_id") REFERENCES "finance_cheques"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_movement_fkey"
  FOREIGN KEY ("tenant_id", "movement_id") REFERENCES "finance_cash_movements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_matched_by_fkey"
  FOREIGN KEY ("tenant_id", "matched_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_undone_by_fkey"
  FOREIGN KEY ("tenant_id", "undone_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_kind_known"
  CHECK ("kind" IN ('payment', 'cheque', 'transfer', 'adjustment'));
-- Each kind names its target and only it; an adjustment has its reason
-- code (REASON_CODES.cashAdjust) and is never matched on its own.
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_kind_shape"
  CHECK ((("kind" = 'payment') = ("payment_id" IS NOT NULL))
     AND (("kind" = 'cheque') = ("cheque_id" IS NOT NULL))
     AND (("kind" = 'transfer') = ("movement_id" IS NOT NULL))
     AND (("kind" = 'adjustment') = ("reason_code" IS NOT NULL))
     AND ("kind" <> 'adjustment' OR NOT "auto"));
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('bank_charge', 'interest', 'refund_paid', 'counting_correction', 'other'));
ALTER TABLE "finance_statement_matches" ADD CONSTRAINT "finance_statement_matches_undone_shape"
  CHECK (("undone_at" IS NULL) = ("undone_by_account_id" IS NULL));

-- Undone once; nothing else ever changes.
CREATE FUNCTION "finance_statement_matches_undone_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."undone_at" IS NOT NULL
     OR NEW."line_id" <> OLD."line_id"
     OR NEW."account_id" <> OLD."account_id"
     OR NEW."kind" <> OLD."kind"
     OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
     OR NEW."cheque_id" IS DISTINCT FROM OLD."cheque_id"
     OR NEW."movement_id" IS DISTINCT FROM OLD."movement_id"
     OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code"
     OR NEW."auto" <> OLD."auto"
     OR NEW."matched_by_account_id" <> OLD."matched_by_account_id"
     OR NEW."matched_at" <> OLD."matched_at" THEN
    RAISE EXCEPTION 'a statement match is undone once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "finance_statement_matches_undone_once" BEFORE UPDATE ON "finance_statement_matches"
  FOR EACH ROW EXECUTE FUNCTION "finance_statement_matches_undone_once"();
CREATE TRIGGER "finance_statement_matches_no_delete"
  BEFORE DELETE ON "finance_statement_matches"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- A line's match is on its own account.
CREATE FUNCTION finance_statement_match_on_line_account() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "finance_statement_lines" l
                  WHERE l."tenant_id" = NEW."tenant_id" AND l."id" = NEW."line_id"
                    AND l."account_id" = NEW."account_id") THEN
    RAISE EXCEPTION 'match %: violates its line''s account', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_statement_match_on_line_account
  BEFORE INSERT ON "finance_statement_matches"
  FOR EACH ROW EXECUTE FUNCTION finance_statement_match_on_line_account();

-- The movements' match source: a bank transfer a line showed, an
-- adjustment a line was matched as, and their reversals.
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_match_fkey"
  FOREIGN KEY ("tenant_id", "match_id") REFERENCES "finance_statement_matches"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "finance_statement_imports", "finance_statement_lines",
  "finance_statement_matches" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_statement_imports" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_statement_lines" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_statement_matches" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_statement_imports', 'finance_statement_lines',
                           'finance_statement_matches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
