-- ============================================================================
-- Masked contact (ADR 0042): a conversation exists only on a board post,
-- between the post's author and one responder. Each sees the other as "a
-- resident of building X" until BOTH have agreed to show names, and then a
-- first name and nothing more: never a phone, an email or a unit. Either
-- may block the other, or report the conversation.
--
-- The staff read no conversation. A report opens a case that shows them
-- that one conversation, for as long as the case is open.
--
-- Personal data here: `neighbour_conversation_messages.body` and
-- `neighbour_conversation_reports.note` (free text). An erasure clears the
-- texts of its account, closes its conversations and deletes its blocks;
-- the rows stay, pointing at the tombstone.
-- ============================================================================

CREATE TYPE "neighbour_report_status" AS ENUM ('open', 'closed');

-- ----------------------------------------------------------------------------
-- A conversation: one per post and responder. `responder_unit_id` is the
-- responder's own unit, for its building alone (the author's comes from the
-- post). A side's `*_reveal_at` is its agreement to show names; names show
-- only when both are set, and from then on neither is taken back.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "responder_account_id" UUID NOT NULL,
    "responder_unit_id" UUID,
    "author_reveal_at" TIMESTAMPTZ(3),
    "responder_reveal_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_conversations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_conversations_tenant_id_id_key"
  ON "neighbour_conversations"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_conversations_one_per_responder"
  ON "neighbour_conversations"("tenant_id", "post_id", "responder_account_id");
CREATE INDEX "neighbour_conversations_author_idx"
  ON "neighbour_conversations"("tenant_id", "author_account_id", "last_message_at" DESC, "id" DESC);
CREATE INDEX "neighbour_conversations_responder_idx"
  ON "neighbour_conversations"("tenant_id", "responder_account_id", "last_message_at" DESC, "id" DESC);
-- A day's new conversations, counted against the account's limit.
CREATE INDEX "neighbour_conversations_started_idx"
  ON "neighbour_conversations"("tenant_id", "responder_account_id", "created_at");
