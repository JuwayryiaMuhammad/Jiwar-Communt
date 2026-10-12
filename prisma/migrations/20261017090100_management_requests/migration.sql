-- ============================================================================
-- Management requests (ADR 0039): a resident asks the compound's management
-- a question, raises a general matter or books an appointment, and the two
-- sides talk on the request.
--
-- Personal data here: `management_request_messages.body` and
-- `management_request_ratings.comment` (free text), and the attached files.
-- An erasure clears the two texts of its account and nothing else; the rows
-- stay, pointing at the tombstone (the rule of ticket messages, ADR 0032).
-- A request has no free text of its own: what it says is its first message.
-- ============================================================================

CREATE TYPE "management_request_type" AS ENUM ('question', 'general', 'appointment');
CREATE TYPE "management_request_status" AS ENUM ('open', 'in_progress', 'answered', 'closed');
CREATE TYPE "management_side" AS ENUM ('resident', 'staff');
CREATE TYPE "management_actor_side" AS ENUM ('resident', 'staff', 'system');
CREATE TYPE "management_appointment_status" AS ENUM ('requested', 'proposed', 'confirmed', 'cancelled', 'superseded');
CREATE TYPE "management_appointment_mode" AS ENUM ('in_person', 'phone');

-- ----------------------------------------------------------------------------
-- Topics: a closed list per compound, each with the hours management gives
-- itself to answer. Never deleted (a request points at its topic); retired
-- with `active`.
-- ----------------------------------------------------------------------------
CREATE TABLE "management_request_topics" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "target_response_hours" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "management_request_topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_request_topics_tenant_id_id_key"
  ON "management_request_topics"("tenant_id", "id");
CREATE UNIQUE INDEX "management_request_topics_tenant_id_key_key"
  ON "management_request_topics"("tenant_id", "key");
ALTER TABLE "management_request_topics" ADD CONSTRAINT "management_request_topics_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_request_topics" ADD CONSTRAINT "management_request_topics_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "management_request_topics" ADD CONSTRAINT "management_request_topics_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);
ALTER TABLE "management_request_topics" ADD CONSTRAINT "management_request_topics_target"
  CHECK ("target_response_hours" BETWEEN 1 AND 720);

