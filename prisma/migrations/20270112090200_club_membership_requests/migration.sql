-- ============================================================================
-- Club membership requests (ADR 0070): a resident who books for a unit asks
-- for a plan of the club; its price is owed through a `club` invoice the
-- charges port raises at once. One request open per unit. Paid, the
-- membership starts or is extended — created when the unit had none,
-- covering the unit's people — by a payment record that points at the
-- charge and carries no receipt number (finance's receipt is the receipt)
-- and no recorder. Called off once, the charge is credited off. Its unit,
-- plan, requester and amount never change; it moves once (trigger); never
-- deleted. No free text.
-- ============================================================================

CREATE TABLE "club_membership_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "payment_record_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    CONSTRAINT "club_membership_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "club_membership_requests_tenant_id_id_key" ON "club_membership_requests"("tenant_id", "id");
-- One open request per unit: checked first under the unit's finance lock
-- (CLUB_REQUEST_OPEN); a violation is a race.
CREATE UNIQUE INDEX "club_membership_requests_open_key"
  ON "club_membership_requests"("tenant_id", "unit_id") WHERE "status" = 'requested';
CREATE UNIQUE INDEX "club_membership_requests_payment_key"
  ON "club_membership_requests"("tenant_id", "payment_record_id");
CREATE INDEX "club_membership_requests_unit_idx" ON "club_membership_requests"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "club_membership_requests_list_idx" ON "club_membership_requests"("tenant_id", "created_at", "id");
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "club_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_record_id") REFERENCES "club_payment_records"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
-- Each status sets exactly its own columns; a cancel is the requester's or
-- the unit's primary's.
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_state_shape"
  CHECK ("status" IN ('requested', 'paid', 'cancelled')
     AND ("status" = 'paid') = ("paid_at" IS NOT NULL)
     AND ("status" = 'paid') = ("payment_record_id" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancel_reason" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_by_account_id" IS NOT NULL));
-- REASON_CODES.clubRequestCancel; a unit test keeps the two in step.
ALTER TABLE "club_membership_requests" ADD CONSTRAINT "club_membership_requests_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('no_longer_needed', 'wrong_plan', 'other'));

CREATE FUNCTION club_membership_request_moves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."plan_id" = OLD."plan_id"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."status" = 'requested'
          OR (NEW."status" = OLD."status"
              AND NEW."paid_at" IS NOT DISTINCT FROM OLD."paid_at"
              AND NEW."payment_record_id" IS NOT DISTINCT FROM OLD."payment_record_id"
              AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
              AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason"
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'club_membership_requests: a request keeps its unit, plan and amount, and is paid or called off once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER club_membership_requests_move_once
  BEFORE UPDATE OR DELETE ON "club_membership_requests"
  FOR EACH ROW EXECUTE FUNCTION club_membership_request_moves_once();
CREATE TRIGGER club_membership_requests_move_once_truncate
  BEFORE TRUNCATE ON "club_membership_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "club_membership_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "club_membership_requests" TO jiwar_app;
ALTER TABLE "club_membership_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "club_membership_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "club_membership_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- A payment record a paid charge wrote points at it: no receipt number of
-- the club's (finance's receipt is the receipt) and no recorder (the
-- payment may come from the webhook). Every other payment keeps both.
-- ----------------------------------------------------------------------------
ALTER TABLE "club_payment_records" ADD COLUMN "charge_id" UUID;
ALTER TABLE "club_payment_records" ALTER COLUMN "recorded_by_account_id" DROP NOT NULL;
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_charge_fkey"
  FOREIGN KEY ("tenant_id", "charge_id") REFERENCES "finance_charges"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "club_payment_records_charge_key"
  ON "club_payment_records"("tenant_id", "charge_id");
ALTER TABLE "club_payment_records" DROP CONSTRAINT "club_payment_records_kind_shape";
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_kind_shape"
  CHECK (("kind" = 'payment') = ("plan_id" IS NOT NULL)
     AND ("kind" = 'payment') = ("amount" IS NOT NULL)
     AND ("kind" = 'payment') = ("currency" IS NOT NULL)
     AND ("kind" = 'payment' AND "charge_id" IS NULL) = ("receipt_number" IS NOT NULL)
     AND ("kind" = 'payment') = ("paid_on" IS NOT NULL)
     AND ("kind" = 'payment') = ("period_starts_on" IS NOT NULL)
     AND ("kind" = 'payment') = ("period_ends_on" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL)
     AND ("charge_id" IS NULL OR "kind" = 'payment')
     AND ("charge_id" IS NULL) = ("recorded_by_account_id" IS NOT NULL));
