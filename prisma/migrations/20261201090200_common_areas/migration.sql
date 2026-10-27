-- ============================================================================
-- Common areas (ADR 0064): the places of the compound that are not a unit,
-- for the asset register, the inspections and, later, the meters. Three
-- kinds:
--   building  a building as a whole; `building` is the units' own building
--             text (units.building), one row per building;
--   area      anything else: a garden, a roof, a pump room, a car park;
--             `building` is where it is, when it is in one;
--   facility  one of the facilities (ADR 0044), at most one row each.
-- Never deleted (assets point at them): `active = false` retires one. Its
-- QR tag (`JWL1.<id>.<token>`) is stored as the token's hash only; a new
-- tag replaces it. Names are the compound's words, never audited as text.
-- ============================================================================

CREATE TABLE "common_areas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "building" TEXT,
    "facility_id" UUID,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tag_hash" TEXT,
    "tag_issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "common_areas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "common_areas_tenant_id_id_key"
  ON "common_areas"("tenant_id", "id");
CREATE UNIQUE INDEX "common_areas_tenant_id_code_key"
  ON "common_areas"("tenant_id", "code");
CREATE UNIQUE INDEX "common_areas_one_per_building"
  ON "common_areas"("tenant_id", "building") WHERE "kind" = 'building';
CREATE UNIQUE INDEX "common_areas_one_per_facility"
  ON "common_areas"("tenant_id", "facility_id") WHERE "facility_id" IS NOT NULL;
CREATE INDEX "common_areas_list_idx"
  ON "common_areas"("tenant_id", "kind", "code");
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_kind_known"
  CHECK ("kind" IN ('building', 'area', 'facility'));
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_code_shape"
  CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_building_length"
  CHECK ("building" IS NULL OR char_length("building") BETWEEN 1 AND 80);
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_kind_shape"
  CHECK (("kind" = 'building' AND "building" IS NOT NULL AND "facility_id" IS NULL)
      OR ("kind" = 'area' AND "facility_id" IS NULL)
      OR ("kind" = 'facility' AND "facility_id" IS NOT NULL AND "building" IS NULL));
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_position_pair"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_position_range"
  CHECK ("latitude" IS NULL OR "longitude" IS NULL
      OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tag_shape"
  CHECK (("tag_hash" IS NULL) = ("tag_issued_at" IS NULL));
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tag_hash_shape"
  CHECK ("tag_hash" IS NULL OR "tag_hash" ~ '^[0-9a-f]{64}$');

-- Updated in place (names, retirement, a new tag) under FOR UPDATE.
REVOKE ALL ON "common_areas" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "common_areas" TO jiwar_app;

ALTER TABLE "common_areas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "common_areas" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "common_areas"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
