-- ============================================================================
-- Complaints between units (ADR 0042): a resident complains about a UNIT,
-- never a person. The management always knows who complained; the unit
-- complained about never does. It receives one notice, in the staff's
-- words, and may answer the management in a thread of its own.
--
-- Personal data here: `neighbour_complaint_messages.body` (free text) and
-- the attached files. An erasure clears the bodies of its account's
-- messages and nothing else; the rows stay, pointing at the tombstone (the
-- rule of management request messages, ADR 0039). A complaint has no free
-- text of its own: what it says is its first message. A notice is the
-- management's text and is never rewritten.
-- ============================================================================

CREATE TYPE "neighbour_complaint_status" AS ENUM
  ('submitted', 'under_review', 'notice_sent', 'mediation', 'resolved', 'dismissed');
-- Whose a message is: the complainant's thread with the staff, the
-- complained-about unit's thread with the staff, or the staff's own notes.
CREATE TYPE "neighbour_thread" AS ENUM ('complainant', 'target', 'internal');
CREATE TYPE "neighbour_side" AS ENUM ('resident', 'staff');
-- Who a notice went to: the household living in the unit, or its owners.
CREATE TYPE "neighbour_recipient_kind" AS ENUM ('household', 'owners');

-- ----------------------------------------------------------------------------
-- The number counter: one row per compound, created with it and backfilled
-- below. Its row lock serializes a compound's new complaints, which is also
-- what makes an author's open-complaint limit hold.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaint_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "neighbour_complaint_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "neighbour_complaint_counters" ADD CONSTRAINT "neighbour_complaint_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_complaint_counters" ADD CONSTRAINT "neighbour_complaint_counters_not_negative"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- The complaint. `author_unit_id` is one of the author's own units, when
-- they name one; `target_unit_id` is the unit complained about.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "author_account_id" UUID NOT NULL,
    "author_unit_id" UUID,
    "target_unit_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "status" "neighbour_complaint_status" NOT NULL DEFAULT 'submitted',
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "closed_by_side" "neighbour_side",
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_complaints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_complaints_tenant_id_id_key"
  ON "neighbour_complaints"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_complaints_tenant_id_number_key"
  ON "neighbour_complaints"("tenant_id", "number");
CREATE INDEX "neighbour_complaints_author_activity_idx"
  ON "neighbour_complaints"("tenant_id", "author_account_id", "last_activity_at" DESC, "id" DESC);
CREATE INDEX "neighbour_complaints_status_activity_idx"
  ON "neighbour_complaints"("tenant_id", "status", "last_activity_at" DESC, "id" DESC);
CREATE INDEX "neighbour_complaints_activity_idx"
  ON "neighbour_complaints"("tenant_id", "last_activity_at" DESC, "id" DESC);
-- A unit's history, for the staff.
CREATE INDEX "neighbour_complaints_target_unit_idx"
  ON "neighbour_complaints"("tenant_id", "target_unit_id", "last_activity_at" DESC, "id" DESC);
