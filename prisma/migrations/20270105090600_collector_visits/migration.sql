-- ============================================================================
-- R11c-1a (ADR 0069): a field collector's visit to take cash at a unit.
--
-- Whoever pays a unit's money asks for a visit in a window (1 to 4 hours,
-- from tomorrow, within 14 days); the accountant assigns a collector
-- (`finance.collect`); the collector records the cash taken — an office
-- payment with its receipt, at most what the unit owes plus the compound's
-- small margin, so a mistyped figure never makes a large credit — or why
-- the visit failed, and may offer another window, which the resident takes
-- as a new visit. One visit is open for a unit at a time. The collector
-- sees the unit, its building, the window and the amount expected: never a
-- phone, a name or a balance.
-- ============================================================================

ALTER TABLE "finance_settings"
  ADD COLUMN "collector_margin" DECIMAL(12,2) NOT NULL DEFAULT 50.00;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_collector_margin"
  CHECK ("collector_margin" BETWEEN 0 AND 1000);

CREATE TABLE "collector_visits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "window_starts_at" TIMESTAMPTZ(3) NOT NULL,
    "window_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "expected_amount" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'requested',
    "collector_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "payment_id" UUID,
    "fail_reason" TEXT,
    "offered_starts_at" TIMESTAMPTZ(3),
    "offered_ends_at" TIMESTAMPTZ(3),
    "follows_id" UUID,
    "cancel_side" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "collector_visits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collector_visits_tenant_id_id_key"
  ON "collector_visits"("tenant_id", "id");
-- One visit open for a unit at a time.
CREATE UNIQUE INDEX "collector_visits_one_open"
  ON "collector_visits"("tenant_id", "unit_id") WHERE "status" IN ('requested', 'assigned');
-- An offered window is taken once.
CREATE UNIQUE INDEX "collector_visits_follows_key"
  ON "collector_visits"("tenant_id", "follows_id") WHERE "follows_id" IS NOT NULL;
CREATE UNIQUE INDEX "collector_visits_payment_key"
  ON "collector_visits"("tenant_id", "payment_id") WHERE "payment_id" IS NOT NULL;
CREATE INDEX "collector_visits_unit_idx"
  ON "collector_visits"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "collector_visits_collector_idx"
  ON "collector_visits"("tenant_id", "collector_id", "window_starts_at", "id");
CREATE INDEX "collector_visits_queue_idx"
  ON "collector_visits"("tenant_id", "status", "window_starts_at", "id");
ALTER TABLE "collector_visits"
  ADD CONSTRAINT "collector_visits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "collector_visits_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "collector_visits_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "collector_visits_collector_fkey"
  FOREIGN KEY ("tenant_id", "collector_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "collector_visits_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "collector_visits_follows_fkey"
  FOREIGN KEY ("tenant_id", "follows_id") REFERENCES "collector_visits"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "collector_visits" ADD CONSTRAINT "collector_visits_window"
  CHECK ("window_ends_at" > "window_starts_at"
     AND "window_ends_at" - "window_starts_at" <= interval '4 hours');
ALTER TABLE "collector_visits" ADD CONSTRAINT "collector_visits_expected_amount"
  CHECK ("expected_amount" IS NULL OR "expected_amount" > 0);
ALTER TABLE "collector_visits" ADD CONSTRAINT "collector_visits_reasons"
  CHECK (("fail_reason" IS NULL
          OR "fail_reason" IN ('not_home', 'refused', 'no_cash', 'no_access', 'other'))
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('resident_asked', 'no_collector', 'paid_otherwise', 'other'))
     AND ("cancel_side" IS NULL OR "cancel_side" IN ('resident', 'staff')));
ALTER TABLE "collector_visits" ADD CONSTRAINT "collector_visits_offer"
  CHECK (("offered_starts_at" IS NULL) = ("offered_ends_at" IS NULL)
     AND ("offered_starts_at" IS NULL OR "status" = 'failed')
     AND ("offered_ends_at" IS NULL OR "offered_starts_at" IS NULL
          OR ("offered_ends_at" > "offered_starts_at"
              AND "offered_ends_at" - "offered_starts_at" <= interval '4 hours')));
-- What each status carries. A resident's cancel has no reason; the staff's has one.
ALTER TABLE "collector_visits" ADD CONSTRAINT "collector_visits_state_shape"
  CHECK (CASE "status"
    WHEN 'requested' THEN "collector_id" IS NULL AND "assigned_at" IS NULL
                      AND "payment_id" IS NULL AND "fail_reason" IS NULL
                      AND "cancel_side" IS NULL AND "closed_at" IS NULL
    WHEN 'assigned' THEN "collector_id" IS NOT NULL AND "assigned_at" IS NOT NULL
                     AND "payment_id" IS NULL AND "fail_reason" IS NULL
                     AND "cancel_side" IS NULL AND "closed_at" IS NULL
    WHEN 'collected' THEN "collector_id" IS NOT NULL AND "payment_id" IS NOT NULL
                      AND "fail_reason" IS NULL AND "cancel_side" IS NULL
                      AND "closed_at" IS NOT NULL
    WHEN 'failed' THEN "collector_id" IS NOT NULL AND "payment_id" IS NULL
                   AND "fail_reason" IS NOT NULL AND "cancel_side" IS NULL
                   AND "closed_at" IS NOT NULL
    WHEN 'cancelled' THEN "payment_id" IS NULL AND "fail_reason" IS NULL
                      AND "cancel_side" IS NOT NULL AND "closed_at" IS NOT NULL
                      AND ("cancel_side" = 'staff') = ("cancel_reason" IS NOT NULL)
    ELSE false END);

-- A visit moves forward once it closes; what was asked never changes.
CREATE FUNCTION collector_visit_moves_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'collector_visits rows are never deleted';
  END IF;
  IF OLD."status" NOT IN ('requested', 'assigned') THEN
    RAISE EXCEPTION 'a closed collector visit never changes';
  END IF;
  IF OLD."status" = 'assigned' AND NEW."status" = 'requested' THEN
    RAISE EXCEPTION 'an assigned collector visit does not go back';
  END IF;
  IF NEW."unit_id" IS DISTINCT FROM OLD."unit_id"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."window_starts_at" IS DISTINCT FROM OLD."window_starts_at"
     OR NEW."window_ends_at" IS DISTINCT FROM OLD."window_ends_at"
     OR NEW."expected_amount" IS DISTINCT FROM OLD."expected_amount"
     OR NEW."follows_id" IS DISTINCT FROM OLD."follows_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'what a collector visit asked never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collector_visits_move_forward
  BEFORE UPDATE OR DELETE ON "collector_visits"
  FOR EACH ROW EXECUTE FUNCTION collector_visit_moves_forward();
CREATE TRIGGER collector_visits_no_truncate
  BEFORE TRUNCATE ON "collector_visits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Grants: moved forward in place under FOR UPDATE; never deleted.
REVOKE ALL ON "collector_visits" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "collector_visits" TO jiwar_app;
ALTER TABLE "collector_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collector_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "collector_visits"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
