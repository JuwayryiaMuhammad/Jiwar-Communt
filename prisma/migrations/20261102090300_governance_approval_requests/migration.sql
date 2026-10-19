-- ============================================================================
-- Board matters (ADR 0055): approval requests. The manager or the
-- accountant puts a decision package to the board: a type, what it is
-- about (a budget or one of its lines, for the two budget types), the
-- context, the alternatives, the cost, the impact and attachments. The
-- package never changes. It moves forward once: approved or rejected by a
-- carried motion of the board (board_motions, next migration), or
-- withdrawn while pending; an approved one is implemented once (by its
-- decision, or marked by the manager). The overdue notice goes once.
--
-- governance_counters numbers requests (AR-) and appeals (BA-) beside
-- polls and elections: its kind becomes TEXT, so the contests' own enum
-- never takes kinds no contest has.
-- ============================================================================

ALTER TABLE "governance_counters" ALTER COLUMN "kind" TYPE TEXT USING "kind"::text;
ALTER TABLE "governance_counters" ADD CONSTRAINT "governance_counters_kind"
  CHECK ("kind" IN ('poll', 'election', 'approval', 'appeal'));

CREATE TABLE "governance_approval_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "subject_id" UUID,
    "raised_by_account_id" UUID NOT NULL,
    "context" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "cost" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_motion_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by_account_id" UUID,
    "withdraw_reason_code" TEXT,
    "implemented_at" TIMESTAMPTZ(3),
    "implemented_by_account_id" UUID,
    "implementation_note" TEXT,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_approval_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_approval_requests_tenant_id_id_key"
  ON "governance_approval_requests"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_approval_requests_number_key"
  ON "governance_approval_requests"("tenant_id", "number");
-- One pending request per subject: a budget, or a budget line.
CREATE UNIQUE INDEX "governance_approval_requests_one_pending"
  ON "governance_approval_requests"("tenant_id", "type", "subject_id")
  WHERE "status" = 'pending' AND "subject_id" IS NOT NULL;
CREATE INDEX "governance_approval_requests_status_idx"
  ON "governance_approval_requests"("tenant_id", "status", "created_at", "id");
CREATE INDEX "governance_approval_requests_created_idx"
  ON "governance_approval_requests"("tenant_id", "created_at", "id");
CREATE INDEX "governance_approval_requests_overdue_idx"
  ON "governance_approval_requests"("tenant_id", "deadline_at")
  WHERE "status" = 'pending' AND "overdue_notified_at" IS NULL;
