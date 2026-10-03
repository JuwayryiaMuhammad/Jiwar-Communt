-- ============================================================================
-- Phase 5.1 — maintenance tickets (ADR 0032). A ticket is a unit's (or a
-- common area's) maintenance record: opened by a resident or by dispatch on
-- their behalf, assigned by hand, worked by a technician, confirmed or
-- rejected by the reporter, reopened within a window, closed by a sweep.
--
-- Two separate statuses: `status` is the work, `confirmation_status` is the
-- reporter's verdict on the last completion. `cycle` grows with every
-- rejection and reopen.
--
-- The status history and the assignment trail are append-only like
-- gate_entries (ADR 0028): INSERT and SELECT for jiwar_app, triggers refuse
-- UPDATE, DELETE and TRUNCATE for every role, and no foreign keys (a row
-- outlives what it names; the service resolves every id first).
--
-- Free text (a description, a common-area label, a message, a comment) is
-- content: it lives on these rows only, never in the audit trail or a
-- notification. An erasure nulls a person's messages and comments.
-- ============================================================================

CREATE TYPE "ticket_priority" AS ENUM ('normal', 'urgent', 'emergency');
CREATE TYPE "ticket_status" AS ENUM
  ('new', 'assigned', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled');
CREATE TYPE "ticket_confirmation_status" AS ENUM
  ('pending', 'confirmed', 'rejected', 'auto_closed');
-- The SLA (Phase 5.3) pauses on these.
CREATE TYPE "ticket_hold_reason" AS ENUM ('awaiting_resident', 'awaiting_parts', 'other');
-- automatic is reserved for the dispatch engine (Phase 5.2); released is a
-- system unassignment (an escalation to the queue, a technician gone).
CREATE TYPE "ticket_assignment_type" AS ENUM
  ('manual', 'reassignment', 'declined', 'automatic', 'released');
CREATE TYPE "ticket_attachment_kind" AS ENUM ('report', 'before', 'after');
CREATE TYPE "ticket_feedback_kind" AS ENUM ('confirmed', 'rejected', 'reopened');

-- ----------------------------------------------------------------------------
-- Categories: the compound's own data, seeded with five defaults.
-- ----------------------------------------------------------------------------
CREATE TABLE "ticket_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "default_priority" "ticket_priority" NOT NULL DEFAULT 'normal',
    "common_area_allowed" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_categories_tenant_id_id_key" ON "ticket_categories"("tenant_id", "id");
CREATE UNIQUE INDEX "ticket_categories_tenant_id_key_key" ON "ticket_categories"("tenant_id", "key");
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);