ALTER TABLE "neighbour_conversations"
  ADD CONSTRAINT "neighbour_conversations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversations_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "neighbour_posts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversations_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversations_tenant_id_responder_fkey"
  FOREIGN KEY ("tenant_id", "responder_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversations_tenant_id_responder_unit_fkey"
  FOREIGN KEY ("tenant_id", "responder_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "neighbour_conversations" ADD CONSTRAINT "neighbour_conversations_two_people"
  CHECK ("author_account_id" <> "responder_account_id");
-- Closed has its two facts and open has neither.
ALTER TABLE "neighbour_conversations" ADD CONSTRAINT "neighbour_conversations_closed_shape"
  CHECK (("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("close_reason" IS NULL OR "close_reason" IN
           ('blocked', 'reported', 'participant_left', 'participant_erased')));

-- Who talks to whom, about what, never changes; names once shown stay
-- shown; a closed conversation stays closed. No DELETE, no TRUNCATE.
CREATE FUNCTION neighbour_conversation_keeps_its_parties() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."post_id" = OLD."post_id"
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
  RAISE EXCEPTION 'neighbour_conversations: a conversation keeps its parties, its names and its end (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_conversations_keep_parties
  BEFORE UPDATE OR DELETE ON "neighbour_conversations"
  FOR EACH ROW EXECUTE FUNCTION neighbour_conversation_keeps_its_parties();
CREATE TRIGGER neighbour_conversations_keep_parties_truncate
  BEFORE TRUNCATE ON "neighbour_conversations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Its messages: text only. A message never changes: the trigger lets one
-- thing through, an erasure clearing the body. No DELETE, no TRUNCATE.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_conversation_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_account_id" UUID NOT NULL,
    "body" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),
    CONSTRAINT "neighbour_conversation_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "neighbour_conversation_messages_conversation_idx"
  ON "neighbour_conversation_messages"("tenant_id", "conversation_id", "created_at", "id");
CREATE INDEX "neighbour_conversation_messages_sender_idx"
  ON "neighbour_conversation_messages"("tenant_id", "sender_account_id");
ALTER TABLE "neighbour_conversation_messages"
  ADD CONSTRAINT "neighbour_conversation_messages_tenant_id_conversation_id_fkey"
  FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "neighbour_conversations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversation_messages_tenant_id_sender_fkey"
  FOREIGN KEY ("tenant_id", "sender_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_conversation_messages" ADD CONSTRAINT "neighbour_conversation_messages_erased_shape"
  CHECK (("body" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "neighbour_conversation_messages" ADD CONSTRAINT "neighbour_conversation_messages_body_length"
  CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000);

CREATE FUNCTION neighbour_conversation_message_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
     OR NEW."sender_account_id" IS DISTINCT FROM OLD."sender_account_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."body" IS NULL OR NEW."body" IS NOT NULL
     OR OLD."erased_at" IS NOT NULL OR NEW."erased_at" IS NULL THEN
    RAISE EXCEPTION 'a conversation message never changes (only an erasure clears its body)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER neighbour_conversation_messages_immutable_update
  BEFORE UPDATE ON "neighbour_conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION neighbour_conversation_message_is_immutable();
CREATE TRIGGER neighbour_conversation_messages_immutable_delete
  BEFORE DELETE ON "neighbour_conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_conversation_messages_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_conversation_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A block: one account keeps another away. It is made from a conversation
-- (the blocker never learns who the other is), which is also where the
-- label on the blocker's list comes from. Neither then sees the other's
-- posts or starts a conversation with them, whichever blocked. Deleted to
-- undo it; never updated.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_blocks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "blocker_account_id" UUID NOT NULL,
    "blocked_account_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_blocks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_blocks_one_per_pair"
  ON "neighbour_blocks"("tenant_id", "blocker_account_id", "blocked_account_id");
CREATE INDEX "neighbour_blocks_blocked_idx"
  ON "neighbour_blocks"("tenant_id", "blocked_account_id");
ALTER TABLE "neighbour_blocks"
  ADD CONSTRAINT "neighbour_blocks_tenant_id_blocker_fkey"
  FOREIGN KEY ("tenant_id", "blocker_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_blocks_tenant_id_blocked_fkey"
  FOREIGN KEY ("tenant_id", "blocked_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_blocks_tenant_id_conversation_id_fkey"
  FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "neighbour_conversations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_blocks" ADD CONSTRAINT "neighbour_blocks_two_people"
  CHECK ("blocker_account_id" <> "blocked_account_id");

-- ----------------------------------------------------------------------------
-- A report: a participant asks the staff to look at one conversation. Each
-- participant reports a conversation at most once.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_conversation_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reporter_account_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "status" "neighbour_report_status" NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "closed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_conversation_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_conversation_reports_tenant_id_id_key"
  ON "neighbour_conversation_reports"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_conversation_reports_one_per_reporter"
  ON "neighbour_conversation_reports"("tenant_id", "conversation_id", "reporter_account_id");
CREATE INDEX "neighbour_conversation_reports_status_idx"
  ON "neighbour_conversation_reports"("tenant_id", "status", "created_at" DESC, "id" DESC);
ALTER TABLE "neighbour_conversation_reports"
  ADD CONSTRAINT "neighbour_conversation_reports_tenant_id_conversation_id_fkey"
  FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "neighbour_conversations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversation_reports_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reporter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_conversation_reports_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_conversation_reports" ADD CONSTRAINT "neighbour_conversation_reports_reason"
  CHECK ("reason_code" IN ('harassment', 'spam', 'scam', 'inappropriate', 'other'));
ALTER TABLE "neighbour_conversation_reports" ADD CONSTRAINT "neighbour_conversation_reports_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
-- Closed has its three facts and open has none of them.
ALTER TABLE "neighbour_conversation_reports" ADD CONSTRAINT "neighbour_conversation_reports_closed_shape"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("outcome" IS NULL)
     AND ("closed_at" IS NULL) = ("closed_by_account_id" IS NULL)
     AND ("outcome" IS NULL OR "outcome" IN ('no_action', 'warned', 'post_removed')));

-- Who reported what, and why, never changes; the note is only ever cleared.
CREATE FUNCTION neighbour_report_keeps_its_reporter() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."conversation_id" = OLD."conversation_id"
     AND NEW."reporter_account_id" = OLD."reporter_account_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."note" IS NOT DISTINCT FROM OLD."note" OR NEW."note" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_conversation_reports: a report keeps its reporter and its reason (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_conversation_reports_keep_reporter
  BEFORE UPDATE OR DELETE ON "neighbour_conversation_reports"
  FOR EACH ROW EXECUTE FUNCTION neighbour_report_keeps_its_reporter();
CREATE TRIGGER neighbour_conversation_reports_keep_reporter_truncate
  BEFORE TRUNCATE ON "neighbour_conversation_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. The app deletes only blocks, and never updates one.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "neighbour_conversations", "neighbour_conversation_messages",
  "neighbour_blocks", "neighbour_conversation_reports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "neighbour_conversations",
  "neighbour_conversation_messages", "neighbour_conversation_reports" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "neighbour_blocks" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neighbour_conversations', 'neighbour_conversation_messages',
    'neighbour_blocks', 'neighbour_conversation_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
