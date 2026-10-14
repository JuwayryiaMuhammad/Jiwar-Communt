-- ============================================================================
-- Phase R5 — the club (ADR 0044). Plans, a unit's membership and whom it
-- covers, the payments made at the office (append-only: a wrong one is
-- reversed by a new record, never edited), and the reminder before a
-- membership ends. No free text.
-- ============================================================================

CREATE TYPE "club_duration_kind" AS ENUM ('monthly', 'quarterly', 'annual', 'custom');
CREATE TYPE "club_payment_kind" AS ENUM ('payment', 'reversal');

-- ----------------------------------------------------------------------------
-- Plans: never deleted (payments point at them); retired with `active`.
-- ----------------------------------------------------------------------------
CREATE TABLE "club_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "duration_kind" "club_duration_kind" NOT NULL,
    "duration_days" INTEGER,
    "price" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "club_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "club_plans_tenant_id_id_key" ON "club_plans"("tenant_id", "id");
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_duration"
  CHECK (("duration_kind" = 'custom') = ("duration_days" IS NOT NULL));
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_duration_days"
  CHECK ("duration_days" IS NULL OR "duration_days" BETWEEN 1 AND 730);
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_price"
  CHECK ("price" > 0 AND "price" <= 1000000);

-- ----------------------------------------------------------------------------
-- A unit's membership: one per unit. Payments and coverage lock its row.
-- ----------------------------------------------------------------------------
CREATE TABLE "club_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "club_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "club_memberships_tenant_id_id_key" ON "club_memberships"("tenant_id", "id");
CREATE UNIQUE INDEX "club_memberships_one_per_unit" ON "club_memberships"("tenant_id", "unit_id");
ALTER TABLE "club_memberships"
  ADD CONSTRAINT "club_memberships_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_memberships_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_memberships_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER club_memberships_immutable_rows
  BEFORE UPDATE OR DELETE ON "club_memberships"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER club_memberships_immutable_truncate
  BEFORE TRUNCATE ON "club_memberships"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Whom a membership covers: one of the unit's occupancies or household
-- members, added and later removed (once, trigger); never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "club_membership_people" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "occupancy_id" UUID,
    "household_member_id" UUID,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    CONSTRAINT "club_membership_people_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "club_membership_people_membership_idx"
  ON "club_membership_people"("tenant_id", "membership_id", "added_at", "id");
-- One open row per person.
CREATE UNIQUE INDEX "club_membership_people_one_open_occupancy"
  ON "club_membership_people"("tenant_id", "membership_id", "occupancy_id")
  WHERE "removed_at" IS NULL AND "occupancy_id" IS NOT NULL;
CREATE UNIQUE INDEX "club_membership_people_one_open_member"
  ON "club_membership_people"("tenant_id", "membership_id", "household_member_id")
  WHERE "removed_at" IS NULL AND "household_member_id" IS NOT NULL;
ALTER TABLE "club_membership_people"
  ADD CONSTRAINT "club_membership_people_tenant_id_membership_id_fkey"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "club_memberships"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_membership_people_tenant_id_occupancy_id_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_membership_people_tenant_id_household_member_id_fkey"
  FOREIGN KEY ("tenant_id", "household_member_id") REFERENCES "household_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_membership_people_tenant_id_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_membership_people_tenant_id_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "club_membership_people" ADD CONSTRAINT "club_membership_people_one_person"
  CHECK (("occupancy_id" IS NULL) <> ("household_member_id" IS NULL));
ALTER TABLE "club_membership_people" ADD CONSTRAINT "club_membership_people_removed_shape"
  CHECK (("removed_at" IS NULL) = ("removed_by_account_id" IS NULL));