ALTER TABLE "governance_approval_requests"
  ADD CONSTRAINT "governance_approval_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_requests_tenant_id_raised_by_fkey"
  FOREIGN KEY ("tenant_id", "raised_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_requests_tenant_id_withdrawn_by_fkey"
  FOREIGN KEY ("tenant_id", "withdrawn_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_requests_tenant_id_implemented_by_fkey"
  FOREIGN KEY ("tenant_id", "implemented_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- APPROVAL_TYPES; a unit test keeps them in step.
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation'));
-- A budget for an annual budget, one of its lines for an increase; nothing otherwise.
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_subject"
  CHECK (("subject_id" IS NOT NULL) = ("type" IN ('annual_budget', 'budget_increase')));
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_texts"
  CHECK (char_length("context") BETWEEN 1 AND 4000
     AND char_length("impact") BETWEEN 1 AND 2000
     AND ("implementation_note" IS NULL OR char_length("implementation_note") BETWEEN 1 AND 1000));
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_cost"
  CHECK (("cost" IS NULL OR ("cost" > 0 AND "cost" <= 999999999.99))
     AND "currency" = 'EGP');
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_number_positive"
  CHECK ("number" >= 1);
-- The status and the columns that say it, set together.
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_state_shape"
  CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn')
     AND ("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_motion_id" IS NULL)
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("withdrawn_at" IS NULL) = ("withdrawn_by_account_id" IS NULL)
     AND ("withdrawn_at" IS NULL) = ("withdraw_reason_code" IS NULL)
     AND ("implemented_at" IS NULL OR "status" = 'approved')
     AND ("implemented_by_account_id" IS NULL OR "implemented_at" IS NOT NULL)
     AND ("implementation_note" IS NULL OR "implemented_at" IS NOT NULL)
     AND ("overdue_notified_at" IS NULL OR "overdue_notified_at" >= "deadline_at"));
-- REASON_CODES.approvalWithdraw; a unit test keeps the two in step.
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_withdraw_reason"
  CHECK ("withdraw_reason_code" IS NULL
      OR "withdraw_reason_code" IN ('no_longer_needed', 'raised_in_error', 'superseded', 'other'));

-- The package never changes; the status moves from pending once; the
-- implementation and the overdue notice are written once each.
CREATE FUNCTION governance_approval_request_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."type" = OLD."type"
     AND NEW."subject_id" IS NOT DISTINCT FROM OLD."subject_id"
     AND NEW."raised_by_account_id" = OLD."raised_by_account_id"
     AND NEW."context" = OLD."context" AND NEW."impact" = OLD."impact"
     AND NEW."cost" IS NOT DISTINCT FROM OLD."cost"
     AND NEW."currency" = OLD."currency"
     AND NEW."deadline_at" = OLD."deadline_at"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status" OR OLD."status" = 'pending')
     AND (NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at" OR OLD."decided_at" IS NULL)
     AND (NEW."decided_motion_id" IS NOT DISTINCT FROM OLD."decided_motion_id" OR OLD."decided_motion_id" IS NULL)
     AND (NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at" OR OLD."withdrawn_at" IS NULL)
     AND (NEW."withdrawn_by_account_id" IS NOT DISTINCT FROM OLD."withdrawn_by_account_id" OR OLD."withdrawn_at" IS NULL)
     AND (NEW."withdraw_reason_code" IS NOT DISTINCT FROM OLD."withdraw_reason_code" OR OLD."withdrawn_at" IS NULL)
     AND (NEW."implemented_at" IS NOT DISTINCT FROM OLD."implemented_at" OR OLD."implemented_at" IS NULL)
     AND (NEW."implemented_by_account_id" IS NOT DISTINCT FROM OLD."implemented_by_account_id" OR OLD."implemented_at" IS NULL)
     AND (NEW."implementation_note" IS NOT DISTINCT FROM OLD."implementation_note" OR OLD."implemented_at" IS NULL)
     AND (NEW."overdue_notified_at" IS NOT DISTINCT FROM OLD."overdue_notified_at" OR OLD."overdue_notified_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_approval_requests: the package is kept and the request moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_approval_requests_moves
  BEFORE UPDATE OR DELETE ON "governance_approval_requests"
  FOR EACH ROW EXECUTE FUNCTION governance_approval_request_moves();
CREATE TRIGGER governance_approval_requests_moves_truncate
  BEFORE TRUNCATE ON "governance_approval_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The package's alternatives (0–5, in order) and attachments (0–5): written
-- with the request, never changed.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_approval_alternatives" (
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "text" TEXT NOT NULL,
    "cost" DECIMAL(14,2),
    CONSTRAINT "governance_approval_alternatives_pkey" PRIMARY KEY ("tenant_id", "request_id", "position")
);
ALTER TABLE "governance_approval_alternatives"
  ADD CONSTRAINT "governance_approval_alternatives_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_approval_alternatives" ADD CONSTRAINT "governance_approval_alternatives_shape"
  CHECK ("position" BETWEEN 1 AND 5
     AND char_length("text") BETWEEN 1 AND 1000
     AND ("cost" IS NULL OR ("cost" > 0 AND "cost" <= 999999999.99)));

CREATE TABLE "governance_approval_attachments" (
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    CONSTRAINT "governance_approval_attachments_pkey" PRIMARY KEY ("tenant_id", "request_id", "position")
);
CREATE UNIQUE INDEX "governance_approval_attachments_file_key"
  ON "governance_approval_attachments"("tenant_id", "file_id");
ALTER TABLE "governance_approval_attachments"
  ADD CONSTRAINT "governance_approval_attachments_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_approval_attachments" ADD CONSTRAINT "governance_approval_attachments_position"
  CHECK ("position" BETWEEN 1 AND 5);

CREATE TRIGGER governance_approval_alternatives_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_approval_alternatives"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_approval_alternatives_immutable_truncate
  BEFORE TRUNCATE ON "governance_approval_alternatives"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_approval_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_approval_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_approval_attachments_immutable_truncate
  BEFORE TRUNCATE ON "governance_approval_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "governance_approval_requests", "governance_approval_alternatives",
  "governance_approval_attachments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_approval_requests" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_approval_alternatives", "governance_approval_attachments" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_approval_requests', 'governance_approval_alternatives',
                           'governance_approval_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
