-- ============================================================================
-- The general ledger (ADR 0092): double entry, beside ADR 0048's computed
-- journal, which stays as it is.
--
-- - `gl_accounts`: the compound's chart. A standard chart is seeded for
--   every compound (`gl_seed_chart`), its system accounts named by a key
--   the automatic postings use; a bank or cash account of the treasury
--   (ADR 0085) has its own account under its heading. The accountant adds
--   sub-accounts and renames; a system account is never removed, and no
--   account ever changes its type, code or place.
-- - `gl_entries` and `gl_lines`: append-only. An entry is one event (its
--   source and the source's id, once) or one manual entry; its lines are
--   written in its own transaction only and its debits equal its credits,
--   checked at commit.
-- - `gl_periods`: a month closed (or reopened) once it has ended. No entry
--   is dated in a closed month: refused when written and again at commit.
-- - `gl_manual_entries` and their lines: written by one accountant, posted
--   only once another approves (maker-checker, a CHECK).
-- Nothing personal: the lines name a unit or a vendor, the compound's own
-- records, and a manual entry's words are the staff's.
-- ============================================================================

CREATE TABLE "gl_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parent_id" UUID,
    "system_key" TEXT,
    "cash_account_id" UUID,
    "control" BOOLEAN NOT NULL DEFAULT false,
    "postable" BOOLEAN NOT NULL DEFAULT true,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gl_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gl_accounts_tenant_id_id_key" ON "gl_accounts"("tenant_id", "id");
CREATE UNIQUE INDEX "gl_accounts_code_key" ON "gl_accounts"("tenant_id", "code");
CREATE UNIQUE INDEX "gl_accounts_system_key" ON "gl_accounts"("tenant_id", "system_key")
  WHERE "system_key" IS NOT NULL;
CREATE UNIQUE INDEX "gl_accounts_cash_account_key" ON "gl_accounts"("tenant_id", "cash_account_id")
  WHERE "cash_account_id" IS NOT NULL;
CREATE INDEX "gl_accounts_parent_idx" ON "gl_accounts"("tenant_id", "parent_id");
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_parent_fkey"
  FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "gl_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_cash_account_fkey"
  FOREIGN KEY ("tenant_id", "cash_account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_type_known"
  CHECK ("type" IN ('asset', 'liability', 'equity', 'revenue', 'expense'));
-- Four digits, then up to three dotted parts: 1110, 1110.01, 5100.2.
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_code_shape"
  CHECK ("code" ~ '^[0-9]{4}(\.[0-9]{1,3}){0,3}$');
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 100 AND char_length("name_ar") BETWEEN 1 AND 100);
-- A system account is the seed's (no author); every other one an
-- accountant's. Only a system account is a heading, a control account or a
-- treasury account's.
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_system_shape"
  CHECK ((("system_key" IS NULL) = ("created_by_account_id" IS NOT NULL))
     AND ("cash_account_id" IS NULL
          OR ("system_key" IS NOT NULL AND "system_key" = 'cash:' || "cash_account_id"::text))
     AND ("system_key" IS NOT NULL OR (NOT "control" AND "postable")));

-- Only the names change; a system account is never removed.
CREATE FUNCTION "gl_accounts_fixed"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."system_key" IS NOT NULL THEN
      RAISE EXCEPTION 'gl account %: a system account is never removed', OLD."id"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."code" <> OLD."code" OR NEW."type" <> OLD."type"
     OR NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
     OR NEW."system_key" IS DISTINCT FROM OLD."system_key"
     OR NEW."cash_account_id" IS DISTINCT FROM OLD."cash_account_id"
     OR NEW."control" <> OLD."control" OR NEW."postable" <> OLD."postable"
     OR NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'gl account %: only its names change', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_accounts_fixed" BEFORE UPDATE OR DELETE ON "gl_accounts"
  FOR EACH ROW EXECUTE FUNCTION "gl_accounts_fixed"();

-- A sub-account is of its parent's type, and never under a control account
-- (its register keeps it).
CREATE FUNCTION "gl_accounts_parent"() RETURNS trigger AS $$
DECLARE
  p record;
BEGIN
  IF NEW."parent_id" IS NULL THEN RETURN NEW; END IF;
  SELECT a."type", a."control" INTO p FROM "gl_accounts" a
   WHERE a."tenant_id" = NEW."tenant_id" AND a."id" = NEW."parent_id";
  IF p."type" <> NEW."type" OR (p."control" AND NEW."system_key" IS NULL) THEN
    RAISE EXCEPTION 'gl account %: of its parent''s type, never under a control account', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_accounts_parent" BEFORE INSERT ON "gl_accounts"
  FOR EACH ROW EXECUTE FUNCTION "gl_accounts_parent"();

-- ----------------------------------------------------------------------------
-- Months closed. A row once a month was ever closed; `open` again only by a
-- reopen.
-- ----------------------------------------------------------------------------
CREATE TABLE "gl_periods" (
    "tenant_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_account_id" UUID NOT NULL,
    "reopened_at" TIMESTAMPTZ(3),
    "reopened_by_account_id" UUID,
    "reopen_reason" TEXT,
    CONSTRAINT "gl_periods_pkey" PRIMARY KEY ("tenant_id", "month")
);
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_reopened_by_fkey"
  FOREIGN KEY ("tenant_id", "reopened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_month_first"
  CHECK (extract(day FROM "month") = 1);
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_status_known"
  CHECK ("status" IN ('closed', 'open'));
-- REASON_CODES.glPeriodReopen; a unit test keeps the two in step.
ALTER TABLE "gl_periods" ADD CONSTRAINT "gl_periods_reopen_shape"
  CHECK ((("reopened_at" IS NULL) = ("reopened_by_account_id" IS NULL))
     AND (("reopened_at" IS NULL) = ("reopen_reason" IS NULL))
     AND ("status" = 'closed' OR "reopened_at" IS NOT NULL)
     AND ("reopen_reason" IS NULL
          OR "reopen_reason" IN ('late_document', 'correction', 'audit_finding', 'other')));
CREATE TRIGGER "gl_periods_no_delete" BEFORE DELETE ON "gl_periods"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

CREATE FUNCTION "gl_month_closed"(t uuid, d date) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "gl_periods" p
                  WHERE p."tenant_id" = t AND p."month" = date_trunc('month', d)::date
                    AND p."status" = 'closed')
$$;

-- ----------------------------------------------------------------------------
-- Entries and lines. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "gl_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "posted_on" DATE NOT NULL,
    "event_on" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "reference" TEXT,
    "txid" BIGINT NOT NULL DEFAULT txid_current(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gl_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gl_entries_tenant_id_id_key" ON "gl_entries"("tenant_id", "id");
-- Each event posts once.
CREATE UNIQUE INDEX "gl_entries_source_key" ON "gl_entries"("tenant_id", "source", "source_id");
CREATE INDEX "gl_entries_posted_idx" ON "gl_entries"("tenant_id", "posted_on", "seq");
ALTER TABLE "gl_entries" ADD CONSTRAINT "gl_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_entries" ADD CONSTRAINT "gl_entries_source_known"
  CHECK ("source" IN ('invoice', 'credit_note', 'payment', 'payment_reversal', 'allocation',
                      'allocation_release', 'refund', 'refund_reversal', 'deposit', 'deposit_event',
                      'expense', 'expense_void', 'vendor_invoice', 'vendor_invoice_cancel',
                      'vendor_payout', 'cash_movement', 'custody_handin', 'club_payment',
                      'vehicle_fine_payment', 'violation_payment', 'manual'));
-- Posted on its event's day, or later when that month was closed.
ALTER TABLE "gl_entries" ADD CONSTRAINT "gl_entries_days"
  CHECK ("posted_on" >= "event_on" AND ("source" <> 'manual' OR "posted_on" = "event_on"));
ALTER TABLE "gl_entries" ADD CONSTRAINT "gl_entries_reference_length"
  CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 40);
CREATE TRIGGER gl_entries_immutable_rows
  BEFORE UPDATE OR DELETE ON "gl_entries"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gl_entries_immutable_truncate
  BEFORE TRUNCATE ON "gl_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE FUNCTION "gl_entries_open_month"() RETURNS trigger AS $$
BEGIN
  IF "gl_month_closed"(NEW."tenant_id", NEW."posted_on") THEN
    RAISE EXCEPTION 'gl entry %: % is in a closed month', NEW."id", NEW."posted_on"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_entries_open_month" BEFORE INSERT ON "gl_entries"
  FOR EACH ROW EXECUTE FUNCTION "gl_entries_open_month"();

CREATE TABLE "gl_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "account_id" UUID NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unit_id" UUID,
    "vendor_id" UUID,
    "memo" TEXT,
    "posted_on" DATE NOT NULL,
    "entry_seq" BIGINT NOT NULL,
    CONSTRAINT "gl_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gl_lines_tenant_id_id_key" ON "gl_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "gl_lines_entry_line_key" ON "gl_lines"("tenant_id", "entry_id", "line_no");
CREATE INDEX "gl_lines_account_idx" ON "gl_lines"("tenant_id", "account_id", "posted_on", "entry_seq", "line_no");
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "gl_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "gl_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A debit or a credit, never both, never nothing.
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_one_side"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_memo_length"
  CHECK ("memo" IS NULL OR char_length("memo") BETWEEN 1 AND 200);
CREATE TRIGGER gl_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "gl_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gl_lines_immutable_truncate
  BEFORE TRUNCATE ON "gl_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A line joins its entry in the entry's own transaction only, on an account
-- that takes lines; it carries the entry's day and order for the ledgers.
CREATE FUNCTION "gl_lines_of_entry"() RETURNS trigger AS $$
DECLARE
  e record;
  postable boolean;
BEGIN
  SELECT x."posted_on", x."seq", x."txid" INTO e FROM "gl_entries" x
   WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = NEW."entry_id";
  IF e."txid" IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'gl line: entry % was written in another transaction', NEW."entry_id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a."postable" INTO postable FROM "gl_accounts" a
   WHERE a."tenant_id" = NEW."tenant_id" AND a."id" = NEW."account_id";
  IF NOT postable THEN
    RAISE EXCEPTION 'gl line: account % is a heading', NEW."account_id"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."posted_on" := e."posted_on";
  NEW."entry_seq" := e."seq";
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_lines_of_entry" BEFORE INSERT ON "gl_lines"
  FOR EACH ROW EXECUTE FUNCTION "gl_lines_of_entry"();

-- At commit: an entry has two lines at least, its debits equal its credits,
-- and its month is still open (a month closed meanwhile refuses it).
CREATE FUNCTION "gl_entries_balanced"() RETURNS trigger AS $$
DECLARE
  n int;
  dr numeric;
  cr numeric;
BEGIN
  SELECT count(*), COALESCE(SUM(l."debit"), 0), COALESCE(SUM(l."credit"), 0) INTO n, dr, cr
    FROM "gl_lines" l WHERE l."tenant_id" = NEW."tenant_id" AND l."entry_id" = NEW."id";
  IF n < 2 OR dr <> cr THEN
    RAISE EXCEPTION 'gl entry %: % lines, debits % and credits % must balance', NEW."id", n, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
  IF "gl_month_closed"(NEW."tenant_id", NEW."posted_on") THEN
    RAISE EXCEPTION 'gl entry %: % is in a closed month', NEW."id", NEW."posted_on"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "gl_entries_balanced"
  AFTER INSERT ON "gl_entries" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "gl_entries_balanced"();

-- ----------------------------------------------------------------------------
-- Manual journal entries: pending until a second person decides them.
-- ----------------------------------------------------------------------------
CREATE TABLE "gl_manual_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "posted_on" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reverses_entry_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "entry_id" UUID,
    "txid" BIGINT NOT NULL DEFAULT txid_current(),
    CONSTRAINT "gl_manual_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gl_manual_entries_tenant_id_id_key" ON "gl_manual_entries"("tenant_id", "id");
CREATE UNIQUE INDEX "gl_manual_entries_number_key" ON "gl_manual_entries"("tenant_id", "number");
CREATE UNIQUE INDEX "gl_manual_entries_entry_key" ON "gl_manual_entries"("tenant_id", "entry_id")
  WHERE "entry_id" IS NOT NULL;
-- One live reversal an entry: pending or approved.
CREATE UNIQUE INDEX "gl_manual_entries_one_reversal" ON "gl_manual_entries"("tenant_id", "reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL AND "status" IN ('pending', 'approved');
CREATE INDEX "gl_manual_entries_status_idx" ON "gl_manual_entries"("tenant_id", "status", "created_at", "id");
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_reverses_fkey"
  FOREIGN KEY ("tenant_id", "reverses_entry_id") REFERENCES "gl_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "gl_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_memo_length"
  CHECK (char_length("memo") BETWEEN 1 AND 500);
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_status_known"
  CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'));
-- Pending: undecided. Approved: by someone other than its maker, posted.
-- Rejected: with a reason (REASON_CODES.glEntryReject; a unit test keeps
-- them in step). Withdrawn: by its maker.
ALTER TABLE "gl_manual_entries" ADD CONSTRAINT "gl_manual_entries_state_shape"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL)
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" = 'approved') = ("entry_id" IS NOT NULL))
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("status" <> 'approved' OR "decided_by_account_id" <> "created_by_account_id")
     AND ("status" <> 'withdrawn' OR "decided_by_account_id" = "created_by_account_id")
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('wrong_accounts', 'wrong_amounts', 'wrong_date', 'not_needed', 'other')));

