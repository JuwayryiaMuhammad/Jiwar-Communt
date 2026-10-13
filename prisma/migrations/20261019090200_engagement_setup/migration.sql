-- ============================================================================
-- Community life (ADR 0040): what every part of it stands on. One settings
-- row per compound, and the compound's closed list of suggestion topics.
-- No personal data here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "engagement_settings" (
    "tenant_id" UUID NOT NULL,
    "event_max_guests" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "engagement_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "engagement_settings" ADD CONSTRAINT "engagement_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "engagement_settings" ADD CONSTRAINT "engagement_settings_ranges"
  CHECK ("event_max_guests" BETWEEN 0 AND 20);

-- ----------------------------------------------------------------------------
-- Suggestion topics: a closed list per compound. Never deleted (a
-- suggestion points at its topic); retired with `active`.
-- ----------------------------------------------------------------------------
CREATE TABLE "suggestion_topics" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "suggestion_topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suggestion_topics_tenant_id_id_key"
  ON "suggestion_topics"("tenant_id", "id");
CREATE UNIQUE INDEX "suggestion_topics_tenant_id_key_key"
  ON "suggestion_topics"("tenant_id", "key");
ALTER TABLE "suggestion_topics" ADD CONSTRAINT "suggestion_topics_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "suggestion_topics" ADD CONSTRAINT "suggestion_topics_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "suggestion_topics" ADD CONSTRAINT "suggestion_topics_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);

-- ----------------------------------------------------------------------------
-- A community attachment: an image or a PDF, up to 10 MiB (the ELSE of the
-- size CHECK, unchanged). The content-type CHECK is recreated to let a PDF
-- through for this purpose too.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export'));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "engagement_settings", "suggestion_topics" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "engagement_settings", "suggestion_topics" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['engagement_settings', 'suggestion_topics'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_SUGGESTION_TOPICS in
-- src/engagement/settings/defaults.ts; a unit test keeps the two in step):
-- the settings row and six topics. FORCE RLS applies here too: one compound
-- at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "engagement_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
    INSERT INTO "suggestion_topics"
      ("id", "tenant_id", "key", "name_ar", "name_en", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, CURRENT_TIMESTAMP
      FROM (VALUES
        ('general', 'عام', 'General'),
        ('facilities', 'المرافق', 'Facilities'),
        ('security', 'الأمن', 'Security'),
        ('cleanliness_landscaping', 'النظافة والمساحات الخضراء', 'Cleanliness and landscaping'),
        ('events_activities', 'الفعاليات والأنشطة', 'Events and activities'),
        ('services', 'الخدمات', 'Services')
      ) AS s(key, name_ar, name_en);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
