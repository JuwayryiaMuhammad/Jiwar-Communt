-- ============================================================================
-- A group offer's contract (ADR 0083, amends 0071)
-- ============================================================================
--
-- Once an offer is confirmed, the market's handlers record its contract:
-- the supplier (a partner, or the one it had) and the final price.
-- - At or below the group price everyone joined at (an offer's terms never
--   change, so that is its `group_price`): it is `contracted` at once.
-- - Above it: `reconfirming` until `reconfirm_closes_at`. Each joined
--   participant re-confirms (`reconfirmed_at`) or leaves; at the deadline
--   the sweep drops those who did not (`left_at` and `dropped`), then the
--   offer is `contracted` if enough households remain, or `failed`.
-- Nobody is held to a higher price they did not confirm.
--
-- The state shape and both forward-only triggers are recreated whole: a
-- contracted or re-confirming offer keeps the `closed_at` of its joins'
-- end, and a participation may now be re-confirmed once while it lasts.
-- ============================================================================

ALTER TABLE "group_offers" ADD COLUMN "final_price" DECIMAL(12,2);
ALTER TABLE "group_offers" ADD COLUMN "priced_at" TIMESTAMPTZ(3);
ALTER TABLE "group_offers" ADD COLUMN "priced_by" UUID;
ALTER TABLE "group_offers" ADD COLUMN "reconfirm_closes_at" TIMESTAMPTZ(3);
ALTER TABLE "group_offers" ADD COLUMN "contracted_at" TIMESTAMPTZ(3);
ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_tenant_id_priced_by_fkey"
  FOREIGN KEY ("tenant_id", "priced_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "group_offers" DROP CONSTRAINT "group_offers_state_shape";
ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_state_shape"
  CHECK ((("status" IN ('confirmed', 'failed', 'cancelled', 'reconfirming', 'contracted'))
          = ("closed_at" IS NOT NULL))
     AND (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL))
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN
           ('partner_withdrew', 'price_changed', 'not_enough_interest', 'other')));
-- Priced: the final price, when and by whom, together; a re-confirming or
-- contracted offer is priced; a re-confirmation's deadline only on a priced
-- offer, and always while re-confirming; contracted exactly when it says
-- when.
ALTER TABLE "group_offers" ADD CONSTRAINT "group_offers_contract_shape"
  CHECK ((("final_price" IS NULL) = ("priced_at" IS NULL))
     AND (("priced_at" IS NULL) = ("priced_by" IS NULL))
     AND ("final_price" IS NULL OR "final_price" > 0)
     AND ("status" NOT IN ('reconfirming', 'contracted') OR "final_price" IS NOT NULL)
     AND ("reconfirm_closes_at" IS NULL OR "final_price" IS NOT NULL)
     AND ("status" <> 'reconfirming' OR "reconfirm_closes_at" IS NOT NULL)
     AND (("status" = 'contracted') = ("contracted_at" IS NOT NULL)));

-- Its terms never change once published. Live (interest, open), it moves
-- forward as before; confirmed, it is priced once — contracted, or held
-- for re-confirmation (the supplier may be named then); re-confirming, it
-- ends contracted or failed. Its price, once given, never changes.
CREATE OR REPLACE FUNCTION group_offer_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
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
     AND (
       (OLD."status" IN ('interest', 'open')
        AND NOT (OLD."status" = 'open' AND NEW."status" = 'interest')
        AND NEW."partner_id" IS NOT DISTINCT FROM OLD."partner_id"
        AND NEW."final_price" IS NULL)
       OR (OLD."status" = 'confirmed'
           AND NEW."status" IN ('reconfirming', 'contracted')
           AND NEW."closed_at" = OLD."closed_at")
       OR (OLD."status" = 'reconfirming'
           AND NEW."status" IN ('contracted', 'failed')
           AND NEW."partner_id" IS NOT DISTINCT FROM OLD."partner_id"
           AND NEW."final_price" = OLD."final_price"
           AND NEW."priced_at" = OLD."priced_at"
           AND NEW."priced_by" = OLD."priced_by"
           AND NEW."reconfirm_closes_at" = OLD."reconfirm_closes_at"
           AND NEW."closed_at" = OLD."closed_at")
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'group_offers: an offer keeps its terms and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

ALTER TABLE "group_offer_participants" ADD COLUMN "reconfirmed_at" TIMESTAMPTZ(3);
ALTER TABLE "group_offer_participants" ADD COLUMN "dropped" BOOLEAN NOT NULL DEFAULT false;
-- Dropped for not re-confirming: it left then. Re-confirmed: a join, while
-- it lasted.
ALTER TABLE "group_offer_participants" ADD CONSTRAINT "group_offer_participants_reconfirm_shape"
  CHECK ((NOT "dropped" OR ("left_at" IS NOT NULL AND "reconfirmed_at" IS NULL))
     AND ("reconfirmed_at" IS NULL
          OR ("kind" = 'join' AND "reconfirmed_at" >= "joined_at"
              AND ("left_at" IS NULL OR "left_at" >= "reconfirmed_at"))));

-- A participation is what it was; it is re-confirmed once while it lasts,
-- and it ends once (dropped only then).
CREATE OR REPLACE FUNCTION group_offer_participant_leaves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."left_at" IS NULL
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."offer_id" = OLD."offer_id" AND NEW."account_id" = OLD."account_id"
     AND NEW."unit_id" = OLD."unit_id" AND NEW."kind" = OLD."kind"
     AND NEW."quantity" = OLD."quantity" AND NEW."joined_at" = OLD."joined_at"
     AND NOT OLD."dropped"
     AND (
       (NEW."left_at" IS NOT NULL
        AND NEW."reconfirmed_at" IS NOT DISTINCT FROM OLD."reconfirmed_at")
       OR (NEW."left_at" IS NULL AND NOT NEW."dropped"
           AND OLD."reconfirmed_at" IS NULL AND NEW."reconfirmed_at" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'group_offer_participants: a participation is re-confirmed once and ends once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- The re-confirmations' deadline, for the sweep.
CREATE INDEX "group_offers_reconfirm_idx"
  ON "group_offers"("tenant_id", "reconfirm_closes_at") WHERE "status" = 'reconfirming';