-- Decided once, from pending; its terms never change.
CREATE FUNCTION "gl_manual_entries_fixed"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'pending'
     OR NEW."number" <> OLD."number" OR NEW."posted_on" <> OLD."posted_on"
     OR NEW."memo" <> OLD."memo"
     OR NEW."reverses_entry_id" IS DISTINCT FROM OLD."reverses_entry_id"
     OR NEW."created_by_account_id" <> OLD."created_by_account_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'manual entry %: decided once, its terms fixed', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_manual_entries_fixed" BEFORE UPDATE ON "gl_manual_entries"
  FOR EACH ROW EXECUTE FUNCTION "gl_manual_entries_fixed"();
CREATE TRIGGER "gl_manual_entries_no_delete" BEFORE DELETE ON "gl_manual_entries"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "gl_manual_entry_lines" (
    "tenant_id" UUID NOT NULL,
    "manual_entry_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "account_id" UUID NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unit_id" UUID,
    "memo" TEXT,
    CONSTRAINT "gl_manual_entry_lines_pkey" PRIMARY KEY ("tenant_id", "manual_entry_id", "line_no")
);
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_entry_fkey"
  FOREIGN KEY ("tenant_id", "manual_entry_id") REFERENCES "gl_manual_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "gl_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_one_side"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0))
     AND "debit" <= 999999999.99 AND "credit" <= 999999999.99);
