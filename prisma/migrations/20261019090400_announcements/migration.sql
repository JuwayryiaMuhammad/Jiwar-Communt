-- ============================================================================
-- Announcements, and works and closures as a kind of them (ADR 0040).
--
-- Personal data here: none of a resident's. The texts are the staff's. Who
-- read an announcement is not stored: `announcement_read_marks` holds keyed
-- hashes, enough to count readers and to tell a reader they have read it,
-- and nothing a list of readers could be made from.
-- ============================================================================

CREATE TYPE "audience_occupancy" AS ENUM ('everyone', 'owners', 'tenants');
CREATE TYPE "announcement_kind" AS ENUM ('general', 'works');
CREATE TYPE "announcement_priority" AS ENUM ('normal', 'important');
CREATE TYPE "works_area_kind" AS ENUM ('road', 'facility', 'gate');
CREATE TYPE "read_mark_kind" AS ENUM ('account', 'unit');

-- ----------------------------------------------------------------------------
-- An announcement. Never deleted: archived. Its audience is a rule, read
-- against the residents as they are when someone asks (no list of people):
-- `audience_buildings` empty is the whole compound. What it says is its
-- current version's.
--
-- Draft while `publish_at` is NULL; scheduled while it is ahead; out from
-- then until it is archived, expires, or (works) ends.
-- ----------------------------------------------------------------------------
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "announcement_kind" NOT NULL,
    "priority" "announcement_priority" NOT NULL DEFAULT 'normal',
    "pinned_until" TIMESTAMPTZ(3),
    "publish_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "audience_buildings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "audience_occupancy" "audience_occupancy" NOT NULL DEFAULT 'everyone',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "edited_at" TIMESTAMPTZ(3),
    "notified_at" TIMESTAMPTZ(3),
    "works_starts_at" TIMESTAMPTZ(3),
    "works_ends_at" TIMESTAMPTZ(3),
    "works_area_kind" "works_area_kind",
    "works_gate_id" UUID,
    "works_place" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "announcements_tenant_id_id_key" ON "announcements"("tenant_id", "id");
