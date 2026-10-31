-- ============================================================================
-- Group offers (ADR 0071): a price a partner (or a seller the management
-- found) gives when enough households buy together. The market's handlers
-- run them: an optional interest phase first — a non-binding count of who
-- would join, the "interest poll" — then an open phase, in which residents
-- join with a quantity for one of their units and may leave, until it closes.
-- At `closes_at` the sweep confirms it if enough households joined, or it
-- fails; each participant is told. The handlers may call one off before.
--
-- No money passes through Jiwar: buyers pay the partner. Prices are shown,
-- the saving is computed on read.
-- ============================================================================

CREATE TYPE "group_offer_status" AS ENUM ('interest', 'open', 'confirmed', 'failed', 'cancelled');
CREATE TYPE "group_offer_participation" AS ENUM ('interest', 'join');

CREATE TABLE "group_offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "body_en" TEXT NOT NULL,
    "body_ar" TEXT NOT NULL,
    "list_price" DECIMAL(12,2) NOT NULL,
    "group_price" DECIMAL(12,2) NOT NULL,
    "min_participants" INTEGER NOT NULL,
    "max_participants" INTEGER,
    "interest_closes_at" TIMESTAMPTZ(3),
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "group_offer_status" NOT NULL,
    "cancel_reason" TEXT,
    "created_by" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "group_offers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "group_offers_tenant_id_id_key"
  ON "group_offers"("tenant_id", "id");
CREATE INDEX "group_offers_status_idx"
  ON "group_offers"("tenant_id", "status", "closes_at");
ALTER TABLE "group_offers"
  ADD CONSTRAINT "group_offers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "group_offers_tenant_id_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "group_offers_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_text_length"
  CHECK (char_length("title_en") BETWEEN 2 AND 80
     AND char_length("title_ar") BETWEEN 2 AND 80
     AND char_length("body_en") BETWEEN 1 AND 1000
     AND char_length("body_ar") BETWEEN 1 AND 1000);
-- A group price below the list price; at least two households; a cap, when
-- set, not below the minimum; the interest phase ends before the offer does.
ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_terms"
  CHECK ("list_price" > 0 AND "group_price" > 0 AND "group_price" < "list_price"
     AND "min_participants" BETWEEN 2 AND 1000
     AND ("max_participants" IS NULL
          OR "max_participants" BETWEEN "min_participants" AND 10000)
     AND ("interest_closes_at" IS NULL OR "interest_closes_at" < "closes_at"));
-- Closed (confirmed, failed or called off) has its time; only a call-off a
-- code, from its closed list.
ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_state_shape"
  CHECK ((("status" IN ('confirmed', 'failed', 'cancelled')) = ("closed_at" IS NOT NULL))
     AND (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL))
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN
           ('partner_withdrew', 'price_changed', 'not_enough_interest', 'other')));

-- Its terms never change once published; it moves forward and a closed one
-- stays closed.
CREATE FUNCTION group_offer_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."partner_id" IS NOT DISTINCT FROM OLD."partner_id"
     AND NEW."title_en" = OLD."title_en" AND NEW."title_ar" = OLD."title_ar"
     AND NEW."body_en" = OLD."body_en" AND NEW."body_ar" = OLD."body_ar"
     AND NEW."list_price" = OLD."list_price"
     AND NEW."group_price" = OLD."group_price"
     AND NEW."min_participants" = OLD."min_participants"
     AND NEW."max_participants" IS NOT DISTINCT FROM OLD."max_participants"
     AND NEW."interest_closes_at" IS NOT DISTINCT FROM OLD."interest_closes_at"
     AND NEW."closes_at" = OLD."closes_at"
     AND NEW."created_by" = OLD."created_by"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" IN ('interest', 'open')
     AND NOT (OLD."status" = 'open' AND NEW."status" = 'interest') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'group_offers: an offer keeps its terms and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER group_offers_move_forward
  BEFORE UPDATE OR DELETE ON "group_offers"
  FOR EACH ROW EXECUTE FUNCTION group_offer_moves_forward();
CREATE TRIGGER group_offers_move_forward_truncate
  BEFORE TRUNCATE ON "group_offers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Who takes part: an interest (the poll) or a join with a quantity for one
-- of their units. One live row an offer, account and kind; leaving stamps
-- `left_at`, and joining again is a new row.
-- ----------------------------------------------------------------------------
CREATE TABLE "group_offer_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" "group_offer_participation" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "left_at" TIMESTAMPTZ(3),
    CONSTRAINT "group_offer_participants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "group_offer_participants_tenant_id_id_key"
  ON "group_offer_participants"("tenant_id", "id");
CREATE UNIQUE INDEX "group_offer_participants_one_live"
  ON "group_offer_participants"("tenant_id", "offer_id", "account_id", "kind")
  WHERE "left_at" IS NULL;
CREATE INDEX "group_offer_participants_account_idx"
  ON "group_offer_participants"("tenant_id", "account_id", "joined_at" DESC);
ALTER TABLE "group_offer_participants"
  ADD CONSTRAINT "group_offer_participants_tenant_id_offer_fkey"
  FOREIGN KEY ("tenant_id", "offer_id") REFERENCES "group_offers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "group_offer_participants_tenant_id_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "group_offer_participants_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "group_offer_participants" ADD CONSTRAINT "group_offer_participants_quantity"
  CHECK ("quantity" BETWEEN 1 AND 10 AND ("kind" = 'join' OR "quantity" = 1));
ALTER TABLE "group_offer_participants" ADD CONSTRAINT "group_offer_participants_left_after"
  CHECK ("left_at" IS NULL OR "left_at" >= "joined_at");

-- A participation is what it was; the only change is leaving, once.
CREATE FUNCTION group_offer_participant_leaves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."left_at" IS NULL AND NEW."left_at" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."offer_id" = OLD."offer_id" AND NEW."account_id" = OLD."account_id"
     AND NEW."unit_id" = OLD."unit_id" AND NEW."kind" = OLD."kind"
     AND NEW."quantity" = OLD."quantity" AND NEW."joined_at" = OLD."joined_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'group_offer_participants: a participation only ends, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER group_offer_participants_leave_once
  BEFORE UPDATE OR DELETE ON "group_offer_participants"
  FOR EACH ROW EXECUTE FUNCTION group_offer_participant_leaves_once();
CREATE TRIGGER group_offer_participants_leave_once_truncate
  BEFORE TRUNCATE ON "group_offer_participants"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "group_offers", "group_offer_participants" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "group_offers", "group_offer_participants" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['group_offers', 'group_offer_participants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
