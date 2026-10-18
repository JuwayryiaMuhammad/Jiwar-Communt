-- ============================================================================
-- Children (ADR 0054): a child's exit control.
-- ============================================================================
--
-- The primary or a household delegate turns it on for one of the unit's
-- minors (a membership without an account, ADR 0016/0021). One row is one
-- period of control: turned on, then ended once, by the household, by the
-- child leaving the household or by the child coming of age. Turning it on
-- again is a new row; nothing is ever deleted.
--
-- The child card's QR carries `JWC1.<token>`; the token is 256 random bits
-- and only its SHA-256 is kept (labelled with the compound), so the card is
-- shown once, at turn-on and at a reissue, and no pepper or key rotation
-- ever kills a printed card. A reissue replaces the hash in that
-- transaction. The card and the child's photo exist exactly while the
-- control is live.
--
-- The control names "this minor of this unit" with one composite key,
-- ON UPDATE CASCADE: when the member row becomes an adult (ADR 0021), the
-- control's `member_is_minor` follows, and the CHECK refuses a live control
-- on an adult, so a coming of age that did not end it first fails.

CREATE TABLE "child_controls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "member_is_minor" BOOLEAN NOT NULL DEFAULT true,
    "may_leave_alone" BOOLEAN NOT NULL,
    "notify_pickups" BOOLEAN NOT NULL,
    "card_token_hash" CHAR(64),
    "card_issued_at" TIMESTAMPTZ(3),
    "photo_file_id" UUID,
    "turned_on_by_account_id" UUID NOT NULL,
    "turned_on_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "ended_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "child_controls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "child_controls_tenant_id_id_key" ON "child_controls"("tenant_id", "id");
CREATE UNIQUE INDEX "child_controls_tenant_id_id_unit_id_key" ON "child_controls"("tenant_id", "id", "unit_id");
-- One live control per child.
CREATE UNIQUE INDEX "child_controls_one_live_per_member"
  ON "child_controls"("tenant_id", "member_id") WHERE "ended_at" IS NULL;
-- A scanned card resolves to one live control.
CREATE UNIQUE INDEX "child_controls_live_card_key"
  ON "child_controls"("tenant_id", "card_token_hash") WHERE "card_token_hash" IS NOT NULL;
CREATE INDEX "child_controls_unit_idx" ON "child_controls"("tenant_id", "unit_id");

ALTER TABLE "child_controls"
  ADD CONSTRAINT "child_controls_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_controls_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- This minor of this unit; is_minor follows the member row.
  ADD CONSTRAINT "child_controls_member_fkey"
    FOREIGN KEY ("tenant_id", "member_id", "unit_id", "member_is_minor")
    REFERENCES "household_members"("tenant_id", "id", "unit_id", "is_minor")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "child_controls_tenant_id_photo_file_id_fkey"
    FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_controls_tenant_id_turned_on_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "turned_on_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_controls_tenant_id_ended_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "child_controls"
  -- A live control is on a minor; an ended one may point at an adult.
  ADD CONSTRAINT "child_controls_live_on_minor"
    CHECK ("ended_at" IS NOT NULL OR "member_is_minor"),
  -- The card exists exactly while the control is live.
  ADD CONSTRAINT "child_controls_card_while_live"
    CHECK (("ended_at" IS NULL) = ("card_token_hash" IS NOT NULL)
           AND ("card_token_hash" IS NULL) = ("card_issued_at" IS NULL)),
  ADD CONSTRAINT "child_controls_card_hash_shape"
    CHECK ("card_token_hash" IS NULL OR "card_token_hash" ~ '^[0-9a-f]{64}$'),
  -- The photo only while live: ending the control deletes it.
  ADD CONSTRAINT "child_controls_photo_while_live"
    CHECK ("ended_at" IS NULL OR "photo_file_id" IS NULL),
  -- Ended once, with a reason; by an account only when the household did.
  ADD CONSTRAINT "child_controls_ended_shape"
    CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
           AND ("ended_by_account_id" IS NULL OR "end_reason" IS NOT DISTINCT FROM 'household')
           AND ("end_reason" IS DISTINCT FROM 'household' OR "ended_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "child_controls_end_reason"
    CHECK ("end_reason" IS NULL OR "end_reason" IN ('household', 'left_household', 'came_of_age'));

-- Whose control it is and since when never change; it ends once and then
-- nothing changes but `member_is_minor`, which follows the member row (the
-- coming of age cascades into ended controls). The card changes only while
-- live, to a later issue. Never deleted.
CREATE FUNCTION child_control_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."member_id" = OLD."member_id"
     AND NEW."turned_on_by_account_id" = OLD."turned_on_by_account_id"
     AND NEW."turned_on_at" = OLD."turned_on_at"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."ended_at" IS NULL
          OR (NEW."ended_at" = OLD."ended_at"
              AND NEW."end_reason" = OLD."end_reason"
              AND NEW."ended_by_account_id" IS NOT DISTINCT FROM OLD."ended_by_account_id"
              AND NEW."may_leave_alone" = OLD."may_leave_alone"
              AND NEW."notify_pickups" = OLD."notify_pickups"
              AND NEW."card_token_hash" IS NOT DISTINCT FROM OLD."card_token_hash"
              AND NEW."card_issued_at" IS NOT DISTINCT FROM OLD."card_issued_at"
              AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"))
     AND (NEW."card_token_hash" IS NOT DISTINCT FROM OLD."card_token_hash"
          OR NEW."ended_at" IS NOT NULL
          OR NEW."card_issued_at" > OLD."card_issued_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'child_controls: whose control it is never changes; it ends once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER child_controls_kept
  BEFORE UPDATE OR DELETE ON "child_controls"
  FOR EACH ROW EXECUTE FUNCTION child_control_is_kept();
CREATE TRIGGER child_controls_kept_truncate
  BEFORE TRUNCATE ON "child_controls"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "child_controls" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "child_controls" TO jiwar_app;

ALTER TABLE "child_controls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "child_controls" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "child_controls"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
