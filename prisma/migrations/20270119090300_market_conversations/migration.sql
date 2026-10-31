-- ============================================================================
-- The market (ADR 0071): a buyer writes to a seller through the neighbours'
-- masked conversation (ADR 0042), one engine for both: the same masking,
-- the same reveal, blocks, reports and erasure, the same staff queue. A
-- conversation is about a board post or a listing, never both and never
-- neither; one a listing and responder, as one a post and responder.
--
-- Existing rows all name a post: the CHECK holds for them as they are.
-- ============================================================================

ALTER TABLE "neighbour_conversations" ALTER COLUMN "post_id" DROP NOT NULL;
ALTER TABLE "neighbour_conversations" ADD COLUMN "listing_id" UUID;
ALTER TABLE "neighbour_conversations"
  ADD CONSTRAINT "neighbour_conversations_tenant_id_listing_id_fkey"
  FOREIGN KEY ("tenant_id", "listing_id") REFERENCES "market_listings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_conversations" ADD CONSTRAINT "neighbour_conversations_one_subject"
  CHECK (("post_id" IS NULL) <> ("listing_id" IS NULL));
CREATE UNIQUE INDEX "neighbour_conversations_one_per_listing_responder"
  ON "neighbour_conversations"("tenant_id", "listing_id", "responder_account_id")
  WHERE "listing_id" IS NOT NULL;

-- Its subject never changes either: the function is replaced in place, its
-- triggers keep calling it.
CREATE OR REPLACE FUNCTION neighbour_conversation_keeps_its_parties() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."post_id" IS NOT DISTINCT FROM OLD."post_id"
     AND NEW."listing_id" IS NOT DISTINCT FROM OLD."listing_id"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."responder_account_id" = OLD."responder_account_id"
     AND NEW."responder_unit_id" IS NOT DISTINCT FROM OLD."responder_unit_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."author_reveal_at" IS NULL OR OLD."responder_reveal_at" IS NULL
          OR (NEW."author_reveal_at" IS NOT DISTINCT FROM OLD."author_reveal_at"
              AND NEW."responder_reveal_at" IS NOT DISTINCT FROM OLD."responder_reveal_at"))
     AND (OLD."closed_at" IS NULL
          OR (NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
              AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_conversations: a conversation keeps its parties, its subject, its names and its end (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
