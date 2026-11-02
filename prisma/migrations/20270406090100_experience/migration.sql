-- ============================================================================
-- Experience and recovery (ADR 0082): rule-based dissatisfaction signals, the
-- follow-up and recovery cases they open (or the staff open by hand), the
-- compensations proposed on a case and decided once, the compensation rules
-- that recommend one, and the service promises register.
--
-- No AI: a signal is a rule over what the domains already store (ratings of
-- 1 or 2, a ticket rejected or reopened, complaints from the unit) within a
-- window, with the compound's thresholds. One open case per unit: two
-- signals for one unit meet on the partial unique index and share it.
--
-- A money compensation is a credit note through finance (ADR 0058's
-- compensation), never a ledger of its own; above the board's binding
-- threshold it names what the board approved (ADR 0073). Free text (a case's
-- note and its outcome's, a compensation's note, a promise's titles) is plain
-- data: never in the audit trail or a notification.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A compound's thresholds. No row: the code's defaults. A rule's count null:
-- the rule is off.
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_settings" (
    "tenant_id" UUID NOT NULL,
    "low_ratings_count" INTEGER DEFAULT 2,
    "low_ratings_days" INTEGER NOT NULL DEFAULT 90,
    "reopened_count" INTEGER DEFAULT 2,
    "reopened_days" INTEGER NOT NULL DEFAULT 60,
    "complaints_count" INTEGER DEFAULT 3,
    "complaints_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experience_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "experience_settings" ADD CONSTRAINT "experience_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_settings" ADD CONSTRAINT "experience_settings_range"
  CHECK (("low_ratings_count" IS NULL OR "low_ratings_count" BETWEEN 2 AND 20)
     AND ("reopened_count" IS NULL OR "reopened_count" BETWEEN 2 AND 20)
     AND ("complaints_count" IS NULL OR "complaints_count" BETWEEN 2 AND 20)
     AND "low_ratings_days" BETWEEN 7 AND 365
     AND "reopened_days" BETWEEN 7 AND 365
     AND "complaints_days" BETWEEN 7 AND 365);

-- ----------------------------------------------------------------------------
-- A case's number, per compound (`EC-000123`): taken under the row's lock.
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_counters" (
    "tenant_id" UUID NOT NULL,
    "last" INTEGER NOT NULL,
    CONSTRAINT "experience_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "experience_counters" ADD CONSTRAINT "experience_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_counters" ADD CONSTRAINT "experience_counters_positive"
  CHECK ("last" >= 1);

-- ----------------------------------------------------------------------------
-- A follow-up (before the resident complains) or a recovery (after a
-- service failed) about one unit: opened by a signal (no opener) or by hand,
-- owned by a staff member, closed once with an outcome. Its due time is the
-- staff inbox's for its kind (ADR 0073). The item it is about, when there is
-- one, is a reference into its domain's table (no foreign key).
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "failure_code" TEXT,
    "note" TEXT,
    "owner_account_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_by_account_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "outcome_note" TEXT,
    CONSTRAINT "experience_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "experience_cases_tenant_id_id_key" ON "experience_cases"("tenant_id", "id");
CREATE UNIQUE INDEX "experience_cases_tenant_id_number_key" ON "experience_cases"("tenant_id", "number");
-- One open case per unit: two signals, or a signal and a hand, meet here.
CREATE UNIQUE INDEX "experience_cases_one_open_per_unit"
  ON "experience_cases"("tenant_id", "unit_id") WHERE "status" = 'open';
CREATE INDEX "experience_cases_list_idx"
  ON "experience_cases"("tenant_id", "status", "opened_at" DESC, "id" DESC);
CREATE INDEX "experience_cases_unit_idx"
  ON "experience_cases"("tenant_id", "unit_id", "opened_at" DESC);
-- The inbox reads the open ones of a kind, oldest first.
CREATE INDEX "experience_cases_open_idx"
  ON "experience_cases"("tenant_id", "kind", "opened_at", "id") WHERE "status" = 'open';
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_tenant_id_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_known"
  CHECK ("kind" IN ('follow_up', 'recovery')
     AND "origin" IN ('signal', 'manual')
     AND "status" IN ('open', 'closed')
     AND "number" >= 1);
-- By hand: someone opened it; by a signal: the system did, as a follow-up.
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_origin_shape"
  CHECK (("origin" = 'manual') = ("opened_by_account_id" IS NOT NULL)
     AND ("origin" = 'manual' OR "kind" = 'follow_up'));
-- What it is about: a ticket, a management request or a partner request, both
-- or neither; what failed, from the compensation reasons (ADR 0058).
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_source_shape"
  CHECK ((("source_type" IS NULL) = ("source_id" IS NULL))
     AND ("source_type" IS NULL
          OR "source_type" IN ('ticket', 'management_request', 'partner_request'))
     AND ("failure_code" IS NULL
          OR "failure_code" IN ('service_outage', 'maintenance_delay', 'facility_closure', 'other')));
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_text_length"
  CHECK (("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000)
     AND ("outcome_note" IS NULL OR char_length("outcome_note") BETWEEN 1 AND 1000));
-- Open: nobody closed it. Closed: by someone, at a time, with an outcome.
ALTER TABLE "experience_cases" ADD CONSTRAINT "experience_cases_closed_shape"
  CHECK ((("status" = 'closed') = ("closed_at" IS NOT NULL))
     AND (("closed_at" IS NULL) = ("closed_by_account_id" IS NULL))
     AND (("closed_at" IS NULL) = ("outcome" IS NULL))
     AND ("outcome_note" IS NULL OR "closed_at" IS NOT NULL)
     AND ("outcome" IS NULL
          OR "outcome" IN ('resolved', 'compensated', 'no_action_needed',
                           'resident_unreachable', 'resident_declined')));

-- Closed once: a closed case never changes; an open one keeps what it was
-- opened as (its unit, kind, origin, source, opener and time).
CREATE FUNCTION "experience_cases_closed_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'open'
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."number" <> OLD."number"
     OR NEW."unit_id" <> OLD."unit_id"
     OR NEW."kind" <> OLD."kind"
     OR NEW."origin" <> OLD."origin"
     OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."opened_by_account_id" IS DISTINCT FROM OLD."opened_by_account_id"
     OR NEW."opened_at" <> OLD."opened_at" THEN
    RAISE EXCEPTION 'an experience case is closed once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "experience_cases_closed_once" BEFORE UPDATE ON "experience_cases"
  FOR EACH ROW EXECUTE FUNCTION "experience_cases_closed_once"();

-- ----------------------------------------------------------------------------
-- A signal: a rule met for a unit, once per the newest item that met it (the
-- key), so two sweeps at once raise it once. It is linked to the unit's open
-- case (opened for it if there was none) in the transaction that raised it.
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_signals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "basis_id" UUID NOT NULL,
    "count" INTEGER NOT NULL,
    "window_days" INTEGER NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "case_id" UUID,
    CONSTRAINT "experience_signals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "experience_signals_tenant_id_id_key" ON "experience_signals"("tenant_id", "id");
CREATE UNIQUE INDEX "experience_signals_basis_key"
  ON "experience_signals"("tenant_id", "unit_id", "code", "basis_id");
CREATE INDEX "experience_signals_list_idx"
  ON "experience_signals"("tenant_id", "detected_at" DESC, "id" DESC);
CREATE INDEX "experience_signals_case_idx" ON "experience_signals"("tenant_id", "case_id");
ALTER TABLE "experience_signals" ADD CONSTRAINT "experience_signals_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_signals" ADD CONSTRAINT "experience_signals_tenant_id_case_id_fkey"
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "experience_cases"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_signals" ADD CONSTRAINT "experience_signals_known"
  CHECK ("code" IN ('repeated_low_ratings', 'reopened_tickets', 'repeated_complaints')
     AND "count" BETWEEN 1 AND 10000
     AND "window_days" BETWEEN 7 AND 365);
-- Raised once; its case is set once, and only that.
CREATE FUNCTION "experience_signals_linked_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."case_id" IS NOT NULL
     OR NEW."case_id" IS NULL
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."unit_id" <> OLD."unit_id"
     OR NEW."code" <> OLD."code"
     OR NEW."basis_id" <> OLD."basis_id"
     OR NEW."count" <> OLD."count"
     OR NEW."window_days" <> OLD."window_days"
     OR NEW."detected_at" <> OLD."detected_at" THEN
    RAISE EXCEPTION 'an experience signal is linked to its case once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "experience_signals_linked_once" BEFORE UPDATE ON "experience_signals"
  FOR EACH ROW EXECUTE FUNCTION "experience_signals_linked_once"();

-- ----------------------------------------------------------------------------
-- The compensation rules: what the compound recommends for a failure, one
-- row per failure code (none: no recommendation). A credit names its amount.
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_compensation_rules" (
    "tenant_id" UUID NOT NULL,
    "failure_code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experience_compensation_rules_pkey" PRIMARY KEY ("tenant_id", "failure_code")
);
ALTER TABLE "experience_compensation_rules" ADD CONSTRAINT "experience_compensation_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensation_rules" ADD CONSTRAINT "experience_compensation_rules_shape"
  CHECK ("failure_code" IN ('service_outage', 'maintenance_delay', 'facility_closure', 'other')
     AND "kind" IN ('credit', 'apology', 'redo', 'priority')
     AND (("kind" = 'credit') = ("amount" IS NOT NULL))
     AND ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 999999999.99)));

