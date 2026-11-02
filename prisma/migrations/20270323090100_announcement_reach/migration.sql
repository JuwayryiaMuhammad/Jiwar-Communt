-- ============================================================================
-- An announcement's reach (ADR 0080): single units as its audience, the one
-- reminder to those who have not opened it, and the compound's announcement
-- templates. No personal data here: a unit is an id, a template is staff's
-- words about nobody.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Units as the audience: an announcement put to these units' people (within
-- the occupancy chosen) instead of whole buildings. Empty: not by unit.
-- An array of the compound's unit ids, checked by the service when written
-- (no foreign key holds an array); units are never deleted (ADR 0012), so an
-- id stays one of the compound's. Fixed once the announcement is out, as the
-- rest of its audience (ADR 0040).
--
-- `reminded_at`: when its audience's non-readers were reminded, once ever;
-- only after it came out.
-- ----------------------------------------------------------------------------
ALTER TABLE "announcements"
  ADD COLUMN "audience_units" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "reminded_at" TIMESTAMPTZ(3);

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_audience_units"
  CHECK (cardinality("audience_units") <= 200
     AND (cardinality("audience_units") = 0 OR cardinality("audience_buildings") = 0)
     AND array_position("audience_units", NULL) IS NULL);
-- Every comparison on a nullable column sits beside its IS [NOT] NULL.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_reminded_after_publication"
  CHECK ("reminded_at" IS NULL
     OR ("publish_at" IS NOT NULL AND "reminded_at" >= "publish_at"));

-- The units' array is searched by the unit's correspondence (ADR 0080).
CREATE INDEX "announcements_audience_units_idx" ON "announcements" USING GIN ("audience_units");

-- ----------------------------------------------------------------------------
-- The compound's announcement templates: a name and the words, in English,
-- Arabic or both (a language whole or absent, as an announcement's versions
-- are). The composer copies one into a new draft; nothing points back at it,
-- so a template is changed and deleted freely.
-- ----------------------------------------------------------------------------
CREATE TABLE "announcement_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title_en" TEXT,
    "body_en" TEXT,
    "title_ar" TEXT,
    "body_ar" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "announcement_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "announcement_templates_tenant_id_id_key" ON "announcement_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "announcement_templates_tenant_id_name_key" ON "announcement_templates"("tenant_id", "name");
ALTER TABLE "announcement_templates"
  ADD CONSTRAINT "announcement_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "announcement_templates_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A language is whole or absent, and at least one is there; the lengths are
-- an announcement's (150 and 5000).
ALTER TABLE "announcement_templates" ADD CONSTRAINT "announcement_templates_text"
  CHECK (char_length("name") BETWEEN 1 AND 80
     AND ("title_en" IS NULL) = ("body_en" IS NULL)
     AND ("title_ar" IS NULL) = ("body_ar" IS NULL)
     AND ("title_en" IS NOT NULL OR "title_ar" IS NOT NULL)
     AND ("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 150)
     AND ("body_en" IS NULL OR char_length("body_en") BETWEEN 1 AND 5000)
     AND ("title_ar" IS NULL OR char_length("title_ar") BETWEEN 1 AND 150)
     AND ("body_ar" IS NULL OR char_length("body_ar") BETWEEN 1 AND 5000));

REVOKE ALL ON "announcement_templates" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "announcement_templates" TO jiwar_app;
ALTER TABLE "announcement_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "announcement_templates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
