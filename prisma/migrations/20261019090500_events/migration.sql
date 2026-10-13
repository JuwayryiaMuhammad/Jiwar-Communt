-- ============================================================================
-- Events (ADR 0040): what the compound holds, and who said they are going.
--
-- Personal data here: `event_rsvps` (who answered, for which unit, with how
-- many guests). The staff see it as the attendee list; residents see counts.
-- An erasure deletes its account's answers.
-- ============================================================================

CREATE TYPE "event_rsvp_response" AS ENUM ('going', 'not_going');

-- ----------------------------------------------------------------------------
-- An event. Out from the moment it is written; never deleted: cancelled.
-- Its audience is a rule, as an announcement's.
-- ----------------------------------------------------------------------------
CREATE TABLE "community_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_en" TEXT,
    "description_en" TEXT,
    "title_ar" TEXT,
    "description_ar" TEXT,
    "place" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "capacity" INTEGER,
    "audience_buildings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "audience_occupancy" "audience_occupancy" NOT NULL DEFAULT 'everyone',
    "attachment_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "community_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "community_events_tenant_id_id_key" ON "community_events"("tenant_id", "id");
CREATE INDEX "community_events_starts_idx" ON "community_events"("tenant_id", "starts_at", "id");
ALTER TABLE "community_events"
  ADD CONSTRAINT "community_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "community_events_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_languages"
  CHECK (("title_en" IS NULL) = ("description_en" IS NULL)
     AND ("title_ar" IS NULL) = ("description_ar" IS NULL)
     AND ("title_en" IS NOT NULL OR "title_ar" IS NOT NULL));
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_lengths"
  CHECK (("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 150)
     AND ("title_ar" IS NULL OR char_length("title_ar") BETWEEN 1 AND 150)
     AND ("description_en" IS NULL OR char_length("description_en") BETWEEN 1 AND 5000)
     AND ("description_ar" IS NULL OR char_length("description_ar") BETWEEN 1 AND 5000)
     AND char_length("place") BETWEEN 1 AND 200);
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_window"
  CHECK ("ends_at" > "starts_at");
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_capacity"
  CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 100000);
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_audience_buildings"
  CHECK (cardinality("audience_buildings") <= 50 AND array_position("audience_buildings", NULL) IS NULL);
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_attachments"
  CHECK (cardinality("attachment_ids") <= 5);
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_cancelled"
  CHECK (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN
           ('weather', 'low_attendance', 'venue_unavailable', 'organizer_unavailable', 'other')));

-- A file attached to an event belongs to it (no owner). Append-only: the
-- event lists the ones it shows.
CREATE TABLE "event_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_attachments_file_id_key" ON "event_attachments"("file_id");
CREATE INDEX "event_attachments_event_idx"
  ON "event_attachments"("tenant_id", "event_id", "created_at", "id");
ALTER TABLE "event_attachments"
  ADD CONSTRAINT "event_attachments_tenant_id_event_id_fkey"
  FOREIGN KEY ("tenant_id", "event_id") REFERENCES "community_events"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER event_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "event_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER event_attachments_immutable_truncate
  BEFORE TRUNCATE ON "event_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An answer: one per account and event, changed in place. Seats are
-- counted under the event's row lock: 1 + guests for each "going".
-- ----------------------------------------------------------------------------
CREATE TABLE "event_rsvps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "response" "event_rsvp_response" NOT NULL,
    "guests" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "event_rsvps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_rsvps_one_per_account"
  ON "event_rsvps"("tenant_id", "event_id", "account_id");
CREATE INDEX "event_rsvps_list_idx"
  ON "event_rsvps"("tenant_id", "event_id", "created_at", "id");
CREATE INDEX "event_rsvps_account_idx" ON "event_rsvps"("tenant_id", "account_id");
ALTER TABLE "event_rsvps"
  ADD CONSTRAINT "event_rsvps_tenant_id_event_id_fkey"
  FOREIGN KEY ("tenant_id", "event_id") REFERENCES "community_events"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_rsvps_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_rsvps_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Guests come with someone who is going.
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_guests"
  CHECK ("guests" BETWEEN 0 AND 20 AND ("response" = 'going' OR "guests" = 0));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. An answer is deleted only by its account's erasure.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "community_events", "event_attachments", "event_rsvps" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "community_events" TO jiwar_app;
GRANT SELECT, INSERT ON "event_attachments" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "event_rsvps" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['community_events', 'event_attachments', 'event_rsvps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
