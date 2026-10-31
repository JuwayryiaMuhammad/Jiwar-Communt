-- ============================================================================
-- The booking waitlist (ADR 0070): a resident who books for a unit waits
-- for a full slot — at most three slots at once per account, one entry per
-- slot. Whatever frees room in it (a cancel, a rejection, a companion who
-- declines, leaves or is removed) offers it, under the slot's row lock, to
-- the waiting entries in the order they joined, one per freed place; the
-- offer holds that place for the compound's `waitlist_hold_minutes`, never
-- past fifteen minutes before the start (closer, entries lapse). A live
-- offer counts as taken; claimed, it becomes the entry's booking. The
-- sweep lapses an expired offer and offers the next; a closure closes the
-- entries it covers. An entry's slot, account, unit and party never
-- change; it moves waiting → offered → booked | lapsed | left | closed,
-- waiting → lapsed | left | closed, once each (trigger); never deleted.
-- ============================================================================

ALTER TABLE "facility_settings" ADD COLUMN "waitlist_hold_minutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "facility_settings" ADD CONSTRAINT "facility_settings_waitlist_hold"
  CHECK ("waitlist_hold_minutes" BETWEEN 5 AND 120);

CREATE TABLE "booking_waitlist_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "party_size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offered_at" TIMESTAMPTZ(3),
    "offer_expires_at" TIMESTAMPTZ(3),
    "booking_id" UUID,
    "ended_at" TIMESTAMPTZ(3),
    CONSTRAINT "booking_waitlist_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_waitlist_entries_tenant_id_id_key" ON "booking_waitlist_entries"("tenant_id", "id");
-- One live entry per account and slot: checked first under the slot's row
-- lock (WAITLIST_EXISTS); a violation is a race.
CREATE UNIQUE INDEX "booking_waitlist_entries_live_key"
  ON "booking_waitlist_entries"("tenant_id", "account_id", "facility_id", "starts_at")
  WHERE "status" IN ('waiting', 'offered');
CREATE UNIQUE INDEX "booking_waitlist_entries_booking_key"
  ON "booking_waitlist_entries"("tenant_id", "booking_id");
-- The order a slot's entries are offered in, and the sweep's due offers.
CREATE INDEX "booking_waitlist_entries_slot_idx"
  ON "booking_waitlist_entries"("tenant_id", "facility_id", "starts_at", "created_at", "id");
CREATE INDEX "booking_waitlist_entries_offer_idx"
  ON "booking_waitlist_entries"("tenant_id", "offer_expires_at") WHERE "status" = 'offered';
CREATE INDEX "booking_waitlist_entries_account_idx"
  ON "booking_waitlist_entries"("tenant_id", "account_id", "created_at", "id");
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_facility_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_booking_fkey"
  FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "bookings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Each status sets exactly its own columns.
ALTER TABLE "booking_waitlist_entries" ADD CONSTRAINT "booking_waitlist_entries_shape"
  CHECK ("party_size" BETWEEN 1 AND 51
     AND "status" IN ('waiting', 'offered', 'booked', 'lapsed', 'left', 'closed')
     AND ("offered_at" IS NULL) = ("offer_expires_at" IS NULL)
     AND ("status" <> 'waiting' OR "offered_at" IS NULL)
     AND ("status" NOT IN ('offered', 'booked') OR "offered_at" IS NOT NULL)
     AND ("status" = 'booked') = ("booking_id" IS NOT NULL)
     AND ("status" IN ('waiting', 'offered')) = ("ended_at" IS NULL));

CREATE FUNCTION booking_waitlist_entry_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."facility_id" = OLD."facility_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."party_size" = OLD."party_size"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'waiting' AND NEW."status" IN ('offered', 'lapsed', 'left', 'closed'))
          OR (OLD."status" = 'offered' AND NEW."status" IN ('booked', 'lapsed', 'left', 'closed')))
     AND (NEW."status" <> OLD."status"
          OR (NEW."offered_at" IS NOT DISTINCT FROM OLD."offered_at"
              AND NEW."offer_expires_at" IS NOT DISTINCT FROM OLD."offer_expires_at"
              AND NEW."booking_id" IS NOT DISTINCT FROM OLD."booking_id"
              AND NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_waitlist_entries: an entry keeps its slot and party and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER booking_waitlist_entries_move_forward
  BEFORE UPDATE OR DELETE ON "booking_waitlist_entries"
  FOR EACH ROW EXECUTE FUNCTION booking_waitlist_entry_moves_forward();
CREATE TRIGGER booking_waitlist_entries_move_forward_truncate
  BEFORE TRUNCATE ON "booking_waitlist_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "booking_waitlist_entries" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "booking_waitlist_entries" TO jiwar_app;
ALTER TABLE "booking_waitlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_waitlist_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "booking_waitlist_entries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
