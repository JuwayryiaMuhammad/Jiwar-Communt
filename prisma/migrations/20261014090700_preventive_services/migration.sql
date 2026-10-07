-- ============================================================================
-- Preventive services (ADR 0038): what a resident may book a check-up for.
-- The compound's own list, like its ticket categories: seeded with four
-- defaults, never deleted (`active = false` retires one), and each tied to
-- the category that says who can do the work.
-- ============================================================================

CREATE TABLE "preventive_services" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "preventive_services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "preventive_services_tenant_id_id_key"
  ON "preventive_services"("tenant_id", "id");
CREATE UNIQUE INDEX "preventive_services_tenant_id_key_key"
  ON "preventive_services"("tenant_id", "key");
ALTER TABLE "preventive_services" ADD CONSTRAINT "preventive_services_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "preventive_services" ADD CONSTRAINT "preventive_services_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "preventive_services" ADD CONSTRAINT "preventive_services_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "preventive_services" ADD CONSTRAINT "preventive_services_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);
ALTER TABLE "preventive_services" ADD CONSTRAINT "preventive_services_position_range"
  CHECK ("position" BETWEEN 0 AND 1000);

REVOKE ALL ON "preventive_services" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "preventive_services" TO jiwar_app;

ALTER TABLE "preventive_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preventive_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "preventive_services"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_PREVENTIVE_SERVICES in
-- src/maintenance/preventive/default-preventive-services.ts; a unit test
-- keeps the two in step). Each service joins the compound's category by its
-- key: categories are never deleted and their keys never change, so the
-- join finds it; a compound without that category gets no such service
-- rather than a failed deploy. ON CONFLICT makes a rerun, or a compound
-- provisioned in between, harmless. FORCE RLS: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "preventive_services"
      ("id", "tenant_id", "key", "name_ar", "name_en", "category_id",
       "position", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, c."id",
           s.position, CURRENT_TIMESTAMP
      FROM (VALUES
        ('ac_service', 'صيانة التكييف', 'AC service', 'ac', 1),
        ('water_heater', 'فحص السخان', 'Water heater', 'plumbing', 2),
        ('plumbing_check', 'فحص السباكة', 'Plumbing check', 'plumbing', 3),
        ('electrical_check', 'فحص الكهرباء', 'Electrical check', 'electrical', 4)
      ) AS s(key, name_ar, name_en, category_key, position)
      JOIN "ticket_categories" c
        ON c."tenant_id" = t."id" AND c."key" = s.category_key
    ON CONFLICT ("tenant_id", "key") DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
