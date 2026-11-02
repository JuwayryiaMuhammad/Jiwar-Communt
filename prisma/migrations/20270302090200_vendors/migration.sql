-- ============================================================================
-- Vendors (ADR 0077): the compound's register of the companies it buys from
-- and contracts with, kept apart from partners (ADR 0060, the services
-- residents use), with an optional link when one company is both. A vendor
-- has a V- number, its trades, its contacts as business data, its
-- documents with their expiry, its evaluations, and is suspended with a
-- code and reinstated. A suspended vendor takes no new contract, expense or
-- purchase request (the services refuse). Never deleted.
--
-- Until now a vendor was free text on a maintenance contract (ADR 0065), an
-- expense (ADR 0055) and an asset (ADR 0064). Each compound's distinct
-- names (trimmed, at most 120 characters, compared without case) become
-- its vendors, numbered in name order; each row is linked to its vendor and
-- keeps its text for display. Every contract names a vendor from here on.
--
-- No personal data: a vendor's contact is a company's business contact.
-- ============================================================================

CREATE TABLE "procurement_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "procurement_counters_pkey" PRIMARY KEY ("tenant_id", "kind")
);
ALTER TABLE "procurement_counters" ADD CONSTRAINT "procurement_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "procurement_counters" ADD CONSTRAINT "procurement_counters_kind_known"
  CHECK ("kind" IN ('vendor', 'purchase_request'));
ALTER TABLE "procurement_counters" ADD CONSTRAINT "procurement_counters_last_number"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- The register.
-- ----------------------------------------------------------------------------
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "commercial_register" TEXT,
    "tax_number" TEXT,
    "categories" TEXT[] NOT NULL DEFAULT ARRAY['other']::TEXT[],
    "contact_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "partner_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "suspended_at" TIMESTAMPTZ(3),
    "suspended_by_account_id" UUID,
    "suspend_reason" TEXT,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendors_tenant_id_id_key" ON "vendors"("tenant_id", "id");
CREATE UNIQUE INDEX "vendors_number_key" ON "vendors"("tenant_id", "number");
-- One vendor a name in a compound, whatever its case: the backfill and a
-- contract naming a vendor by its name find it by this.
CREATE UNIQUE INDEX "vendors_name_key" ON "vendors"("tenant_id", lower("name"));
-- A partner is at most one vendor.
CREATE UNIQUE INDEX "vendors_partner_key" ON "vendors"("tenant_id", "partner_id")
  WHERE "partner_id" IS NOT NULL;