-- ----------------------------------------------------------------------------
-- A compensation proposed on an open case, decided once by the manager. An
-- approved credit is the credit note finance issued for it on one of the
-- unit's invoices, and, above the board's binding threshold, the board's
-- authorization it used (ADR 0073). The other kinds move no money.
-- ----------------------------------------------------------------------------
CREATE TABLE "experience_compensations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "failure_code" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposed_by_account_id" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "credit_note_id" UUID,
    "authorization_id" UUID,
    CONSTRAINT "experience_compensations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "experience_compensations_tenant_id_id_key"
  ON "experience_compensations"("tenant_id", "id");
-- A credit note serves one compensation, and an authorization too.
CREATE UNIQUE INDEX "experience_compensations_credit_note_key"
  ON "experience_compensations"("tenant_id", "credit_note_id");
CREATE UNIQUE INDEX "experience_compensations_authorization_key"
  ON "experience_compensations"("tenant_id", "authorization_id");
CREATE INDEX "experience_compensations_case_idx"
  ON "experience_compensations"("tenant_id", "case_id", "proposed_at");
CREATE INDEX "experience_compensations_list_idx"
  ON "experience_compensations"("tenant_id", "status", "proposed_at", "id");
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_case_id_fkey"
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "experience_cases"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_proposed_by_fkey"
  FOREIGN KEY ("tenant_id", "proposed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_credit_note_fkey"
  FOREIGN KEY ("tenant_id", "credit_note_id") REFERENCES "credit_notes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_tenant_id_authorization_fkey"
  FOREIGN KEY ("tenant_id", "authorization_id") REFERENCES "finance_board_authorizations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_known"
  CHECK ("kind" IN ('credit', 'apology', 'redo', 'priority')
     AND "failure_code" IN ('service_outage', 'maintenance_delay', 'facility_closure', 'other')
     AND "status" IN ('proposed', 'approved', 'rejected'));
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_amount_shape"
  CHECK ((("kind" = 'credit') = ("amount" IS NOT NULL))
     AND ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 999999999.99))
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000));
-- Proposed: nobody decided it. Decided: by someone, at a time. A rejection
-- has its reason; an approved credit its credit note; only an approved
-- credit may name the board's authorization.
ALTER TABLE "experience_compensations" ADD CONSTRAINT "experience_compensations_decided_shape"
  CHECK ((("status" = 'proposed') = ("decided_at" IS NULL))
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('not_justified', 'already_compensated', 'outside_policy', 'other'))
     AND (("status" = 'approved' AND "kind" = 'credit') = ("credit_note_id" IS NOT NULL))
     AND ("authorization_id" IS NULL OR "credit_note_id" IS NOT NULL));

