-- ============================================================================
-- The two boards (ADR 0042), compound-wide: lost and found, and lending.
-- A post is a few words, a place, a date and photos. A found item is held
-- at the management office: residents claim it and the staff record the
-- handover. Lending is posts and masked contact only: no payments, no
-- deposits, no tracking of returns.
--
-- Personal data here: `neighbour_posts.body` and `.place`,
-- `neighbour_item_claims.note` (free text) and the photos. An erasure
-- clears the texts of its account, closes its posts and deletes their
-- photos; the rows stay, pointing at the tombstone.
-- ============================================================================

CREATE TYPE "neighbour_post_kind" AS ENUM ('lost', 'found', 'lend', 'borrow');
CREATE TYPE "neighbour_post_status" AS ENUM ('open', 'closed');
CREATE TYPE "neighbour_claim_status" AS ENUM ('pending', 'handed_over', 'declined', 'withdrawn');

-- ----------------------------------------------------------------------------
-- A post. It leaves the board at `expires_at`, by the reader's clock: no job
-- closes it. `author_unit_id` is the resident author's own unit: it gives
-- the building other residents see instead of a name, and nothing else of
-- it is ever shown. A staff post has none.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_posts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "neighbour_post_kind" NOT NULL,
    "author_account_id" UUID NOT NULL,
    "author_side" "neighbour_side" NOT NULL,
    "author_unit_id" UUID,
    "body" TEXT,
    "place" TEXT,
    "occurred_on" DATE,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "neighbour_post_status" NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "erased_at" TIMESTAMPTZ(3),
    CONSTRAINT "neighbour_posts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_posts_tenant_id_id_key"
  ON "neighbour_posts"("tenant_id", "id");
CREATE INDEX "neighbour_posts_board_idx"
  ON "neighbour_posts"("tenant_id", "status", "kind", "created_at" DESC, "id" DESC);
CREATE INDEX "neighbour_posts_author_idx"
  ON "neighbour_posts"("tenant_id", "author_account_id", "created_at" DESC, "id" DESC);
ALTER TABLE "neighbour_posts"
  ADD CONSTRAINT "neighbour_posts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_posts_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_posts_tenant_id_author_unit_fkey"
  FOREIGN KEY ("tenant_id", "author_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A post has its words until its author is erased, and then has none.
ALTER TABLE "neighbour_posts" ADD CONSTRAINT "neighbour_posts_erased_shape"
  CHECK (("body" IS NULL) = ("erased_at" IS NOT NULL)
     AND ("erased_at" IS NULL OR "place" IS NULL));
ALTER TABLE "neighbour_posts" ADD CONSTRAINT "neighbour_posts_text_length"
  CHECK (("body" IS NULL OR char_length("body") BETWEEN 1 AND 500)
     AND ("place" IS NULL OR char_length("place") BETWEEN 1 AND 120));
-- The staff post what was lost or found, from no unit; lending is between
-- residents. Only a lost or found item has a day it happened.
ALTER TABLE "neighbour_posts" ADD CONSTRAINT "neighbour_posts_author_shape"
  CHECK (("author_side" = 'resident' OR ("author_unit_id" IS NULL AND "kind" IN ('lost', 'found')))
     AND ("occurred_on" IS NULL OR "kind" IN ('lost', 'found')));
ALTER TABLE "neighbour_posts" ADD CONSTRAINT "neighbour_posts_expires_after_creation"
  CHECK ("expires_at" > "created_at");
-- Closed has its two facts and open has neither. Every comparison on a
-- nullable column sits beside its IS [NOT] NULL.
ALTER TABLE "neighbour_posts" ADD CONSTRAINT "neighbour_posts_closed_shape"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("close_reason" IS NULL OR "close_reason" IN
           ('resolved', 'no_longer_needed',
            'inappropriate', 'duplicate', 'not_allowed',
            'handed_over', 'author_left', 'author_erased')));

