-- ============================================================================
-- Formal notices (ADR 0058): a decision about a unit that must be proven
-- delivered and read, kept for good as the compound's record. One per type
-- and subject (a late payment: one per invoice). Each recipient has its
-- proofs: the inbox row written at issue, the email's sending (copied by
-- the outbox, whose rows go after 30 days) and the first opening, each set
-- once. Codes, amounts and dates only.
-- ============================================================================

CREATE TABLE "formal_notice_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "formal_notice_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "formal_notice_counters"
  ADD CONSTRAINT "formal_notice_counters_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "formal_notice_counters_last_number_nonnegative"
    CHECK ("last_number" >= 0);

CREATE TABLE "formal_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "unit_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "amount" DECIMAL(12, 2) NOT NULL,
    "due_on" DATE NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "formal_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "formal_notices_tenant_id_id_key" ON "formal_notices"("tenant_id", "id");
CREATE UNIQUE INDEX "formal_notices_tenant_id_number_key" ON "formal_notices"("tenant_id", "number");
CREATE UNIQUE INDEX "formal_notices_one_per_subject"
  ON "formal_notices"("tenant_id", "type", "subject_type", "subject_id");
CREATE INDEX "formal_notices_issued_idx" ON "formal_notices"("tenant_id", "issued_at" DESC, "id" DESC);
ALTER TABLE "formal_notices"
  ADD CONSTRAINT "formal_notices_unit_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "formal_notices_type_known" CHECK ("type" IN ('late_payment')),
  ADD CONSTRAINT "formal_notices_subject_known" CHECK ("subject_type" IN ('invoice')),
  ADD CONSTRAINT "formal_notices_number_positive" CHECK ("number" > 0),
  ADD CONSTRAINT "formal_notices_amount_positive" CHECK ("amount" > 0);

CREATE TABLE "formal_notice_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailed_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    CONSTRAINT "formal_notice_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "formal_notice_recipients_tenant_id_id_key"
  ON "formal_notice_recipients"("tenant_id", "id");
CREATE UNIQUE INDEX "formal_notice_recipients_once"
  ON "formal_notice_recipients"("tenant_id", "notice_id", "account_id");
CREATE INDEX "formal_notice_recipients_account_idx"
  ON "formal_notice_recipients"("tenant_id", "account_id", "delivered_at" DESC, "id" DESC);
ALTER TABLE "formal_notice_recipients"
  ADD CONSTRAINT "formal_notice_recipients_notice_fkey"
    FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "formal_notices"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "formal_notice_recipients_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "formal_notice_recipients_proofs_after_delivery"
    CHECK (("emailed_at" IS NULL OR "emailed_at" >= "delivered_at")
       AND ("read_at" IS NULL OR "read_at" >= "delivered_at"));

-- A notice is never changed or removed.
CREATE OR REPLACE FUNCTION formal_notice_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'formal_notices: a notice is the compound''s record and never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER formal_notices_immutable_rows
  BEFORE UPDATE OR DELETE ON "formal_notices"
  FOR EACH ROW EXECUTE FUNCTION formal_notice_is_immutable();
CREATE TRIGGER formal_notices_immutable_truncate
  BEFORE TRUNCATE ON "formal_notices"
  FOR EACH STATEMENT EXECUTE FUNCTION formal_notice_is_immutable();

-- A recipient's proofs are each set once; nothing else moves.
CREATE OR REPLACE FUNCTION formal_notice_recipient_proofs_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."notice_id" = OLD."notice_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."delivered_at" = OLD."delivered_at"
     AND (OLD."emailed_at" IS NULL OR NEW."emailed_at" = OLD."emailed_at")
     AND (OLD."read_at" IS NULL OR NEW."read_at" = OLD."read_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'formal_notice_recipients: a proof is set once and kept (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER formal_notice_recipients_proofs_once
  BEFORE UPDATE OR DELETE ON "formal_notice_recipients"
  FOR EACH ROW EXECUTE FUNCTION formal_notice_recipient_proofs_once();
CREATE TRIGGER formal_notice_recipients_no_truncate
  BEFORE TRUNCATE ON "formal_notice_recipients"
  FOR EACH STATEMENT EXECUTE FUNCTION formal_notice_recipient_proofs_once();

-- The outbox names the recipient whose email it carries (a pointer, like
-- recipient_account_id): marking it sent records the proof.
ALTER TABLE "outbox_messages" ADD COLUMN "formal_notice_recipient_id" UUID;

-- The cure period before a late-payment notice (ADR 0058): days after the
-- due date, 0 to 60.
ALTER TABLE "finance_settings"
  ADD COLUMN "late_notice_cure_days" SMALLINT NOT NULL DEFAULT 14;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_late_notice_cure_days"
  CHECK ("late_notice_cure_days" BETWEEN 0 AND 60);

REVOKE ALL ON "formal_notice_counters", "formal_notices", "formal_notice_recipients" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "formal_notice_counters" TO jiwar_app;
GRANT SELECT, INSERT ON "formal_notices" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "formal_notice_recipients" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['formal_notice_counters', 'formal_notices', 'formal_notice_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