-- Decided once: a decided compensation never changes; a proposed one keeps
-- its terms.
CREATE FUNCTION "experience_compensations_decided_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'proposed'
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."case_id" <> OLD."case_id"
     OR NEW."unit_id" <> OLD."unit_id"
     OR NEW."kind" <> OLD."kind"
     OR NEW."failure_code" <> OLD."failure_code"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."proposed_by_account_id" <> OLD."proposed_by_account_id"
     OR NEW."proposed_at" <> OLD."proposed_at" THEN
    RAISE EXCEPTION 'a compensation is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "experience_compensations_decided_once" BEFORE UPDATE ON "experience_compensations"
  FOR EACH ROW EXECUTE FUNCTION "experience_compensations_decided_once"();

-- ----------------------------------------------------------------------------
-- The service promises register: what the compound promises its residents,
-- in both languages, and the target, measured where the data exists (a
-- metric); a promise with no metric is listed, not measured. Retired with
-- `active`, never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "service_promises" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "metric" TEXT,
    "target" DECIMAL(8,2),
    "target_share" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "service_promises_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_promises_tenant_id_id_key" ON "service_promises"("tenant_id", "id");
CREATE INDEX "service_promises_list_idx" ON "service_promises"("tenant_id", "created_at", "id");
ALTER TABLE "service_promises" ADD CONSTRAINT "service_promises_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "service_promises" ADD CONSTRAINT "service_promises_text_length"
  CHECK (char_length("title_en") BETWEEN 1 AND 200 AND char_length("title_ar") BETWEEN 1 AND 200);
-- Hours within a share of the items (1–8760 h, 1–100 %); an average rating
-- of at least the target (1–5), no share; no metric, no target.
ALTER TABLE "service_promises" ADD CONSTRAINT "service_promises_target_shape"
  CHECK (("metric" IS NULL AND "target" IS NULL AND "target_share" IS NULL)
      OR ("metric" IS NOT NULL AND "target" IS NOT NULL AND "target_share" IS NOT NULL
          AND "metric" IN ('ticket_resolution_hours', 'request_response_hours')
          AND "target" BETWEEN 1 AND 8760 AND "target_share" BETWEEN 1 AND 100)
      OR ("metric" IS NOT NULL AND "target" IS NOT NULL AND "target_share" IS NULL
          AND "metric" IN ('ticket_rating', 'request_rating', 'partner_rating')
          AND "target" BETWEEN 1 AND 5));

-- ----------------------------------------------------------------------------
-- Grants and RLS. Settings are set and rules set and removed; counters taken;
-- cases, signals, compensations and promises written and updated, never deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "experience_settings", "experience_counters", "experience_cases",
  "experience_signals", "experience_compensation_rules", "experience_compensations",
  "service_promises" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "experience_settings", "experience_counters", "experience_cases",
  "experience_signals", "experience_compensations", "service_promises" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "experience_compensation_rules" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['experience_settings', 'experience_counters', 'experience_cases',
    'experience_signals', 'experience_compensation_rules', 'experience_compensations',
    'service_promises'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