-- What a post is never rewritten in: who posted it, what kind it is, from
-- where and when, and how long it stays; and its words, which only an
-- erasure clears, once. No DELETE, no TRUNCATE.
CREATE FUNCTION neighbour_post_keeps_its_author() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."author_unit_id" IS NOT DISTINCT FROM OLD."author_unit_id"
     AND NEW."occurred_on" IS NOT DISTINCT FROM OLD."occurred_on"
     AND NEW."expires_at" = OLD."expires_at"
     AND NEW."created_at" = OLD."created_at"
     AND (
       (NEW."body" IS NOT DISTINCT FROM OLD."body"
        AND NEW."place" IS NOT DISTINCT FROM OLD."place"
        AND NEW."erased_at" IS NOT DISTINCT FROM OLD."erased_at")
       OR (OLD."body" IS NOT NULL AND NEW."body" IS NULL AND NEW."place" IS NULL
           AND OLD."erased_at" IS NULL AND NEW."erased_at" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_posts: a post keeps its author and its words (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_posts_keep_author
  BEFORE UPDATE OR DELETE ON "neighbour_posts"
  FOR EACH ROW EXECUTE FUNCTION neighbour_post_keeps_its_author();
CREATE TRIGGER neighbour_posts_keep_author_truncate
  BEFORE TRUNCATE ON "neighbour_posts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A post's photos: images only, three at most (the service's rule). The
-- file has no owner once attached; an erasure of the post's author deletes
-- the file, and the row then points at nothing readable. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_post_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_post_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_post_photos_file_id_key"
  ON "neighbour_post_photos"("file_id");
CREATE INDEX "neighbour_post_photos_post_idx"
  ON "neighbour_post_photos"("tenant_id", "post_id", "created_at", "id");
ALTER TABLE "neighbour_post_photos"
  ADD CONSTRAINT "neighbour_post_photos_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "neighbour_posts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_post_photos_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER neighbour_post_photos_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_post_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_post_photos_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_post_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A resident's claim on a found item. One pending claim per person and
-- post; the staff decide it, or the claimant takes it back.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_item_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "claimant_account_id" UUID NOT NULL,
    "note" TEXT,
    "status" "neighbour_claim_status" NOT NULL DEFAULT 'pending',
    "decline_reason" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_item_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_item_claims_tenant_id_id_key"
  ON "neighbour_item_claims"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_item_claims_one_pending"
  ON "neighbour_item_claims"("tenant_id", "post_id", "claimant_account_id")
  WHERE "status" = 'pending';
CREATE INDEX "neighbour_item_claims_post_idx"
  ON "neighbour_item_claims"("tenant_id", "post_id", "created_at", "id");
CREATE INDEX "neighbour_item_claims_claimant_idx"
  ON "neighbour_item_claims"("tenant_id", "claimant_account_id", "created_at" DESC, "id" DESC);
ALTER TABLE "neighbour_item_claims"
  ADD CONSTRAINT "neighbour_item_claims_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "neighbour_posts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_item_claims_tenant_id_claimant_fkey"
  FOREIGN KEY ("tenant_id", "claimant_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_item_claims" ADD CONSTRAINT "neighbour_item_claims_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
-- Pending has no decision; every other status has its time, and a declined
-- claim its reason.
ALTER TABLE "neighbour_item_claims" ADD CONSTRAINT "neighbour_item_claims_decided_shape"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL)
     AND ("status" = 'declined') = ("decline_reason" IS NOT NULL)
     AND ("decline_reason" IS NULL OR "decline_reason" IN
           ('not_the_owner', 'insufficient_proof', 'handed_to_another', 'post_closed')));

-- Whose claim it is, and on what, never changes. No DELETE, no TRUNCATE.
CREATE FUNCTION neighbour_claim_keeps_its_claimant() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."post_id" = OLD."post_id"
     AND NEW."claimant_account_id" = OLD."claimant_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."note" IS NOT DISTINCT FROM OLD."note" OR NEW."note" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_item_claims: a claim keeps its claimant and its post (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_item_claims_keep_claimant
  BEFORE UPDATE OR DELETE ON "neighbour_item_claims"
  FOR EACH ROW EXECUTE FUNCTION neighbour_claim_keeps_its_claimant();
CREATE TRIGGER neighbour_item_claims_keep_claimant_truncate
  BEFORE TRUNCATE ON "neighbour_item_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The handover of a found item at the office: to whom, by whom, when. One
-- per post, with the claim it settled or none for a walk-in. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_item_handovers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "claim_id" UUID,
    "recipient_account_id" UUID NOT NULL,
    "handed_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_item_handovers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_item_handovers_one_per_post"
  ON "neighbour_item_handovers"("tenant_id", "post_id");
CREATE UNIQUE INDEX "neighbour_item_handovers_claim_id_key"
  ON "neighbour_item_handovers"("tenant_id", "claim_id");
ALTER TABLE "neighbour_item_handovers"
  ADD CONSTRAINT "neighbour_item_handovers_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "neighbour_posts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_item_handovers_tenant_id_claim_id_fkey"
  FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "neighbour_item_claims"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_item_handovers_tenant_id_recipient_fkey"
  FOREIGN KEY ("tenant_id", "recipient_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_item_handovers_tenant_id_handed_by_fkey"
  FOREIGN KEY ("tenant_id", "handed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER neighbour_item_handovers_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_item_handovers"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_item_handovers_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_item_handovers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted; photos and handovers
-- are never updated either.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "neighbour_posts", "neighbour_post_photos", "neighbour_item_claims",
  "neighbour_item_handovers" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "neighbour_posts", "neighbour_item_claims" TO jiwar_app;
GRANT SELECT, INSERT ON "neighbour_post_photos", "neighbour_item_handovers" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neighbour_posts', 'neighbour_post_photos',
    'neighbour_item_claims', 'neighbour_item_handovers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