ALTER TABLE "neighbour_complaints"
  ADD CONSTRAINT "neighbour_complaints_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaints_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaints_tenant_id_author_unit_fkey"
  FOREIGN KEY ("tenant_id", "author_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaints_tenant_id_target_unit_fkey"
  FOREIGN KEY ("tenant_id", "target_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaints_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "neighbour_complaint_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "neighbour_complaints" ADD CONSTRAINT "neighbour_complaints_number_positive"
  CHECK ("number" >= 1);
-- Nobody complains about the unit they filed from. (That it is none of the
-- author's units at all is the service's rule, checked at filing.)
ALTER TABLE "neighbour_complaints" ADD CONSTRAINT "neighbour_complaints_not_own_unit"
  CHECK ("author_unit_id" IS NULL OR "author_unit_id" <> "target_unit_id");
-- Closed has its three facts and nothing else has any of them. Every
-- comparison on a nullable column sits beside its IS [NOT] NULL.
ALTER TABLE "neighbour_complaints" ADD CONSTRAINT "neighbour_complaints_closed_shape"
  CHECK (("status" IN ('resolved', 'dismissed')) = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("closed_at" IS NULL) = ("closed_by_side" IS NULL));
-- Each ending has its own reasons: `unfounded` dismisses, never resolves.
ALTER TABLE "neighbour_complaints" ADD CONSTRAINT "neighbour_complaints_close_reason"
  CHECK ("close_reason" IS NULL
     OR ("status" = 'resolved' AND "close_reason" IN
           ('complied', 'mediated', 'no_further_action'))
     OR ("status" = 'dismissed' AND "close_reason" IN
           ('unfounded', 'duplicate', 'insufficient_evidence', 'out_of_scope', 'withdrawn')));
-- The author alone withdraws; staff give every other reason.
ALTER TABLE "neighbour_complaints" ADD CONSTRAINT "neighbour_complaints_close_reason_side"
  CHECK ("close_reason" IS NULL OR "closed_by_side" IS NULL
     OR ("close_reason" = 'withdrawn') = ("closed_by_side" = 'resident'));

-- What a complaint is never rewritten in: its number, who filed it, from
-- and about which unit, under what, and when. No DELETE, no TRUNCATE.
CREATE FUNCTION neighbour_complaint_keeps_its_parties() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."author_unit_id" IS NOT DISTINCT FROM OLD."author_unit_id"
     AND NEW."target_unit_id" = OLD."target_unit_id"
     AND NEW."category_id" = OLD."category_id"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'neighbour_complaints: a complaint keeps its parties (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER neighbour_complaints_keep_parties
  BEFORE UPDATE OR DELETE ON "neighbour_complaints"
  FOR EACH ROW EXECUTE FUNCTION neighbour_complaint_keeps_its_parties();
CREATE TRIGGER neighbour_complaints_keep_parties_truncate
  BEFORE TRUNCATE ON "neighbour_complaints"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Every status a complaint has had, in order: the first row is its filing
-- (`from_status` NULL). Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaint_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "from_status" "neighbour_complaint_status",
    "to_status" "neighbour_complaint_status" NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "actor_side" "neighbour_side" NOT NULL,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_complaint_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "neighbour_complaint_status_history_complaint_idx"
  ON "neighbour_complaint_status_history"("tenant_id", "complaint_id", "created_at", "id");
ALTER TABLE "neighbour_complaint_status_history"
  ADD CONSTRAINT "neighbour_complaint_status_history_tenant_id_complaint_id_fkey"
  FOREIGN KEY ("tenant_id", "complaint_id") REFERENCES "neighbour_complaints"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_status_history_tenant_id_actor_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A row is a move: only the filing has nothing before it, and it files as
-- `submitted`. A reason goes with an ending and with nothing else.
ALTER TABLE "neighbour_complaint_status_history" ADD CONSTRAINT "neighbour_complaint_status_history_move"
  CHECK (("from_status" IS NULL AND "to_status" = 'submitted')
      OR ("from_status" IS NOT NULL AND "from_status" <> "to_status"
          AND "from_status" NOT IN ('resolved', 'dismissed')));
ALTER TABLE "neighbour_complaint_status_history" ADD CONSTRAINT "neighbour_complaint_status_history_reason"
  CHECK (("to_status" IN ('resolved', 'dismissed')) = ("reason_code" IS NOT NULL));

CREATE TRIGGER neighbour_complaint_status_history_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_complaint_status_history"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_complaint_status_history_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_complaint_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The three conversations of a complaint, in one table. A message never
-- changes: the trigger below lets one thing through, an erasure clearing
-- the body (body to NULL, erased_at from NULL to a time, every other column
-- as it was). No DELETE, no TRUNCATE, for every role.
--
-- `thread` decides who reads it: `complainant` the author and the staff,
-- `target` whoever the notice went to and the staff, `internal` the staff
-- alone. No route reads across two threads.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaint_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "thread" "neighbour_thread" NOT NULL,
    "sender_account_id" UUID NOT NULL,
    "sender_side" "neighbour_side" NOT NULL,
    "body" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),
    CONSTRAINT "neighbour_complaint_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_complaint_messages_tenant_id_id_key"
  ON "neighbour_complaint_messages"("tenant_id", "id");
-- What an attachment's foreign key points at: the message with its complaint.
CREATE UNIQUE INDEX "neighbour_complaint_messages_complaint_message_key"
  ON "neighbour_complaint_messages"("tenant_id", "complaint_id", "id");
CREATE INDEX "neighbour_complaint_messages_thread_idx"
  ON "neighbour_complaint_messages"("tenant_id", "complaint_id", "thread", "created_at", "id");
CREATE INDEX "neighbour_complaint_messages_sender_idx"
  ON "neighbour_complaint_messages"("tenant_id", "sender_account_id");
ALTER TABLE "neighbour_complaint_messages"
  ADD CONSTRAINT "neighbour_complaint_messages_tenant_id_complaint_id_fkey"
  FOREIGN KEY ("tenant_id", "complaint_id") REFERENCES "neighbour_complaints"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_messages_tenant_id_sender_fkey"
  FOREIGN KEY ("tenant_id", "sender_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_complaint_messages" ADD CONSTRAINT "neighbour_complaint_messages_erased_shape"
  CHECK (("body" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "neighbour_complaint_messages" ADD CONSTRAINT "neighbour_complaint_messages_body_length"
  CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 4000);
-- A note is the staff's. Both columns are NOT NULL.
ALTER TABLE "neighbour_complaint_messages" ADD CONSTRAINT "neighbour_complaint_messages_internal_is_staff"
  CHECK ("thread" <> 'internal' OR "sender_side" = 'staff');

CREATE FUNCTION neighbour_complaint_message_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."complaint_id" IS DISTINCT FROM OLD."complaint_id"
     OR NEW."thread" IS DISTINCT FROM OLD."thread"
     OR NEW."sender_account_id" IS DISTINCT FROM OLD."sender_account_id"
     OR NEW."sender_side" IS DISTINCT FROM OLD."sender_side"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."body" IS NULL OR NEW."body" IS NOT NULL
     OR OLD."erased_at" IS NOT NULL OR NEW."erased_at" IS NULL THEN
    RAISE EXCEPTION 'a complaint message never changes (only an erasure clears its body)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER neighbour_complaint_messages_immutable_update
  BEFORE UPDATE ON "neighbour_complaint_messages"
  FOR EACH ROW EXECUTE FUNCTION neighbour_complaint_message_is_immutable();
CREATE TRIGGER neighbour_complaint_messages_immutable_delete
  BEFORE DELETE ON "neighbour_complaint_messages"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_complaint_messages_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_complaint_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A file attached to a message belongs to the complaint (no owner): its
-- uploader's erasure leaves it. Who may see it is its message's thread.
-- Append-only.
CREATE TABLE "neighbour_complaint_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_complaint_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_complaint_attachments_file_id_key"
  ON "neighbour_complaint_attachments"("file_id");
CREATE INDEX "neighbour_complaint_attachments_message_idx"
  ON "neighbour_complaint_attachments"("tenant_id", "message_id", "created_at", "id");
ALTER TABLE "neighbour_complaint_attachments"
  ADD CONSTRAINT "neighbour_complaint_attachments_message_fkey"
  FOREIGN KEY ("tenant_id", "complaint_id", "message_id")
  REFERENCES "neighbour_complaint_messages"("tenant_id", "complaint_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER neighbour_complaint_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_complaint_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_complaint_attachments_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_complaint_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The notice to the unit complained about: at most one per complaint, in
-- the staff's words, with its own id (the complaint's number never reaches
-- the unit: two neighbours comparing numbers would name the complainant).
-- Who it went to is written down when it is sent. Both append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaint_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "recipient_kind" "neighbour_recipient_kind" NOT NULL,
    "sent_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_complaint_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_complaint_notices_tenant_id_id_key"
  ON "neighbour_complaint_notices"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_complaint_notices_one_per_complaint"
  ON "neighbour_complaint_notices"("tenant_id", "complaint_id");
ALTER TABLE "neighbour_complaint_notices"
  ADD CONSTRAINT "neighbour_complaint_notices_tenant_id_complaint_id_fkey"
  FOREIGN KEY ("tenant_id", "complaint_id") REFERENCES "neighbour_complaints"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_notices_tenant_id_sent_by_fkey"
  FOREIGN KEY ("tenant_id", "sent_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_complaint_notices" ADD CONSTRAINT "neighbour_complaint_notices_body_length"
  CHECK (char_length("body") BETWEEN 1 AND 2000);

CREATE TRIGGER neighbour_complaint_notices_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_complaint_notices"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_complaint_notices_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_complaint_notices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "neighbour_complaint_notice_recipients" (
    "tenant_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    CONSTRAINT "neighbour_complaint_notice_recipients_pkey"
      PRIMARY KEY ("tenant_id", "notice_id", "account_id")
);
CREATE INDEX "neighbour_complaint_notice_recipients_account_idx"
  ON "neighbour_complaint_notice_recipients"("tenant_id", "account_id");
ALTER TABLE "neighbour_complaint_notice_recipients"
  ADD CONSTRAINT "neighbour_complaint_notice_recipients_tenant_id_notice_id_fkey"
  FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "neighbour_complaint_notices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_complaint_notice_recipients_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER neighbour_complaint_notice_recipients_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_complaint_notice_recipients"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_complaint_notice_recipients_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_complaint_notice_recipients"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted; the history, the
-- attachments, the notices and their recipients are never updated either,
-- and a message takes the one UPDATE its trigger allows.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "neighbour_complaint_counters", "neighbour_complaints",
  "neighbour_complaint_status_history", "neighbour_complaint_messages",
  "neighbour_complaint_attachments", "neighbour_complaint_notices",
  "neighbour_complaint_notice_recipients" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "neighbour_complaint_counters", "neighbour_complaints",
  "neighbour_complaint_messages" TO jiwar_app;
GRANT SELECT, INSERT ON "neighbour_complaint_status_history",
  "neighbour_complaint_attachments", "neighbour_complaint_notices",
  "neighbour_complaint_notice_recipients" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neighbour_complaint_counters', 'neighbour_complaints',
    'neighbour_complaint_status_history', 'neighbour_complaint_messages',
    'neighbour_complaint_attachments', 'neighbour_complaint_notices',
    'neighbour_complaint_notice_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get the counter row a new one gets. FORCE RLS applies
-- here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "neighbour_complaint_counters" ("tenant_id") VALUES (t."id");
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