-- ----------------------------------------------------------------------------
-- Settings, office hours and the number counter. One settings row and one
-- counter row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "management_request_settings" (
    "tenant_id" UUID NOT NULL,
    "auto_close_days" INTEGER NOT NULL DEFAULT 7,
    "appointment_slot_minutes" INTEGER NOT NULL DEFAULT 30,
    "appointment_slot_capacity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "management_request_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "management_request_settings" ADD CONSTRAINT "management_request_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_request_settings" ADD CONSTRAINT "management_request_settings_ranges"
  CHECK ("auto_close_days" BETWEEN 1 AND 90
     AND "appointment_slot_minutes" BETWEEN 10 AND 240
     AND "appointment_slot_capacity" BETWEEN 1 AND 50);

-- A weekly window: a weekday (0 is Sunday) and minutes after local midnight,
-- like the visiting hours (ADR 0038). The set is replaced as a whole, under
-- the settings row's lock, which is where two windows of one day are kept
-- from overlapping; the unique index is the backstop for the same start.
CREATE TABLE "management_office_hours" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    CONSTRAINT "management_office_hours_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_office_hours_window_key"
  ON "management_office_hours"("tenant_id", "weekday", "start_minute");
ALTER TABLE "management_office_hours" ADD CONSTRAINT "management_office_hours_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_office_hours" ADD CONSTRAINT "management_office_hours_window"
  CHECK ("weekday" BETWEEN 0 AND 6
     AND "start_minute" BETWEEN 0 AND 1439
     AND "end_minute" BETWEEN 1 AND 1440
     AND "start_minute" < "end_minute");

-- Taken with INSERT … ON CONFLICT DO UPDATE … RETURNING in the creating
-- transaction, like ticket_counters: the row lock serializes creations and a
-- rollback returns the number.
CREATE TABLE "management_request_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "management_request_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "management_request_counters" ADD CONSTRAINT "management_request_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The request. Its author is always the resident; `opened_by_account_id` is
-- the staff member who opened it for them, with the reason code.
--
-- A cycle starts at creation and at every reopening. `response_due_at` is
-- the cycle's start plus the topic's target, fixed for the cycle;
-- `first_response_at` stops that clock; `escalated_at` says the cycle was
-- escalated (management_request_escalations holds the history).
-- ----------------------------------------------------------------------------
CREATE TABLE "management_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "management_request_type" NOT NULL,
    "topic_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "opened_by_account_id" UUID,
    "on_behalf_reason" TEXT,
    "unit_id" UUID,
    "status" "management_request_status" NOT NULL DEFAULT 'open',
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "cycle_started_at" TIMESTAMPTZ(3) NOT NULL,
    "response_due_at" TIMESTAMPTZ(3) NOT NULL,
    "first_response_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "assignee_account_id" UUID,
    "answered_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "closed_by_side" "management_actor_side",
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "management_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_requests_tenant_id_id_key"
  ON "management_requests"("tenant_id", "id");
CREATE UNIQUE INDEX "management_requests_tenant_id_number_key"
  ON "management_requests"("tenant_id", "number");
-- The author's list and the "all my requests" feed.
CREATE INDEX "management_requests_author_activity_idx"
  ON "management_requests"("tenant_id", "author_account_id", "last_activity_at" DESC, "id" DESC);
-- The staff inbox, with and without a status.
CREATE INDEX "management_requests_status_activity_idx"
  ON "management_requests"("tenant_id", "status", "last_activity_at" DESC, "id" DESC);
CREATE INDEX "management_requests_activity_idx"
  ON "management_requests"("tenant_id", "last_activity_at" DESC, "id" DESC);
CREATE INDEX "management_requests_assignee_idx"
  ON "management_requests"("tenant_id", "assignee_account_id")
  WHERE "assignee_account_id" IS NOT NULL;
-- The escalation sweep's work: unanswered, not yet escalated.
CREATE INDEX "management_requests_overdue_idx"
  ON "management_requests"("tenant_id", "response_due_at")
  WHERE "first_response_at" IS NULL AND "escalated_at" IS NULL
    AND "status" IN ('open', 'in_progress');
-- The auto-close sweep's work.
CREATE INDEX "management_requests_answered_idx"
  ON "management_requests"("tenant_id", "answered_at") WHERE "status" = 'answered';

ALTER TABLE "management_requests"
  ADD CONSTRAINT "management_requests_tenant_id_topic_id_fkey"
  FOREIGN KEY ("tenant_id", "topic_id") REFERENCES "management_request_topics"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_requests_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_requests_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_requests_tenant_id_assignee_fkey"
  FOREIGN KEY ("tenant_id", "assignee_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_requests_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_number_positive"
  CHECK ("number" >= 1);
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_cycle"
  CHECK ("cycle" >= 1 AND "response_due_at" > "cycle_started_at");
-- Opened on behalf: the staff member and the reason code, together.
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_on_behalf"
  CHECK (("opened_by_account_id" IS NULL) = ("on_behalf_reason" IS NULL)
     AND ("on_behalf_reason" IS NULL OR "on_behalf_reason" IN
           ('resident_phone_call', 'resident_walk_in', 'resident_written_letter')));
-- Closed has its three facts and nothing else has any of them. Every
-- comparison on a nullable column sits beside its IS [NOT] NULL.
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_closed_shape"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("closed_at" IS NULL) = ("closed_by_side" IS NULL)
     AND ("close_reason" IS NULL OR "close_reason" IN
           ('resolved', 'duplicate', 'not_for_management', 'other',
            'auto_closed', 'withdrawn_by_author')));
-- Who may give which reason: the sweep alone auto-closes, the author alone
-- withdraws, staff give the rest.
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_close_reason_side"
  CHECK ("close_reason" IS NULL OR "closed_by_side" IS NULL
     OR (("close_reason" = 'auto_closed') = ("closed_by_side" = 'system')
         AND ("close_reason" = 'withdrawn_by_author') = ("closed_by_side" = 'resident')));
-- Answered means an official reply was posted, at a known time.
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_answered_at"
  CHECK ("status" <> 'answered' OR "answered_at" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- The conversation. A message never changes: the trigger below lets one
-- thing through, an erasure clearing the body (body to NULL, erased_at from
-- NULL to a time, every other column as it was). No DELETE, no TRUNCATE, for
-- every role.
--
-- `internal` is a staff note: no resident route returns it or its files.
-- `official` is chosen by staff when sending and makes the request answered.
-- ----------------------------------------------------------------------------
CREATE TABLE "management_request_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "sender_account_id" UUID NOT NULL,
    "sender_side" "management_side" NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT,
    "cycle" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),
    CONSTRAINT "management_request_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_request_messages_tenant_id_id_key"
  ON "management_request_messages"("tenant_id", "id");
-- What an attachment's foreign key points at: the message with its request.
CREATE UNIQUE INDEX "management_request_messages_request_message_key"
  ON "management_request_messages"("tenant_id", "request_id", "id");
CREATE INDEX "management_request_messages_request_idx"
  ON "management_request_messages"("tenant_id", "request_id", "created_at", "id");
CREATE INDEX "management_request_messages_sender_idx"
  ON "management_request_messages"("tenant_id", "sender_account_id");
ALTER TABLE "management_request_messages"
  ADD CONSTRAINT "management_request_messages_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "management_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_request_messages_tenant_id_sender_fkey"
  FOREIGN KEY ("tenant_id", "sender_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_request_messages" ADD CONSTRAINT "management_request_messages_erased_shape"
  CHECK (("body" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "management_request_messages" ADD CONSTRAINT "management_request_messages_body_length"
  CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 4000);
-- A note and an official reply are staff's; an official reply is never a
-- note. All three columns are NOT NULL: each side is a real boolean.
ALTER TABLE "management_request_messages" ADD CONSTRAINT "management_request_messages_staff_flags"
  CHECK ((NOT "internal" OR "sender_side" = 'staff')
     AND (NOT "official" OR ("sender_side" = 'staff' AND NOT "internal")));
ALTER TABLE "management_request_messages" ADD CONSTRAINT "management_request_messages_cycle_positive"
  CHECK ("cycle" >= 1);

CREATE FUNCTION management_message_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."sender_account_id" IS DISTINCT FROM OLD."sender_account_id"
     OR NEW."sender_side" IS DISTINCT FROM OLD."sender_side"
     OR NEW."internal" IS DISTINCT FROM OLD."internal"
     OR NEW."official" IS DISTINCT FROM OLD."official"
     OR NEW."cycle" IS DISTINCT FROM OLD."cycle"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."body" IS NULL OR NEW."body" IS NOT NULL
     OR OLD."erased_at" IS NOT NULL OR NEW."erased_at" IS NULL THEN
    RAISE EXCEPTION 'a management request message never changes (only an erasure clears its body)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER management_request_messages_immutable_update
  BEFORE UPDATE ON "management_request_messages"
  FOR EACH ROW EXECUTE FUNCTION management_message_is_immutable();
CREATE TRIGGER management_request_messages_immutable_delete
  BEFORE DELETE ON "management_request_messages"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER management_request_messages_immutable_truncate
  BEFORE TRUNCATE ON "management_request_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A file attached to a message belongs to the request (no owner), like a
-- ticket's photo: its uploader's erasure leaves it. Whether a resident may
-- see it is its message's `internal`. Append-only.
CREATE TABLE "management_request_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "management_request_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_request_attachments_file_id_key"
  ON "management_request_attachments"("file_id");
CREATE INDEX "management_request_attachments_message_idx"
  ON "management_request_attachments"("tenant_id", "message_id", "created_at", "id");
ALTER TABLE "management_request_attachments"
  ADD CONSTRAINT "management_request_attachments_message_fkey"
  FOREIGN KEY ("tenant_id", "request_id", "message_id")
  REFERENCES "management_request_messages"("tenant_id", "request_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_request_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_request_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER management_request_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "management_request_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER management_request_attachments_immutable_truncate
  BEFORE TRUNCATE ON "management_request_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Escalations: one per cycle, written by the sweep when a cycle's response
-- is overdue. Append-only, no foreign keys (like ticket_escalations).
-- ----------------------------------------------------------------------------
CREATE TABLE "management_request_escalations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "management_request_escalations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_request_escalations_once_per_cycle"
  ON "management_request_escalations"("tenant_id", "request_id", "cycle");
ALTER TABLE "management_request_escalations" ADD CONSTRAINT "management_request_escalations_cycle_positive"
  CHECK ("cycle" >= 1);

CREATE TRIGGER management_request_escalations_immutable_rows
  BEFORE UPDATE OR DELETE ON "management_request_escalations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER management_request_escalations_immutable_truncate
  BEFORE TRUNCATE ON "management_request_escalations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The rating: once per request (the primary key), by its author, after it
-- closed. It never changes; like a message, only an erasure clears its
-- comment.
-- ----------------------------------------------------------------------------
CREATE TABLE "management_request_ratings" (
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "management_request_ratings_pkey" PRIMARY KEY ("tenant_id", "request_id")
);
CREATE INDEX "management_request_ratings_author_idx"
  ON "management_request_ratings"("tenant_id", "author_account_id");
ALTER TABLE "management_request_ratings"
  ADD CONSTRAINT "management_request_ratings_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "management_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_request_ratings_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_request_ratings" ADD CONSTRAINT "management_request_ratings_rating"
  CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "management_request_ratings" ADD CONSTRAINT "management_request_ratings_comment_length"
  CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 1000);

CREATE FUNCTION management_rating_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."author_account_id" IS DISTINCT FROM OLD."author_account_id"
     OR NEW."rating" IS DISTINCT FROM OLD."rating"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."comment" IS NULL OR NEW."comment" IS NOT NULL THEN
    RAISE EXCEPTION 'a management request rating never changes (only an erasure clears its comment)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER management_request_ratings_immutable_update
  BEFORE UPDATE ON "management_request_ratings"
  FOR EACH ROW EXECUTE FUNCTION management_rating_is_immutable();
CREATE TRIGGER management_request_ratings_immutable_delete
  BEFORE DELETE ON "management_request_ratings"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER management_request_ratings_immutable_truncate
  BEFORE TRUNCATE ON "management_request_ratings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Appointments. `requested` is the resident's slot waiting for staff,
-- `proposed` is staff's slot waiting for the resident, `confirmed` is agreed.
-- A counter-proposal ends the old row as `superseded` and adds a new one, so
-- a request has at most one live appointment (the partial unique index).
--
-- Capacity: a booking takes the row lock of its slot in
-- management_appointment_slots, then counts the live appointments on that
-- window. The slot row is only a lock: it holds no count to drift.
-- ----------------------------------------------------------------------------
CREATE TABLE "management_appointments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" "management_appointment_status" NOT NULL,
    "mode" "management_appointment_mode" NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "proposed_by_side" "management_side" NOT NULL,
    "proposed_by_account_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_by_side" "management_actor_side",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "management_appointments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "management_appointments_one_live_per_request"
  ON "management_appointments"("tenant_id", "request_id")
  WHERE "status" IN ('requested', 'proposed', 'confirmed');
-- The capacity count and the free-slot read.
CREATE INDEX "management_appointments_live_window_idx"
  ON "management_appointments"("tenant_id", "starts_at")
  WHERE "status" IN ('requested', 'proposed', 'confirmed');
CREATE INDEX "management_appointments_status_idx"
  ON "management_appointments"("tenant_id", "status", "starts_at", "id");
CREATE INDEX "management_appointments_request_idx"
  ON "management_appointments"("tenant_id", "request_id", "created_at", "id");
ALTER TABLE "management_appointments"
  ADD CONSTRAINT "management_appointments_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "management_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "management_appointments_tenant_id_proposed_by_fkey"
  FOREIGN KEY ("tenant_id", "proposed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "management_appointments" ADD CONSTRAINT "management_appointments_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '4 hours');
-- Ended means cancelled or superseded; a cancellation has its reason and its
-- side, nothing else has either.
ALTER TABLE "management_appointments" ADD CONSTRAINT "management_appointments_end_shape"
  CHECK (("status" IN ('cancelled', 'superseded')) = ("ended_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancel_reason" IS NOT NULL)
     AND ("cancel_reason" IS NULL) = ("cancelled_by_side" IS NULL)
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN
           ('no_longer_needed', 'cannot_attend', 'staff_unavailable',
            'office_closed', 'other', 'request_closed')));
ALTER TABLE "management_appointments" ADD CONSTRAINT "management_appointments_confirmed_at"
  CHECK ("status" <> 'confirmed' OR "confirmed_at" IS NOT NULL);

CREATE TABLE "management_appointment_slots" (
    "tenant_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "management_appointment_slots_pkey" PRIMARY KEY ("tenant_id", "starts_at")
);
ALTER TABLE "management_appointment_slots" ADD CONSTRAINT "management_appointment_slots_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- A message's attachment: an image or a PDF, up to 10 MiB (the ELSE of the
-- size CHECK, unchanged). The content-type CHECK is recreated to let a PDF
-- through for this purpose too.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export'));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. The app deletes only office hours (the set is
-- replaced); messages and ratings take the one UPDATE their triggers allow.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "management_request_topics", "management_request_settings",
  "management_office_hours", "management_request_counters", "management_requests",
  "management_request_messages", "management_request_attachments",
  "management_request_escalations", "management_request_ratings",
  "management_appointments", "management_appointment_slots" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "management_request_topics", "management_request_settings",
  "management_request_counters", "management_requests", "management_request_messages",
  "management_request_ratings", "management_appointments" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "management_office_hours" TO jiwar_app;