-- ----------------------------------------------------------------------------
-- Settings and the ticket number counter: one row per compound each.
-- ----------------------------------------------------------------------------
CREATE TABLE "maintenance_settings" (
    "tenant_id" UUID NOT NULL,
    "auto_close_hours" INTEGER NOT NULL DEFAULT 72,
    "reopen_days" INTEGER NOT NULL DEFAULT 7,
    "max_report_photos" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_ranges"
  CHECK ("auto_close_hours" BETWEEN 1 AND 720
     AND "reopen_days" BETWEEN 1 AND 90
     AND "max_report_photos" BETWEEN 1 AND 10);

-- Taken with INSERT … ON CONFLICT DO UPDATE … RETURNING in the creating
-- transaction: the row lock serializes creations, a rollback returns the
-- number. MT-000123 is rendered from it.
CREATE TABLE "ticket_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_last_number_non_negative"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- Tickets.
-- ----------------------------------------------------------------------------
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID,
    "common_area" TEXT,
    "category_id" UUID NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "reporter_account_id" UUID NOT NULL,
    "priority" "ticket_priority" NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'new',
    "hold_reason" "ticket_hold_reason",
    "confirmation_status" "ticket_confirmation_status",
    "technician_account_id" UUID,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "rejection_count" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "assigned_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tickets_tenant_id_id_key" ON "tickets"("tenant_id", "id");
CREATE UNIQUE INDEX "tickets_tenant_id_number_key" ON "tickets"("tenant_id", "number");
CREATE INDEX "tickets_tenant_id_status_created_at_idx"
  ON "tickets"("tenant_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "tickets_tenant_id_technician_idx"
  ON "tickets"("tenant_id", "technician_account_id", "status");
CREATE INDEX "tickets_tenant_id_reporter_idx" ON "tickets"("tenant_id", "reporter_account_id");
CREATE INDEX "tickets_tenant_id_created_by_idx" ON "tickets"("tenant_id", "created_by_account_id");
CREATE INDEX "tickets_tenant_id_unit_id_idx" ON "tickets"("tenant_id", "unit_id");
-- What the auto-close sweep walks.
CREATE INDEX "tickets_awaiting_confirmation_idx"
  ON "tickets"("tenant_id", "completed_at") WHERE "status" = 'completed';
ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tickets_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tickets_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tickets_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reporter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tickets_tenant_id_technician_fkey"
  FOREIGN KEY ("tenant_id", "technician_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_number_positive" CHECK ("number" > 0);
-- A unit or a common area, never both, never neither.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_location"
  CHECK (("unit_id" IS NULL) <> ("common_area" IS NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_common_area_length"
  CHECK ("common_area" IS NULL OR char_length("common_area") BETWEEN 1 AND 120);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_description_length"
  CHECK (char_length("description") BETWEEN 1 AND 2000);
-- The queue has no technician; work in hand and done work have one; a
-- cancelled ticket may have either.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_technician_matches_status"
  CHECK (("status" = 'new' AND "technician_account_id" IS NULL)
      OR ("status" IN ('assigned', 'in_progress', 'on_hold', 'completed', 'closed')
          AND "technician_account_id" IS NOT NULL)
      OR "status" = 'cancelled');
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_at_matches_technician"
  CHECK (("technician_account_id" IS NULL) = ("assigned_at" IS NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_hold_reason_matches_status"
  CHECK (("status" = 'on_hold') = ("hold_reason" IS NOT NULL));
-- Completed means waiting for the reporter; closed means confirmed or
-- auto-closed; a rejection is remembered until the next completion.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_completed_shape"
  CHECK (("status" = 'completed') = ("confirmation_status" IS NOT DISTINCT FROM 'pending')
     AND ("status" <> 'completed' OR "completed_at" IS NOT NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closed_shape"
  CHECK (("status" = 'closed') = ("confirmation_status" IS NOT DISTINCT FROM 'confirmed'
                                  OR "confirmation_status" IS NOT DISTINCT FROM 'auto_closed')
     AND ("status" = 'closed') = ("closed_at" IS NOT NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cancelled_shape"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_rejected_has_count"
  CHECK ("confirmation_status" IS DISTINCT FROM 'rejected' OR "rejection_count" > 0);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cycle_counts"
  CHECK ("cycle" >= 1 AND "rejection_count" >= 0 AND "rejection_count" < "cycle");

-- ----------------------------------------------------------------------------
-- History: append-only, no foreign keys.
-- ----------------------------------------------------------------------------
CREATE TABLE "ticket_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_status" "ticket_status",
    "to_status" "ticket_status" NOT NULL,
    "actor_account_id" UUID,
    "reason_code" TEXT,
    "cycle" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_status_history_ticket_idx"
  ON "ticket_status_history"("tenant_id", "ticket_id", "created_at", "id");
-- Only the creation row has no `from`; a status always changes.
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_from_shape"
  CHECK (("from_status" IS NULL AND "to_status" = 'new' AND "cycle" = 1)
      OR ("from_status" IS NOT NULL AND "from_status" <> "to_status"));
-- A hold carries its reason, which the SLA reads (Phase 5.3).
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_hold_has_reason"
  CHECK ("to_status" <> 'on_hold' OR "reason_code" IS NOT NULL);
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_cycle_positive"
  CHECK ("cycle" >= 1);

CREATE TABLE "ticket_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_account_id" UUID,
    "to_account_id" UUID,
    -- Who acted: the dispatcher, the technician on a decline, NULL for system.
    "assigned_by_account_id" UUID,
    "assignment_type" "ticket_assignment_type" NOT NULL,
    "reason_code" TEXT,
    "cycle" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_assignments_ticket_idx"
  ON "ticket_assignments"("tenant_id", "ticket_id", "created_at", "id");
-- Who declined a ticket: what the dispatch engine excludes (Phase 5.2).
CREATE INDEX "ticket_assignments_declined_idx"
  ON "ticket_assignments"("tenant_id", "ticket_id", "from_account_id")
  WHERE "assignment_type" = 'declined';
-- Every comparison of a nullable column is guarded by IS NOT NULL in the
-- same branch (the NULL trap, test/db/check-constraints).
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_type_shape"
  CHECK (
    ("assignment_type" = 'manual'
      AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL
      AND "assigned_by_account_id" IS NOT NULL)
    OR ("assignment_type" = 'reassignment'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL
      AND "from_account_id" <> "to_account_id"
      AND "assigned_by_account_id" IS NOT NULL AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'declined'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL
      AND "assigned_by_account_id" IS NOT NULL
      AND "assigned_by_account_id" = "from_account_id"
      AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'released'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL
      AND "assigned_by_account_id" IS NULL AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'automatic'
      AND "to_account_id" IS NOT NULL AND "assigned_by_account_id" IS NULL)
  );
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_cycle_positive"
  CHECK ("cycle" >= 1);

CREATE FUNCTION ticket_history_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (%)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER ticket_status_history_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_status_history"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_status_history_immutable_truncate
  BEFORE TRUNCATE ON "ticket_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_assignments_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_assignments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_assignments_immutable_truncate
  BEFORE TRUNCATE ON "ticket_assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Feedback, messages, photos.
-- ----------------------------------------------------------------------------
-- One confirmation or rejection per cycle, and the reopen of that cycle.
-- A rejection's or reopen's note is a message in the thread, not here.
CREATE TABLE "ticket_feedback" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "kind" "ticket_feedback_kind" NOT NULL,
    "author_account_id" UUID NOT NULL,
    "rating" INTEGER,
    "reason_code" TEXT,
    -- The confirmation's comment: content, erasable, never audited.
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_feedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_feedback_tenant_id_ticket_id_cycle_kind_key"
  ON "ticket_feedback"("tenant_id", "ticket_id", "cycle", "kind");
ALTER TABLE "ticket_feedback"
  ADD CONSTRAINT "ticket_feedback_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_feedback_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_rating_shape"
  CHECK (("kind" = 'confirmed') = ("rating" IS NOT NULL)
     AND ("rating" IS NULL OR "rating" BETWEEN 1 AND 5));
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_reason_shape"
  CHECK (("kind" = 'confirmed') = ("reason_code" IS NULL));
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_comment_shape"
  CHECK ("comment" IS NULL OR ("kind" = 'confirmed' AND char_length("comment") BETWEEN 1 AND 1000));
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_cycle_positive"
  CHECK ("cycle" >= 1);

CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    -- Never nulled: an erased sender stays a pointer to the tombstone.
    "sender_account_id" UUID NOT NULL,
    "body" TEXT,
    -- Staff only: never shown to a resident.
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_messages_ticket_idx"
  ON "ticket_messages"("tenant_id", "ticket_id", "created_at", "id");
CREATE INDEX "ticket_messages_sender_idx"
  ON "ticket_messages"("tenant_id", "sender_account_id");
ALTER TABLE "ticket_messages"
  ADD CONSTRAINT "ticket_messages_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_messages_tenant_id_sender_fkey"
  FOREIGN KEY ("tenant_id", "sender_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_deleted_shape"
  CHECK (("body" IS NULL) = ("deleted_at" IS NOT NULL));
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_body_length"
  CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000);

-- A file attached to a ticket belongs to the ticket (no owner): its
-- uploader's erasure leaves it, like a worker's photo (ADR 0029).
CREATE TABLE "ticket_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "ticket_attachment_kind" NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_attachments_file_id_key" ON "ticket_attachments"("file_id");
CREATE INDEX "ticket_attachments_ticket_idx"
  ON "ticket_attachments"("tenant_id", "ticket_id", "created_at", "id");
ALTER TABLE "ticket_attachments"
  ADD CONSTRAINT "ticket_attachments_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_cycle_positive"
  CHECK ("cycle" >= 1);

-- ----------------------------------------------------------------------------
-- The ticket_photo purpose: images only (the content-type CHECK already
-- allows a PDF for documents alone), 5 MB like the other photos.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           WHEN 'ticket_photo' THEN 5242880
           ELSE 10485760 END);

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted by the app.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "ticket_categories", "maintenance_settings", "ticket_counters",
  "tickets", "ticket_feedback", "ticket_messages", "ticket_attachments",
  "ticket_status_history", "ticket_assignments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_categories", "maintenance_settings",
  "ticket_counters", "tickets", "ticket_feedback", "ticket_messages",
  "ticket_attachments" TO jiwar_app;
GRANT SELECT, INSERT ON "ticket_status_history", "ticket_assignments" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_categories', 'maintenance_settings',
    'ticket_counters', 'tickets', 'ticket_status_history', 'ticket_assignments',
    'ticket_feedback', 'ticket_messages', 'ticket_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_CATEGORIES in
-- src/maintenance/categories/default-categories.ts; a unit test keeps the
-- two in step). FORCE RLS applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "maintenance_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
    INSERT INTO "ticket_counters" ("tenant_id") VALUES (t."id");
    INSERT INTO "ticket_categories"
      ("id", "tenant_id", "key", "name_ar", "name_en", "default_priority",
       "common_area_allowed", "updated_at")
    SELECT gen_random_uuid(), t."id", c.key, c.name_ar, c.name_en,
           c.priority::"ticket_priority", true, CURRENT_TIMESTAMP
      FROM (VALUES
        ('plumbing', 'سباكة', 'Plumbing', 'normal'),
        ('electrical', 'كهرباء', 'Electrical', 'normal'),
        ('ac', 'تكييف', 'Air conditioning', 'normal'),
        ('carpentry', 'نجارة', 'Carpentry', 'normal'),
        ('general', 'أعمال عامة', 'General', 'normal')
      ) AS c(key, name_ar, name_en, priority);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