CREATE FUNCTION club_person_keeps_its_place() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."membership_id" = OLD."membership_id"
     AND NEW."occupancy_id" IS NOT DISTINCT FROM OLD."occupancy_id"
     AND NEW."household_member_id" IS NOT DISTINCT FROM OLD."household_member_id"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."added_at" = OLD."added_at"
     AND (
       (NEW."removed_at" IS NOT DISTINCT FROM OLD."removed_at"
        AND NEW."removed_by_account_id" IS NOT DISTINCT FROM OLD."removed_by_account_id")
       OR OLD."removed_at" IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'club_membership_people: a covered person is removed once, never rewritten (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER club_membership_people_keep_place
  BEFORE UPDATE OR DELETE ON "club_membership_people"
  FOR EACH ROW EXECUTE FUNCTION club_person_keeps_its_place();
CREATE TRIGGER club_membership_people_keep_place_truncate
  BEFORE TRUNCATE ON "club_membership_people"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Payments and their reversals: append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "club_payment_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "kind" "club_payment_kind" NOT NULL,
    "plan_id" UUID,
    "amount" DECIMAL(10,2),
    "currency" TEXT,
    "receipt_number" TEXT,
    "paid_on" DATE,
    "period_starts_on" DATE,
    "period_ends_on" DATE,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "club_payment_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "club_payment_records_tenant_id_id_key" ON "club_payment_records"("tenant_id", "id");
CREATE UNIQUE INDEX "club_payment_records_one_reversal" ON "club_payment_records"("tenant_id", "reverses_id");
-- A receipt is recorded once in the compound.
CREATE UNIQUE INDEX "club_payment_records_receipt_key"
  ON "club_payment_records"("tenant_id", "receipt_number") WHERE "kind" = 'payment';
CREATE INDEX "club_payment_records_membership_idx"
  ON "club_payment_records"("tenant_id", "membership_id", "created_at", "id");
ALTER TABLE "club_payment_records"
  ADD CONSTRAINT "club_payment_records_tenant_id_membership_id_fkey"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "club_memberships"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_payment_records_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "club_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_payment_records_tenant_id_reverses_id_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "club_payment_records"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "club_payment_records_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A payment sets what it paid and for when; a reversal names the payment
-- and why. Nullable columns appear only under IS [NOT] NULL here.
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_kind_shape"
  CHECK (("kind" = 'payment') = ("plan_id" IS NOT NULL)
     AND ("kind" = 'payment') = ("amount" IS NOT NULL)
     AND ("kind" = 'payment') = ("currency" IS NOT NULL)
     AND ("kind" = 'payment') = ("receipt_number" IS NOT NULL)
     AND ("kind" = 'payment') = ("paid_on" IS NOT NULL)
     AND ("kind" = 'payment') = ("period_starts_on" IS NOT NULL)
     AND ("kind" = 'payment') = ("period_ends_on" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL));
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 1000000));
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_currency"
  CHECK ("currency" IS NULL OR "currency" = 'EGP');
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_receipt_shape"
  CHECK ("receipt_number" IS NULL OR "receipt_number" ~ '^[A-Za-z0-9/-]{1,40}$');
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_period"
  CHECK ("period_starts_on" IS NULL OR "period_ends_on" IS NULL
      OR ("period_ends_on" > "period_starts_on"
          AND "period_ends_on" <= "period_starts_on" + 731));
-- REASON_CODES.clubPaymentReverse; a unit test keeps the two in step.
ALTER TABLE "club_payment_records" ADD CONSTRAINT "club_payment_records_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('entered_in_error', 'duplicate', 'refunded', 'other'));
CREATE TRIGGER club_payment_records_immutable_rows
  BEFORE UPDATE OR DELETE ON "club_payment_records"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER club_payment_records_immutable_truncate
  BEFORE TRUNCATE ON "club_payment_records"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The reminder before a membership ends: once per end date. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "club_expiry_reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "ends_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "club_expiry_reminders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "club_expiry_reminders_once"
  ON "club_expiry_reminders"("tenant_id", "membership_id", "ends_on");
ALTER TABLE "club_expiry_reminders"
  ADD CONSTRAINT "club_expiry_reminders_tenant_id_membership_id_fkey"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "club_memberships"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER club_expiry_reminders_immutable_rows
  BEFORE UPDATE OR DELETE ON "club_expiry_reminders"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER club_expiry_reminders_immutable_truncate
  BEFORE TRUNCATE ON "club_expiry_reminders"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted; payments, reminders and
-- memberships are never updated either. A membership's row is locked FOR
-- UPDATE by a payment, which needs UPDATE: the trigger refuses any real
-- change.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "club_plans", "club_memberships", "club_membership_people",
  "club_payment_records", "club_expiry_reminders" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "club_plans", "club_memberships", "club_membership_people" TO jiwar_app;
GRANT SELECT, INSERT ON "club_payment_records", "club_expiry_reminders" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['club_plans', 'club_memberships', 'club_membership_people',
                           'club_payment_records', 'club_expiry_reminders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
