-- ============================================================================
-- Neighbours (ADR 0042): what every part of it stands on. One settings row
-- per compound, and the compound's closed list of what a complaint against
-- a unit is about. No personal data here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_settings" (
    "tenant_id" UUID NOT NULL,
    "max_open_complaints" INTEGER NOT NULL DEFAULT 5,
    "lost_found_expiry_days" INTEGER NOT NULL DEFAULT 30,
    "lending_expiry_days" INTEGER NOT NULL DEFAULT 14,
    "max_open_posts" INTEGER NOT NULL DEFAULT 5,
    "max_new_conversations_per_day" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "neighbour_settings" ADD CONSTRAINT "neighbour_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_settings" ADD CONSTRAINT "neighbour_settings_ranges"
  CHECK ("max_open_complaints" BETWEEN 1 AND 50
     AND "lost_found_expiry_days" BETWEEN 1 AND 180
     AND "lending_expiry_days" BETWEEN 1 AND 90
     AND "max_open_posts" BETWEEN 1 AND 50
     AND "max_new_conversations_per_day" BETWEEN 1 AND 100);

-- ----------------------------------------------------------------------------
-- Complaint categories: a closed list per compound. Never deleted (a
-- complaint points at its category); retired with `active`.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_complaint_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_complaint_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_complaint_categories_tenant_id_id_key"
  ON "neighbour_complaint_categories"("tenant_id", "id");
CREATE UNIQUE INDEX "neighbour_complaint_categories_tenant_id_key_key"
  ON "neighbour_complaint_categories"("tenant_id", "key");
ALTER TABLE "neighbour_complaint_categories" ADD CONSTRAINT "neighbour_complaint_categories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_complaint_categories" ADD CONSTRAINT "neighbour_complaint_categories_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "neighbour_complaint_categories" ADD CONSTRAINT "neighbour_complaint_categories_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);

-- ----------------------------------------------------------------------------
-- A complaint's evidence: an image or a PDF, up to 10 MiB (the ELSE of the
-- size CHECK, unchanged). A board post's photo: an image, up to 5 MiB. The
-- content-type CHECK is recreated to let a PDF through as evidence; no
-- purpose takes a video. The size CHECK is recreated for the photo.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export'));
ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           WHEN 'ticket_photo' THEN 5242880
           WHEN 'parcel_photo' THEN 5242880
           WHEN 'neighbour_post_photo' THEN 5242880
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "neighbour_settings", "neighbour_complaint_categories" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "neighbour_settings", "neighbour_complaint_categories" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neighbour_settings', 'neighbour_complaint_categories'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_COMPLAINT_CATEGORIES
-- in src/neighbours/settings/defaults.ts; a unit test keeps the two in
-- step): the settings row and eight categories. FORCE RLS applies here
-- too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "neighbour_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
    INSERT INTO "neighbour_complaint_categories"
      ("id", "tenant_id", "key", "name_ar", "name_en", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, CURRENT_TIMESTAMP
      FROM (VALUES
        ('noise', 'ضوضاء', 'Noise'),
        ('parking', 'مواقف السيارات', 'Parking'),
        ('pets', 'حيوانات أليفة', 'Pets'),
        ('garbage', 'قمامة', 'Garbage'),
        ('smoking', 'تدخين', 'Smoking'),
        ('damage', 'أضرار', 'Damage'),
        ('rules', 'مخالفة القواعد', 'Breaking the rules'),
        ('other', 'أخرى', 'Other')
      ) AS s(key, name_ar, name_en);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
