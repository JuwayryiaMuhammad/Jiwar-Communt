-- ============================================================================
-- Facility bans (ADR 0067): one account kept from booking one facility, or
-- every one, by the staff with a reason code — until a day of the
-- compound's (inclusive), or until lifted. Beside a unit's no-show
-- suspension (ADR 0044), not built on it: an account, not a unit; started
-- by the staff, not the system; no board appeal. A ban cancels the
-- account's bookings in its scope that have not started, as the staff
-- cancel one (`facility_ban`), each pointing at it. Only the lift changes a
-- ban, once (trigger); never deleted. No free text.
-- ============================================================================

CREATE TABLE "facility_bans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "facility_id" UUID,
    "reason_code" TEXT NOT NULL,
    "ends_on" DATE,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by_account_id" UUID,
    "lift_reason_code" TEXT,
    CONSTRAINT "facility_bans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facility_bans_tenant_id_id_key" ON "facility_bans"("tenant_id", "id");
-- One ban not lifted per account and scope (a facility, or all of them): a
-- ban that has ended is lifted by the system (`ended`) when the next one
-- starts, under the account's FOR UPDATE.
CREATE UNIQUE INDEX "facility_bans_open_key"
  ON "facility_bans"("tenant_id", "account_id", COALESCE("facility_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "lifted_at" IS NULL;
CREATE INDEX "facility_bans_list_idx" ON "facility_bans"("tenant_id", "created_at", "id");
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_facility_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_lifted_by_fkey"
  FOREIGN KEY ("tenant_id", "lifted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.facilityBan; a unit test keeps the two in step.
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_reason_known"
  CHECK ("reason_code" IN ('rules_violation', 'damage', 'safety', 'misconduct', 'other'));
-- Lifted once, with a reason: the staff's (REASON_CODES.facilityBanLift),
-- or the system's `ended`, by nobody. An erasure may null who.
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_lifted_shape"
  CHECK (("lifted_at" IS NULL) = ("lift_reason_code" IS NULL)
     AND ("lifted_by_account_id" IS NULL OR "lifted_at" IS NOT NULL)
     AND ("lifted_by_account_id" IS NULL OR "lift_reason_code" <> 'ended'));
ALTER TABLE "facility_bans" ADD CONSTRAINT "facility_bans_lift_reason_known"
  CHECK ("lift_reason_code" IS NULL
      OR "lift_reason_code" IN ('staff_error', 'exception_granted', 'other', 'ended'));

CREATE FUNCTION facility_ban_keeps_its_scope() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."facility_id" IS NOT DISTINCT FROM OLD."facility_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."ends_on" IS NOT DISTINCT FROM OLD."ends_on"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id"
          OR NEW."created_by_account_id" IS NULL)
     AND (
       (NEW."lifted_at" IS NOT DISTINCT FROM OLD."lifted_at"
        AND NEW."lift_reason_code" IS NOT DISTINCT FROM OLD."lift_reason_code"
        AND (NEW."lifted_by_account_id" IS NOT DISTINCT FROM OLD."lifted_by_account_id"
             OR NEW."lifted_by_account_id" IS NULL))
       OR OLD."lifted_at" IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'facility_bans: a ban keeps its account, scope and end, and is lifted once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER facility_bans_keep_scope
  BEFORE UPDATE OR DELETE ON "facility_bans"
  FOR EACH ROW EXECUTE FUNCTION facility_ban_keeps_its_scope();
CREATE TRIGGER facility_bans_keep_scope_truncate
  BEFORE TRUNCATE ON "facility_bans"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A booking a ban cancelled points at it; the staff's reasons gain
-- `facility_ban`, which only a ban gives (it is not on the dashboards'
-- list, REASON_CODES.bookingStaffCancel).
-- ----------------------------------------------------------------------------
ALTER TABLE "bookings" ADD COLUMN "ban_id" UUID;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tenant_id_ban_id_fkey"
  FOREIGN KEY ("tenant_id", "ban_id") REFERENCES "facility_bans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "bookings_ban_idx" ON "bookings"("tenant_id", "ban_id") WHERE "ban_id" IS NOT NULL;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ban"
  CHECK (("ban_id" IS NOT NULL) = ("cancel_reason" IS NOT DISTINCT FROM 'facility_ban')
     AND ("ban_id" IS NULL
          OR ("status" = 'cancelled' AND "cancelled_side" IS NOT DISTINCT FROM 'staff')));
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cancel_reason";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR ("cancelled_side" = 'resident' AND "cancel_reason" IN ('no_longer_needed', 'cannot_attend', 'other'))
      OR ("cancelled_side" = 'staff' AND "cancel_reason" IN ('facility_unavailable', 'rules_violation', 'resident_request', 'other', 'facility_ban'))
      OR ("cancelled_side" = 'system' AND "cancel_reason" IN ('facility_closed', 'approval_expired', 'booker_left')));

-- ----------------------------------------------------------------------------
-- Grants: a ban changes in place (its lift) under FOR UPDATE. RLS, FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "facility_bans" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facility_bans" TO jiwar_app;

ALTER TABLE "facility_bans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "facility_bans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "facility_bans"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