CREATE INDEX "announcements_feed_idx" ON "announcements"("tenant_id", "publish_at", "id");
CREATE INDEX "announcements_created_idx" ON "announcements"("tenant_id", "created_at", "id");
ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcements_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcements_tenant_id_works_gate_id_fkey"
  FOREIGN KEY ("tenant_id", "works_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_version_positive"
  CHECK ("current_version" >= 1);
-- Only an important announcement is pinned.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_pin_is_important"
  CHECK ("pinned_until" IS NULL OR "priority" = 'important');
-- An expiry is a general announcement's; works end by their own dates. It
-- comes after the publication when both are set.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_expiry"
  CHECK ("expires_at" IS NULL
      OR ("kind" = 'general' AND ("publish_at" IS NULL OR "expires_at" > "publish_at")));
-- Works have their dates and their area; a general announcement has none.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_works_shape"
  CHECK (("kind" = 'works') = ("works_starts_at" IS NOT NULL)
     AND ("kind" = 'works') = ("works_ends_at" IS NOT NULL)
     AND ("kind" = 'works') = ("works_area_kind" IS NOT NULL)
     AND ("kind" = 'works' OR ("works_gate_id" IS NULL AND "works_place" IS NULL)));
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_works_window"
  CHECK ("works_starts_at" IS NULL OR "works_ends_at" IS NULL OR "works_ends_at" > "works_starts_at");
-- A gate is named only for works at a gate.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_works_gate"
  CHECK ("works_gate_id" IS NULL OR ("works_area_kind" IS NOT NULL AND "works_area_kind" = 'gate'));
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_works_place_length"
  CHECK ("works_place" IS NULL OR char_length("works_place") BETWEEN 1 AND 200);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_audience_buildings"
  CHECK (cardinality("audience_buildings") <= 50 AND array_position("audience_buildings", NULL) IS NULL);
-- Edited and announced only once it is out.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_out_first"
  CHECK (("edited_at" IS NULL AND "notified_at" IS NULL) OR "publish_at" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- What an announcement said, version by version. Append-only: an edit adds
-- a row and moves `announcements.current_version`; nothing is rewritten.
-- Each language is whole or absent, and at least one is there.
-- ----------------------------------------------------------------------------
CREATE TABLE "announcement_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title_en" TEXT,
    "body_en" TEXT,
    "title_ar" TEXT,
    "body_ar" TEXT,
    "attachment_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "edited_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "announcement_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "announcement_versions_announcement_version_key"
  ON "announcement_versions"("tenant_id", "announcement_id", "version");
ALTER TABLE "announcement_versions"
  ADD CONSTRAINT "announcement_versions_tenant_id_announcement_id_fkey"
  FOREIGN KEY ("tenant_id", "announcement_id") REFERENCES "announcements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcement_versions_tenant_id_edited_by_fkey"
  FOREIGN KEY ("tenant_id", "edited_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_version_positive"
  CHECK ("version" >= 1);
ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_languages"
  CHECK (("title_en" IS NULL) = ("body_en" IS NULL)
     AND ("title_ar" IS NULL) = ("body_ar" IS NULL)
     AND ("title_en" IS NOT NULL OR "title_ar" IS NOT NULL));
ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_lengths"
  CHECK (("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 150)
     AND ("title_ar" IS NULL OR char_length("title_ar") BETWEEN 1 AND 150)
     AND ("body_en" IS NULL OR char_length("body_en") BETWEEN 1 AND 5000)
     AND ("body_ar" IS NULL OR char_length("body_ar") BETWEEN 1 AND 5000));
ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_attachments"
  CHECK (cardinality("attachment_ids") <= 5);

CREATE TRIGGER announcement_versions_immutable_rows
  BEFORE UPDATE OR DELETE ON "announcement_versions"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER announcement_versions_immutable_truncate
  BEFORE TRUNCATE ON "announcement_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A file attached to an announcement belongs to it (no owner): its
-- uploader's erasure leaves it. Append-only: a version lists the
-- attachments it shows, so an older version still shows its own.
-- ----------------------------------------------------------------------------
CREATE TABLE "announcement_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "announcement_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "announcement_attachments_file_id_key"
  ON "announcement_attachments"("file_id");
CREATE INDEX "announcement_attachments_announcement_idx"
  ON "announcement_attachments"("tenant_id", "announcement_id", "created_at", "id");
ALTER TABLE "announcement_attachments"
  ADD CONSTRAINT "announcement_attachments_tenant_id_announcement_id_fkey"
  FOREIGN KEY ("tenant_id", "announcement_id") REFERENCES "announcements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcement_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcement_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER announcement_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "announcement_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER announcement_attachments_immutable_truncate
  BEFORE TRUNCATE ON "announcement_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Read marks: what the reader counts need, and no more. `ref` is
-- HMAC-SHA256(ENGAGEMENT_REF_SECRET, kind ‖ announcement ‖ account or
-- unit): the same reader marks once, two readers of one unit count as one
-- unit, and no column says who. No account, no unit, no time. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "announcement_read_marks" (
    "tenant_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "kind" "read_mark_kind" NOT NULL,
    "ref" BYTEA NOT NULL,
    CONSTRAINT "announcement_read_marks_pkey" PRIMARY KEY ("tenant_id", "announcement_id", "kind", "ref")
);
ALTER TABLE "announcement_read_marks"
  ADD CONSTRAINT "announcement_read_marks_tenant_id_announcement_id_fkey"
  FOREIGN KEY ("tenant_id", "announcement_id") REFERENCES "announcements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "announcement_read_marks" ADD CONSTRAINT "announcement_read_marks_ref_length"
  CHECK (octet_length("ref") = 32);

CREATE TRIGGER announcement_read_marks_immutable_rows
  BEFORE UPDATE OR DELETE ON "announcement_read_marks"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER announcement_read_marks_immutable_truncate
  BEFORE TRUNCATE ON "announcement_read_marks"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted; only an announcement's own
-- row is ever updated.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "announcements", "announcement_versions", "announcement_attachments",
  "announcement_read_marks" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "announcements" TO jiwar_app;
GRANT SELECT, INSERT ON "announcement_versions", "announcement_attachments",
  "announcement_read_marks" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['announcements', 'announcement_versions',
    'announcement_attachments', 'announcement_read_marks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