ALTER TABLE "gl_manual_entry_lines" ADD CONSTRAINT "gl_manual_entry_lines_memo_length"
  CHECK ("memo" IS NULL OR char_length("memo") BETWEEN 1 AND 200);
CREATE TRIGGER gl_manual_entry_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "gl_manual_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- A manual entry's lines are written with it, in its own transaction.
CREATE FUNCTION "gl_manual_entry_lines_with_entry"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "gl_manual_entries" m
                  WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."manual_entry_id"
                    AND m."status" = 'pending' AND m."txid" = txid_current()) THEN
    RAISE EXCEPTION 'manual entry %: its lines are written with it', NEW."manual_entry_id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_manual_entry_lines_with_entry" BEFORE INSERT ON "gl_manual_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION "gl_manual_entry_lines_with_entry"();

-- At commit: a manual entry has two lines at least and balances.
CREATE FUNCTION "gl_manual_entries_balanced"() RETURNS trigger AS $$
DECLARE
  n int;
  dr numeric;
  cr numeric;
BEGIN
  SELECT count(*), COALESCE(SUM(l."debit"), 0), COALESCE(SUM(l."credit"), 0) INTO n, dr, cr
    FROM "gl_manual_entry_lines" l
   WHERE l."tenant_id" = NEW."tenant_id" AND l."manual_entry_id" = NEW."id";
  IF n < 2 OR dr <> cr THEN
    RAISE EXCEPTION 'manual entry %: % lines, debits % and credits % must balance', NEW."id", n, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "gl_manual_entries_balanced"
  AFTER INSERT ON "gl_manual_entries" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "gl_manual_entries_balanced"();

REVOKE ALL ON "gl_accounts", "gl_periods", "gl_entries", "gl_lines",
              "gl_manual_entries", "gl_manual_entry_lines" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_accounts" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gl_periods", "gl_manual_entries" TO jiwar_app;
GRANT SELECT, INSERT ON "gl_entries", "gl_lines", "gl_manual_entry_lines" TO jiwar_app;
GRANT USAGE, SELECT ON SEQUENCE "gl_entries_seq_seq" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_accounts', 'gl_periods', 'gl_entries', 'gl_lines',
                           'gl_manual_entries', 'gl_manual_entry_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