GRANT SELECT, INSERT ON "management_request_attachments",
  "management_request_escalations", "management_appointment_slots" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['management_request_topics', 'management_request_settings',
    'management_office_hours', 'management_request_counters', 'management_requests',
    'management_request_messages', 'management_request_attachments',
    'management_request_escalations', 'management_request_ratings',
    'management_appointments', 'management_appointment_slots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_TOPICS and
-- DEFAULT_OFFICE_HOURS in src/management/settings/defaults.ts; a unit test
-- keeps the two in step): settings, counter, five topics, and office hours
-- Saturday to Thursday, 09:00 to 17:00. FORCE RLS applies here too: one
-- compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "management_request_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
    INSERT INTO "management_request_counters" ("tenant_id") VALUES (t."id");
    INSERT INTO "management_request_topics"
      ("id", "tenant_id", "key", "name_ar", "name_en", "target_response_hours", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, s.hours, CURRENT_TIMESTAMP
      FROM (VALUES
        ('general', 'عام', 'General', 48),
        ('billing_fees', 'الفواتير والرسوم', 'Billing and fees', 48),
        ('security_gate', 'الأمن والبوابة', 'Security and gate', 24),
        ('facilities', 'المرافق', 'Facilities', 72),
        ('documents', 'المستندات', 'Documents', 72)
      ) AS s(key, name_ar, name_en, hours);
    INSERT INTO "management_office_hours"
      ("id", "tenant_id", "weekday", "start_minute", "end_minute")
    SELECT gen_random_uuid(), t."id", d.weekday, 540, 1020
      FROM (VALUES (0), (1), (2), (3), (4), (6)) AS d(weekday);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
