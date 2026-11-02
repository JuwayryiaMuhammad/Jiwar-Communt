-- ============================================================================
-- Custody (ADR 0085, the owner's decision C1). A collector's or a cashier's
-- custody is the office cash payments they recorded and have not handed
-- in: read from finance_payments, never copied. A hand-in, recorded by a
-- `finance.payments` holder who is not the custodian, takes every one of
-- them at once into a cash box, with what was counted; a count that
-- differs from what was expected is a variance, with its reason, and the
-- hand-in stays open until the variance is settled — by the manager, or
-- through an investigation with an owner, a due day and an outcome.
-- ============================================================================

-- Custody counts from here: older cash payments were handed in on paper.
ALTER TABLE "finance_settings" ADD COLUMN "custody_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- (20270609090000 restores this after ADR 0089's later-dated recreation.)
ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit', 'handin'));

-- A custodian's open cash payments, oldest first: what custody reads.
CREATE INDEX "finance_payments_custody_idx"
  ON "finance_payments"("tenant_id", "recorded_by_account_id", "created_at", "id")
  WHERE "kind" = 'payment' AND "channel" = 'office' AND "method" = 'cash';

CREATE TABLE "finance_custody_handins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "custodian_account_id" UUID NOT NULL,
    "received_by_account_id" UUID NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "expected" DECIMAL(14,2) NOT NULL,
    "counted" DECIMAL(14,2) NOT NULL,
    "variance" DECIMAL(14,2) NOT NULL,
    "variance_reason" TEXT,
    "payment_count" INTEGER NOT NULL,
    "received_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "recovered" DECIMAL(14,2),
    "resolved_by_account_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_custody_handins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_custody_handins_tenant_id_id_key" ON "finance_custody_handins"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_custody_handins_number_key" ON "finance_custody_handins"("tenant_id", "number");
CREATE INDEX "finance_custody_handins_list_idx"
  ON "finance_custody_handins"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "finance_custody_handins_custodian_idx"
  ON "finance_custody_handins"("tenant_id", "custodian_account_id", "created_at" DESC);
-- The inbox's: variances not yet settled, oldest first.
CREATE INDEX "finance_custody_handins_variance_idx"
  ON "finance_custody_handins"("tenant_id", "created_at", "id") WHERE "status" = 'variance';
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_custodian_fkey"
  FOREIGN KEY ("tenant_id", "custodian_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_received_by_fkey"
  FOREIGN KEY ("tenant_id", "received_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_resolved_by_fkey"
  FOREIGN KEY ("tenant_id", "resolved_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_cash_account_fkey"
  FOREIGN KEY ("tenant_id", "cash_account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Nobody receives their own cash.
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_not_self"
  CHECK ("custodian_account_id" <> "received_by_account_id");
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_amounts"
  CHECK ("number" > 0 AND "payment_count" > 0 AND "expected" > 0 AND "counted" >= 0
     AND "variance" = "counted" - "expected");
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_status_known"
  CHECK ("status" IN ('balanced', 'variance', 'resolved'));
-- A count as expected is balanced, with no reason; a variance has its
-- reason and is open until settled once, by someone, with an outcome; only
-- a shortage is recovered, never beyond it.
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_state_shape"
  CHECK ((("variance" = 0) = ("variance_reason" IS NULL))
     AND (("variance" = 0) = ("status" = 'balanced'))
     AND (("status" = 'resolved') = ("outcome" IS NOT NULL))
     AND (("status" = 'resolved') = ("resolved_at" IS NOT NULL))
     AND (("status" = 'resolved') = ("resolved_by_account_id" IS NOT NULL)));
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_recovered_shape"
  CHECK (("outcome" IS NOT NULL AND "outcome" = 'recovered') = ("recovered" IS NOT NULL)
     AND ("recovered" IS NULL OR ("recovered" > 0 AND "recovered" <= -"variance")));
-- REASON_CODES.custodyVariance and .custodyOutcome; a unit test keeps them in step.
ALTER TABLE "finance_custody_handins" ADD CONSTRAINT "finance_custody_handins_codes"
  CHECK (("variance_reason" IS NULL
          OR "variance_reason" IN ('counting_error', 'missing_cash', 'excess_cash', 'change_given',
                                   'unrecorded_payment', 'other'))
     AND ("outcome" IS NULL OR "outcome" IN ('recovered', 'written_off', 'explained', 'other')));

-- The count is fixed; a variance is settled once, and nothing else moves.
CREATE FUNCTION "finance_custody_handins_settled_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'variance' OR NEW."status" <> 'resolved'
     OR NEW."number" <> OLD."number"
     OR NEW."custodian_account_id" <> OLD."custodian_account_id"
     OR NEW."received_by_account_id" <> OLD."received_by_account_id"
     OR NEW."cash_account_id" <> OLD."cash_account_id"
     OR NEW."expected" <> OLD."expected"
     OR NEW."counted" <> OLD."counted"
     OR NEW."variance" <> OLD."variance"
     OR NEW."variance_reason" IS DISTINCT FROM OLD."variance_reason"
     OR NEW."payment_count" <> OLD."payment_count"
     OR NEW."received_on" <> OLD."received_on"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'a hand-in keeps its count, and its variance is settled once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "finance_custody_handins_settled_once" BEFORE UPDATE ON "finance_custody_handins"
  FOR EACH ROW EXECUTE FUNCTION "finance_custody_handins_settled_once"();
CREATE TRIGGER "finance_custody_handins_no_delete"
  BEFORE DELETE ON "finance_custody_handins"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The payments a hand-in took: each once, ever (the key), each an office
-- cash payment its custodian recorded, at its own amount. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_custody_handin_items" (
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "handin_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "finance_custody_handin_items_pkey" PRIMARY KEY ("tenant_id", "payment_id")
);
CREATE INDEX "finance_custody_handin_items_handin_idx"
  ON "finance_custody_handin_items"("tenant_id", "handin_id");
ALTER TABLE "finance_custody_handin_items" ADD CONSTRAINT "finance_custody_handin_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handin_items" ADD CONSTRAINT "finance_custody_handin_items_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handin_items" ADD CONSTRAINT "finance_custody_handin_items_handin_fkey"
  FOREIGN KEY ("tenant_id", "handin_id") REFERENCES "finance_custody_handins"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_handin_items" ADD CONSTRAINT "finance_custody_handin_items_amount"
  CHECK ("amount" > 0);
CREATE TRIGGER finance_custody_handin_items_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_custody_handin_items"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_custody_handin_items_immutable_truncate
  BEFORE TRUNCATE ON "finance_custody_handin_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE FUNCTION finance_custody_item_is_custodians() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  p record;
  custodian uuid;
BEGIN
  SELECT x."kind", x."channel", x."method", x."amount", x."recorded_by_account_id" INTO p
    FROM "finance_payments" x WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = NEW."payment_id";
  SELECT h."custodian_account_id" INTO custodian
    FROM "finance_custody_handins" h WHERE h."tenant_id" = NEW."tenant_id" AND h."id" = NEW."handin_id";
  IF p."kind" IS DISTINCT FROM 'payment' OR p."channel" IS DISTINCT FROM 'office'
     OR p."method" IS DISTINCT FROM 'cash' OR p."amount" IS DISTINCT FROM NEW."amount"
     OR p."recorded_by_account_id" IS DISTINCT FROM custodian THEN
    RAISE EXCEPTION 'hand-in %: an item violates custody: an office cash payment its custodian recorded, whole', NEW."handin_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_custody_item_is_custodians
  BEFORE INSERT ON "finance_custody_handin_items"
  FOR EACH ROW EXECUTE FUNCTION finance_custody_item_is_custodians();

-- A hand-in's items add up to what it expected, and are as many as it says.
CREATE FUNCTION finance_custody_items_add_up() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  handin uuid;
  h record;
  n int;
  total numeric;
BEGIN
  handin := CASE TG_TABLE_NAME WHEN 'finance_custody_handins' THEN NEW."id" ELSE NEW."handin_id" END;
  SELECT x."expected", x."payment_count" INTO h
    FROM "finance_custody_handins" x WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = handin;
  SELECT count(*), COALESCE(SUM(i."amount"), 0) INTO n, total
    FROM "finance_custody_handin_items" i WHERE i."tenant_id" = NEW."tenant_id" AND i."handin_id" = handin;
  IF n <> h."payment_count" OR total <> h."expected" THEN
    RAISE EXCEPTION 'hand-in %: its items (% of %) do not add up to it', handin, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_custody_handins_items_add_up
  AFTER INSERT ON "finance_custody_handins" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_custody_items_add_up();
CREATE CONSTRAINT TRIGGER finance_custody_handin_items_add_up
  AFTER INSERT ON "finance_custody_handin_items" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_custody_items_add_up();

-- ----------------------------------------------------------------------------
-- An investigation of a hand-in's variance: one a hand-in, an owner, a due
-- day; decided once with an outcome, which settles the hand-in.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_custody_investigations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "handin_id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "opened_by_account_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "recovered" DECIMAL(14,2),
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_custody_investigations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_custody_investigations_tenant_id_id_key"
  ON "finance_custody_investigations"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_custody_investigations_one_per_handin"
  ON "finance_custody_investigations"("tenant_id", "handin_id");
CREATE INDEX "finance_custody_investigations_list_idx"
  ON "finance_custody_investigations"("tenant_id", "status", "due_on", "id");
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_handin_fkey"
  FOREIGN KEY ("tenant_id", "handin_id") REFERENCES "finance_custody_handins"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_status_known"
  CHECK ("status" IN ('open', 'decided'));
ALTER TABLE "finance_custody_investigations" ADD CONSTRAINT "finance_custody_investigations_decided_shape"
  CHECK ((("status" = 'decided') = ("outcome" IS NOT NULL))
     AND (("status" = 'decided') = ("decided_at" IS NOT NULL))
     AND (("status" = 'decided') = ("decided_by_account_id" IS NOT NULL))
     AND (("outcome" IS NOT NULL AND "outcome" = 'recovered') = ("recovered" IS NOT NULL))
     AND ("recovered" IS NULL OR "recovered" > 0)
     AND ("outcome" IS NULL OR "outcome" IN ('recovered', 'written_off', 'explained', 'other')));

CREATE FUNCTION "finance_custody_investigations_decided_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'open'
     OR NEW."handin_id" <> OLD."handin_id"
     OR NEW."owner_account_id" <> OLD."owner_account_id"
     OR NEW."due_on" <> OLD."due_on"
     OR NEW."opened_by_account_id" <> OLD."opened_by_account_id"
     OR NEW."opened_at" <> OLD."opened_at" THEN
    RAISE EXCEPTION 'an investigation is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "finance_custody_investigations_decided_once" BEFORE UPDATE ON "finance_custody_investigations"
  FOR EACH ROW EXECUTE FUNCTION "finance_custody_investigations_decided_once"();
CREATE TRIGGER "finance_custody_investigations_no_delete"
  BEFORE DELETE ON "finance_custody_investigations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- The movements' hand-in source.
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_handin_fkey"
  FOREIGN KEY ("tenant_id", "handin_id") REFERENCES "finance_custody_handins"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The staff inbox gains open custody (`finance.payments`) and unsettled
-- variances (`finance.custody`), beside every type on main. Later-dated
-- migrations recreate these CHECKs: 20270609090000 restores the whole set.
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'cash_custody', 'custody_variance'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'cash_custody', 'custody_variance'));

REVOKE ALL ON "finance_custody_handins", "finance_custody_handin_items",
  "finance_custody_investigations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_custody_handins" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_custody_handin_items" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_custody_investigations" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_custody_handins', 'finance_custody_handin_items',
                           'finance_custody_investigations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