CREATE INDEX "vendors_status_idx" ON "vendors"("tenant_id", "status", "name", "id");
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendors_tenant_id_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendors_tenant_id_suspended_by_fkey"
  FOREIGN KEY ("tenant_id", "suspended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendors_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vendors" ADD CONSTRAINT "vendors_number_positive" CHECK ("number" > 0);
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_text_length"
  CHECK (char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name")
     AND ("legal_name" IS NULL OR char_length("legal_name") BETWEEN 1 AND 200)
     AND ("commercial_register" IS NULL OR "commercial_register" ~ '^[A-Za-z0-9/-]{1,40}$')
     AND ("tax_number" IS NULL OR "tax_number" ~ '^[A-Za-z0-9/-]{1,40}$')
     AND ("contact_name" IS NULL OR char_length("contact_name") BETWEEN 1 AND 120)
     AND ("phone" IS NULL OR "phone" ~ '^[0-9+() -]{3,30}$')
     AND ("email" IS NULL OR (char_length("email") <= 254 AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
     AND ("address" IS NULL OR char_length("address") BETWEEN 1 AND 300)
     AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 1000));
-- Its trades, from VENDOR_CATEGORIES: one at least, none twice.
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_categories_known"
  CHECK (cardinality("categories") BETWEEN 1 AND 9
     AND "categories" <@ ARRAY['maintenance', 'cleaning', 'security', 'landscaping',
                               'pest_control', 'supplies', 'utilities', 'professional',
                               'other']::TEXT[]);
-- Suspended with its time, its suspender and a code from its closed list;
-- active with none of them.
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_status_shape"
  CHECK (("status" = 'active'
          AND "suspended_at" IS NULL AND "suspended_by_account_id" IS NULL AND "suspend_reason" IS NULL)
      OR ("status" = 'suspended'
          AND "suspended_at" IS NOT NULL AND "suspended_by_account_id" IS NOT NULL
          AND "suspend_reason" IN ('performance', 'documents_lapsed', 'safety', 'fraud', 'other')));

-- A vendor keeps its number and when it was created, and is never deleted.
CREATE FUNCTION vendors_keep_their_number() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."created_at" = OLD."created_at"
     AND NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vendors: a vendor keeps its number and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER vendors_keep_number
  BEFORE UPDATE OR DELETE ON "vendors"
  FOR EACH ROW EXECUTE FUNCTION vendors_keep_their_number();
CREATE TRIGGER vendors_keep_number_truncate
  BEFORE TRUNCATE ON "vendors"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A vendor's papers: a commercial register, a tax card, a licence, an
-- insurance policy, a safety certificate. Its number and dates as
-- recorded; removed once (a paper filed by mistake), never edited. The
-- expiry is announced once per date, as a contract's end (ADR 0065).
-- ----------------------------------------------------------------------------
CREATE TABLE "vendor_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "number" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "expiry_alerted_for" DATE,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    CONSTRAINT "vendor_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_documents_tenant_id_id_key" ON "vendor_documents"("tenant_id", "id");
CREATE UNIQUE INDEX "vendor_documents_file_key" ON "vendor_documents"("tenant_id", "file_id");
CREATE INDEX "vendor_documents_vendor_idx"
  ON "vendor_documents"("tenant_id", "vendor_id", "kind", "added_at" DESC, "id" DESC);
-- What the expiry sweep reads.
CREATE INDEX "vendor_documents_expiry_idx"
  ON "vendor_documents"("tenant_id", "expires_on", "id")
  WHERE "removed_at" IS NULL AND "expires_on" IS NOT NULL;
ALTER TABLE "vendor_documents"
  ADD CONSTRAINT "vendor_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_documents_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_documents_tenant_id_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_documents_tenant_id_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_documents_tenant_id_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_kind_known"
  CHECK ("kind" IN ('commercial_register', 'tax_card', 'licence', 'insurance',
                    'safety_certificate', 'contract_copy', 'other'));
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_shape"
  CHECK (("number" IS NULL OR "number" ~ '^[A-Za-z0-9/. -]{1,60}$')
     AND ("issued_on" IS NULL OR "expires_on" IS NULL OR "expires_on" > "issued_on")
     AND ("expiry_alerted_for" IS NULL OR "expiry_alerted_for" = "expires_on")
     AND (("removed_at" IS NULL) = ("removed_by_account_id" IS NULL)));

-- A paper is never edited: only removed once, and its expiry announced.
CREATE FUNCTION vendor_documents_removed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."vendor_id" = OLD."vendor_id" AND NEW."kind" = OLD."kind"
     AND NEW."file_id" = OLD."file_id"
     AND NEW."number" IS NOT DISTINCT FROM OLD."number"
     AND NEW."issued_on" IS NOT DISTINCT FROM OLD."issued_on"
     AND NEW."expires_on" IS NOT DISTINCT FROM OLD."expires_on"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."added_at" = OLD."added_at"
     AND (OLD."removed_at" IS NULL
          OR (NEW."removed_at" = OLD."removed_at"
              AND NEW."removed_by_account_id" = OLD."removed_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vendor_documents: a paper is never edited, and is removed once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER vendor_documents_removed_once
  BEFORE UPDATE OR DELETE ON "vendor_documents"
  FOR EACH ROW EXECUTE FUNCTION vendor_documents_removed_once();
CREATE TRIGGER vendor_documents_removed_once_truncate
  BEFORE TRUNCATE ON "vendor_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A vendor's evaluation: five scores of 1 to 5 and a note, by whoever keeps
-- the register, for a contract or in general. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "vendor_evaluations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "contract_id" UUID,
    "quality" SMALLINT NOT NULL,
    "timeliness" SMALLINT NOT NULL,
    "cost" SMALLINT NOT NULL,
    "communication" SMALLINT NOT NULL,
    "safety" SMALLINT NOT NULL,
    "note" TEXT,
    "evaluated_by_account_id" UUID NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vendor_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_evaluations_tenant_id_id_key" ON "vendor_evaluations"("tenant_id", "id");
CREATE INDEX "vendor_evaluations_vendor_idx"
  ON "vendor_evaluations"("tenant_id", "vendor_id", "evaluated_at" DESC, "id" DESC);
ALTER TABLE "vendor_evaluations"
  ADD CONSTRAINT "vendor_evaluations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_evaluations_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_evaluations_tenant_id_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vendor_evaluations_tenant_id_by_fkey"
  FOREIGN KEY ("tenant_id", "evaluated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_evaluations" ADD CONSTRAINT "vendor_evaluations_scores"
  CHECK ("quality" BETWEEN 1 AND 5 AND "timeliness" BETWEEN 1 AND 5 AND "cost" BETWEEN 1 AND 5
     AND "communication" BETWEEN 1 AND 5 AND "safety" BETWEEN 1 AND 5
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000));
CREATE TRIGGER vendor_evaluations_immutable
  BEFORE UPDATE OR DELETE ON "vendor_evaluations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER vendor_evaluations_immutable_truncate
  BEFORE TRUNCATE ON "vendor_evaluations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The rows that named a vendor in words now point at one. A contract always
-- does (NOT NULL below); an expense and an asset may still name none.
-- ----------------------------------------------------------------------------
ALTER TABLE "maintenance_contracts" ADD COLUMN "vendor_id" UUID;
ALTER TABLE "finance_expenses" ADD COLUMN "vendor_id" UUID;
ALTER TABLE "assets" ADD COLUMN "vendor_id" UUID;
ALTER TABLE "maintenance_contracts"
  ADD CONSTRAINT "maintenance_contracts_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_expenses"
  ADD CONSTRAINT "finance_expenses_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "maintenance_contracts_vendor_idx" ON "maintenance_contracts"("tenant_id", "vendor_id", "ends_on");
CREATE INDEX "finance_expenses_vendor_idx" ON "finance_expenses"("tenant_id", "vendor_id", "spent_on");
CREATE INDEX "assets_vendor_idx" ON "assets"("tenant_id", "vendor_id") WHERE "vendor_id" IS NOT NULL;

-- An expense keeps its terms and is voided once (ADR 0055); its vendor link
-- is set once, on a voided expense too (the backfill below), and never moves.
CREATE OR REPLACE FUNCTION finance_expense_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."budget_line_id" = OLD."budget_line_id"
     AND NEW."authorization_id" IS NOT DISTINCT FROM OLD."authorization_id"
     AND NEW."vendor" = OLD."vendor" AND NEW."amount" = OLD."amount"
     AND NEW."spent_on" = OLD."spent_on"
     AND NEW."invoice_file_id" = OLD."invoice_file_id"
     AND NEW."reference" IS NOT DISTINCT FROM OLD."reference"
     AND NEW."recorded_by_account_id" = OLD."recorded_by_account_id"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND (OLD."vendor_id" IS NULL OR NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id") THEN
    IF OLD."voided_at" IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW."voided_at" IS NOT DISTINCT FROM OLD."voided_at"
       AND NEW."voided_by_account_id" IS NOT DISTINCT FROM OLD."voided_by_account_id"
       AND NEW."void_reason_code" IS NOT DISTINCT FROM OLD."void_reason_code" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'finance_expenses: an expense keeps its terms and is voided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- A vendor's name as the backfill reads a free text: trimmed, at most 120
-- characters, never empty. Dropped at the end of this migration. The
-- vendors table is not yet under RLS here, so every read of it names the
-- compound.
CREATE FUNCTION vendor_backfill_name(t TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(left(COALESCE(NULLIF(btrim(t), ''), 'Unnamed vendor'), 120))
$$;

DO $$
DECLARE
  t record;
  n integer;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    -- One vendor a name (the first spelling met), with a phone a contract
    -- or an asset gave it, numbered in name order.
    INSERT INTO "vendors" ("id", "tenant_id", "number", "name", "phone", "created_at", "updated_at")
    SELECT gen_random_uuid(), t."id",
           row_number() OVER (ORDER BY lower(s."name"), s."name"),
           s."name", s."phone", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM (
        SELECT DISTINCT ON (lower(x."name")) x."name", x."phone"
          FROM (
            SELECT vendor_backfill_name(c."vendor_name") AS "name", c."vendor_phone" AS "phone", 0 AS "o"
              FROM "maintenance_contracts" c
            UNION ALL
            SELECT vendor_backfill_name(a."vendor_name"), a."vendor_phone", 1
              FROM "assets" a WHERE a."vendor_name" IS NOT NULL AND btrim(a."vendor_name") <> ''
            UNION ALL
            SELECT vendor_backfill_name(e."vendor"), NULL, 2
              FROM "finance_expenses" e
          ) x
         ORDER BY lower(x."name"), (x."phone" IS NULL), x."o", x."name"
      ) s;
    SELECT count(*) INTO n FROM "vendors" WHERE "tenant_id" = t."id";
    IF n > 0 THEN
      INSERT INTO "procurement_counters" ("tenant_id", "kind", "last_number")
      VALUES (t."id", 'vendor', n);
    END IF;
    UPDATE "maintenance_contracts" c SET "vendor_id" = v."id"
      FROM "vendors" v
     WHERE v."tenant_id" = c."tenant_id"
       AND lower(v."name") = lower(vendor_backfill_name(c."vendor_name"));
    UPDATE "assets" a SET "vendor_id" = v."id"
      FROM "vendors" v
     WHERE v."tenant_id" = a."tenant_id" AND a."vendor_name" IS NOT NULL AND btrim(a."vendor_name") <> ''
       AND lower(v."name") = lower(vendor_backfill_name(a."vendor_name"));
    UPDATE "finance_expenses" e SET "vendor_id" = v."id"
      FROM "vendors" v
     WHERE v."tenant_id" = e."tenant_id"
       AND lower(v."name") = lower(vendor_backfill_name(e."vendor"));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

DROP FUNCTION vendor_backfill_name(TEXT);

ALTER TABLE "maintenance_contracts" ALTER COLUMN "vendor_id" SET NOT NULL;

REVOKE ALL ON "procurement_counters", "vendors", "vendor_documents", "vendor_evaluations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "procurement_counters", "vendors", "vendor_documents" TO jiwar_app;
GRANT SELECT, INSERT ON "vendor_evaluations" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['procurement_counters', 'vendors', 'vendor_documents', 'vendor_evaluations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
