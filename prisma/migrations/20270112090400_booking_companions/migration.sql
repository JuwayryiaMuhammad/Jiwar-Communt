-- ============================================================================
-- Booking companions (ADR 0070): people who come with a booker — one of the
-- household, picked by the booker and asked to accept, or anyone of the
-- compound who opens the booking's share link. A companion holds a seat
-- from the invite: the booking's `companions` counts those invited or
-- accepted, and a slot counted in people takes the booker, the guests and
-- them; guests and companions together stay within the facility's
-- `max_guests`. The link is a random token whose hash the booking keeps;
-- it works until the start and is replaced when the booker rotates it.
-- A companion's booking, account and way in never change; it moves
-- invited → accepted | declined | removed, accepted → left | removed, once
-- each, and either live one to `cancelled` when its booking ends — however
-- it ends — with the booking's seats back to 0 (trigger); never deleted. No
-- free text: a removal has a code.
-- ============================================================================

ALTER TABLE "bookings" ADD COLUMN "companions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bookings" ADD COLUMN "companion_token_hash" TEXT;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_companions"
  CHECK ("companions" >= 0 AND "guests" + "companions" <= 50);
CREATE UNIQUE INDEX "bookings_companion_token_key"
  ON "bookings"("tenant_id", "companion_token_hash");

CREATE TABLE "booking_companions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "via" TEXT NOT NULL,
    "household_member_id" UUID,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "remove_reason" TEXT,
    CONSTRAINT "booking_companions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_companions_tenant_id_id_key" ON "booking_companions"("tenant_id", "id");
-- One live place per booking and account: checked first under the
-- booking's row lock (COMPANION_EXISTS); a violation is a race.
CREATE UNIQUE INDEX "booking_companions_live_key"
  ON "booking_companions"("tenant_id", "booking_id", "account_id")
  WHERE "status" IN ('invited', 'accepted');
CREATE INDEX "booking_companions_booking_idx" ON "booking_companions"("tenant_id", "booking_id", "created_at", "id");
CREATE INDEX "booking_companions_account_idx" ON "booking_companions"("tenant_id", "account_id", "created_at", "id");
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_booking_fkey"
  FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "bookings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_member_fkey"
  FOREIGN KEY ("tenant_id", "household_member_id") REFERENCES "household_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A household companion is picked by their member row; a link's is not.
-- Each status sets exactly its own columns. REASON_CODES.companionRemove.
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_shape"
  CHECK ("via" IN ('household', 'link')
     AND ("via" = 'household') = ("household_member_id" IS NOT NULL)
     AND "status" IN ('invited', 'accepted', 'declined', 'removed', 'left', 'cancelled')
     AND ("via" = 'household' OR "status" <> 'invited')
     AND ("status" IN ('invited', 'accepted')) = ("ended_at" IS NULL)
     AND ("status" = 'removed') = ("remove_reason" IS NOT NULL)
     AND ("status" NOT IN ('accepted', 'declined', 'left') OR "responded_at" IS NOT NULL)
     AND ("status" <> 'invited' OR "responded_at" IS NULL));
ALTER TABLE "booking_companions" ADD CONSTRAINT "booking_companions_remove_reason"
  CHECK ("remove_reason" IS NULL
      OR "remove_reason" IN ('not_coming', 'party_changed', 'misconduct', 'other'));

CREATE FUNCTION booking_companion_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."booking_id" = OLD."booking_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."via" = OLD."via"
     AND NEW."household_member_id" IS NOT DISTINCT FROM OLD."household_member_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'invited' AND NEW."status" IN ('accepted', 'declined', 'removed', 'cancelled'))
          OR (OLD."status" = 'accepted' AND NEW."status" IN ('left', 'removed', 'cancelled')))
     AND (NEW."status" <> OLD."status"
          OR (NEW."responded_at" IS NOT DISTINCT FROM OLD."responded_at"
              AND NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
              AND NEW."remove_reason" IS NOT DISTINCT FROM OLD."remove_reason")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_companions: a companion keeps its booking and account and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER booking_companions_move_forward
  BEFORE UPDATE OR DELETE ON "booking_companions"
  FOR EACH ROW EXECUTE FUNCTION booking_companion_moves_forward();
CREATE TRIGGER booking_companions_move_forward_truncate
  BEFORE TRUNCATE ON "booking_companions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "booking_companions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "booking_companions" TO jiwar_app;
ALTER TABLE "booking_companions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_companions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "booking_companions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
