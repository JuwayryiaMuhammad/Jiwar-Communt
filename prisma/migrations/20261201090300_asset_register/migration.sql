-- ============================================================================
-- The asset register (ADR 0064).
--
-- asset_types         the compound's kinds of asset, seeded with defaults;
--                     each names the ticket category whose technicians
--                     work on it (the dispatch engine needs nothing new).
-- assets              one row per asset: in a unit or in a common area,
--                     under a parent (building → system → asset →
--                     component, four levels at most; a child is where its
--                     parent is). Its card's facts are plain data: the
--                     vendor's name and phone, the warranty, the values.
--                     Retired, never deleted. The tag is a token's hash.
-- asset_events        the asset's own history, append-only.
-- maintenance_documents  a plan, a manual, a warranty card: of an asset,
--                     an asset type or a common area. Removed once.
-- asset_imports       a sheet validated whole, then applied once.
-- ============================================================================

CREATE TABLE "asset_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "expected_life_years" SMALLINT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "asset_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_types_tenant_id_id_key" ON "asset_types"("tenant_id", "id");
CREATE UNIQUE INDEX "asset_types_tenant_id_key_key" ON "asset_types"("tenant_id", "key");
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_life_range"
  CHECK ("expected_life_years" IS NULL OR "expected_life_years" BETWEEN 1 AND 100);

CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type_id" UUID NOT NULL,
    "parent_id" UUID,
    "depth" SMALLINT NOT NULL,
    "unit_id" UUID,
    "common_area_id" UUID,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "commissioned_on" DATE,
    "purchase_value" DECIMAL(12,2),
    "replacement_cost" DECIMAL(12,2),
    "downtime_cost_per_day" DECIMAL(12,2),
    "expected_life_years" SMALLINT,
    "vendor_name" TEXT,
    "vendor_phone" TEXT,
    "warranty_ends_on" DATE,
    "warranty_alerted_for" DATE,
    "criticality" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'in_service',
    "status_reason" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'good',
    "serves_buildings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "retired_at" TIMESTAMPTZ(3),
    "tag_hash" TEXT,
    "tag_issued_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "assets_tenant_id_id_key" ON "assets"("tenant_id", "id");
CREATE UNIQUE INDEX "assets_tenant_id_code_key" ON "assets"("tenant_id", "code");
CREATE INDEX "assets_list_idx" ON "assets"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "assets_parent_idx" ON "assets"("tenant_id", "parent_id");
CREATE INDEX "assets_unit_idx" ON "assets"("tenant_id", "unit_id");
CREATE INDEX "assets_common_area_idx" ON "assets"("tenant_id", "common_area_id");
CREATE INDEX "assets_warranty_idx" ON "assets"("tenant_id", "warranty_ends_on")
  WHERE "warranty_ends_on" IS NOT NULL AND "status" <> 'retired';
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_type_id_fkey"
  FOREIGN KEY ("tenant_id", "type_id") REFERENCES "asset_types"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_parent_id_fkey"
  FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_common_area_id_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The creator is kept for the record; an erasure nulls it (the asset is
-- the compound's, never the person's).
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_created_by_account_id_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "assets" ADD CONSTRAINT "assets_code_shape"
  CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
ALTER TABLE "assets" ADD CONSTRAINT "assets_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 120 AND char_length("name_en") BETWEEN 1 AND 120);
ALTER TABLE "assets" ADD CONSTRAINT "assets_texts_length"
  CHECK (("manufacturer" IS NULL OR char_length("manufacturer") BETWEEN 1 AND 120)
     AND ("model" IS NULL OR char_length("model") BETWEEN 1 AND 120)
     AND ("serial_number" IS NULL OR char_length("serial_number") BETWEEN 1 AND 120)
     AND ("vendor_name" IS NULL OR char_length("vendor_name") BETWEEN 1 AND 120));
ALTER TABLE "assets" ADD CONSTRAINT "assets_vendor_phone_shape"
  CHECK ("vendor_phone" IS NULL OR "vendor_phone" ~ '^[0-9+() -]{3,30}$');
ALTER TABLE "assets" ADD CONSTRAINT "assets_values_range"
  CHECK (("purchase_value" IS NULL OR "purchase_value" >= 0)
     AND ("replacement_cost" IS NULL OR "replacement_cost" >= 0)
     AND ("downtime_cost_per_day" IS NULL OR "downtime_cost_per_day" >= 0));
ALTER TABLE "assets" ADD CONSTRAINT "assets_life_range"
  CHECK ("expected_life_years" IS NULL OR "expected_life_years" BETWEEN 1 AND 100);
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_one"
  CHECK (("unit_id" IS NULL) <> ("common_area_id" IS NULL));
ALTER TABLE "assets" ADD CONSTRAINT "assets_depth_shape"
  CHECK (("parent_id" IS NULL AND "depth" = 1)
      OR ("parent_id" IS NOT NULL AND "depth" BETWEEN 2 AND 4));
ALTER TABLE "assets" ADD CONSTRAINT "assets_not_own_parent"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "assets" ADD CONSTRAINT "assets_criticality_known"
  CHECK ("criticality" IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE "assets" ADD CONSTRAINT "assets_condition_known"
  CHECK ("condition" IN ('good', 'fair', 'poor', 'critical'));
-- In service has no reason; out of service has one of
-- REASON_CODES.assetOutOfService; retired one of assetRetire, and its time.
ALTER TABLE "assets" ADD CONSTRAINT "assets_status_shape"
  CHECK (("status" = 'in_service' AND "status_reason" IS NULL AND "retired_at" IS NULL)
      OR ("status" = 'out_of_service' AND "retired_at" IS NULL AND "status_reason" IS NOT NULL
          AND "status_reason" IN ('breakdown', 'awaiting_parts', 'safety', 'scheduled_works', 'other'))
      OR ("status" = 'retired' AND "retired_at" IS NOT NULL AND "status_reason" IS NOT NULL
          AND "status_reason" IN ('replaced', 'disposed', 'sold', 'transferred', 'created_in_error', 'other')));
ALTER TABLE "assets" ADD CONSTRAINT "assets_serves_buildings_size"
  CHECK (cardinality("serves_buildings") <= 50);
ALTER TABLE "assets" ADD CONSTRAINT "assets_warranty_alert_shape"
  CHECK ("warranty_alerted_for" IS NULL OR "warranty_ends_on" IS NOT NULL);
ALTER TABLE "assets" ADD CONSTRAINT "assets_tag_shape"
  CHECK (("tag_hash" IS NULL) = ("tag_issued_at" IS NULL));
ALTER TABLE "assets" ADD CONSTRAINT "assets_tag_hash_shape"
  CHECK ("tag_hash" IS NULL OR "tag_hash" ~ '^[0-9a-f]{64}$');

-- A retired asset stays retired, keeps its place and its parent.
CREATE FUNCTION "assets_retired_is_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'retired' AND (
       NEW."status" <> 'retired' OR NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
       OR NEW."status_reason" IS DISTINCT FROM OLD."status_reason") THEN
    RAISE EXCEPTION 'a retired asset stays retired' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."parent_id" IS DISTINCT FROM OLD."parent_id" OR NEW."depth" <> OLD."depth"
     OR NEW."code" <> OLD."code" OR NEW."type_id" <> OLD."type_id" THEN
    RAISE EXCEPTION 'an asset keeps its code, type and parent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "assets_retired_is_final" BEFORE UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION "assets_retired_is_final"();

CREATE TABLE "asset_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "reason_code" TEXT,
    "actor_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "asset_events_asset_idx"
  ON "asset_events"("tenant_id", "asset_id", "occurred_at" DESC, "id" DESC);
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenant_id_asset_id_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_kind_known"
  CHECK ("kind" IN ('created', 'imported', 'updated', 'condition_changed', 'status_changed', 'moved', 'retired', 'tag_issued'));
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_values_length"
  CHECK (("from_value" IS NULL OR char_length("from_value") <= 400)
     AND ("to_value" IS NULL OR char_length("to_value") <= 400));
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_reason_length"
  CHECK ("reason_code" IS NULL OR char_length("reason_code") BETWEEN 1 AND 40);
CREATE TRIGGER "asset_events_immutable_rows" BEFORE UPDATE OR DELETE ON "asset_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "asset_events_immutable_truncate" BEFORE TRUNCATE ON "asset_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "maintenance_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID,
    "asset_type_id" UUID,
    "common_area_id" UUID,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "added_by_account_id" UUID,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    CONSTRAINT "maintenance_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_documents_tenant_id_id_key" ON "maintenance_documents"("tenant_id", "id");
CREATE UNIQUE INDEX "maintenance_documents_file_id_key" ON "maintenance_documents"("file_id");
CREATE INDEX "maintenance_documents_asset_idx" ON "maintenance_documents"("tenant_id", "asset_id", "added_at");
CREATE INDEX "maintenance_documents_type_idx" ON "maintenance_documents"("tenant_id", "asset_type_id", "added_at");
CREATE INDEX "maintenance_documents_area_idx" ON "maintenance_documents"("tenant_id", "common_area_id", "added_at");
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_asset_type_fkey"
  FOREIGN KEY ("tenant_id", "asset_type_id") REFERENCES "asset_types"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_subject_one"
  CHECK (num_nonnulls("asset_id", "asset_type_id", "common_area_id") = 1);
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_kind_known"
  CHECK ("kind" IN ('plan', 'manual', 'warranty', 'certificate', 'photo', 'other'));
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_removed_shape"
  CHECK ("removed_at" IS NOT NULL OR "removed_by_account_id" IS NULL);

-- Only the removal is ever written, once.
CREATE FUNCTION "maintenance_documents_removed_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."file_id" = OLD."file_id"
     AND NEW."kind" = OLD."kind" AND NEW."title" = OLD."title"
     AND NEW."asset_id" IS NOT DISTINCT FROM OLD."asset_id"
     AND NEW."asset_type_id" IS NOT DISTINCT FROM OLD."asset_type_id"
     AND NEW."common_area_id" IS NOT DISTINCT FROM OLD."common_area_id"
     AND NEW."added_at" = OLD."added_at" THEN
    RETURN NEW;
  END IF;
  -- An erasure nulls who added or removed it, and nothing else.
  IF NEW."id" = OLD."id" AND NEW."file_id" = OLD."file_id" AND NEW."title" = OLD."title"
     AND NEW."removed_at" IS NOT DISTINCT FROM OLD."removed_at"
     AND (NEW."added_by_account_id" IS NULL OR NEW."added_by_account_id" = OLD."added_by_account_id")
     AND (NEW."removed_by_account_id" IS NULL OR NEW."removed_by_account_id" = OLD."removed_by_account_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a document is removed once, and never changed' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_documents_removed_once" BEFORE UPDATE ON "maintenance_documents"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_documents_removed_once"();
CREATE TRIGGER "maintenance_documents_no_delete" BEFORE DELETE ON "maintenance_documents"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "maintenance_documents_immutable_truncate" BEFORE TRUNCATE ON "maintenance_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "asset_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "applied_by_account_id" UUID,
    "applied_count" INTEGER,
    CONSTRAINT "asset_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_imports_tenant_id_id_key" ON "asset_imports"("tenant_id", "id");
CREATE UNIQUE INDEX "asset_imports_file_id_key" ON "asset_imports"("file_id");
CREATE INDEX "asset_imports_list_idx" ON "asset_imports"("tenant_id", "created_at" DESC, "id" DESC);
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_status_known"
  CHECK ("status" IN ('valid', 'invalid', 'applied'));
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_counts_range"
  CHECK ("row_count" BETWEEN 0 AND 2000 AND "error_count" >= 0
     AND jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 100);
-- Valid: no error, never applied; invalid: errors, never applied; applied:
-- once, with what it created.
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_state_shape"
  CHECK (("status" = 'valid' AND "error_count" = 0 AND "applied_at" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'invalid' AND "error_count" > 0 AND "applied_at" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'applied' AND "error_count" = 0 AND "applied_at" IS NOT NULL AND "applied_count" IS NOT NULL));

-- Who acted, in the same compound (composite keys, like every other
-- reference; an erasure nulls a person's columns, it deletes no account).
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_actor_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_documents" ADD CONSTRAINT "maintenance_documents_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_applied_by_fkey"
  FOREIGN KEY ("tenant_id", "applied_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Grants. Assets, documents and imports change in place under FOR UPDATE
-- (and are locked FOR SHARE by what points at them); events never change.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "asset_types", "assets", "asset_events", "maintenance_documents", "asset_imports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "asset_types", "assets", "maintenance_documents", "asset_imports" TO jiwar_app;
GRANT SELECT, INSERT ON "asset_events" TO jiwar_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['asset_types', 'assets', 'asset_events', 'maintenance_documents', 'asset_imports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get the default asset types a new one gets
-- (DEFAULT_ASSET_TYPES in src/maintenance/assets/default-asset-types.ts; a
-- unit test keeps the two in step), each joined to its category by key.
-- A compound without that category gets no such type rather than a failed
-- deploy. ON CONFLICT makes a rerun harmless. FORCE RLS: one compound at a
-- time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "asset_types"
      ("id", "tenant_id", "key", "name_ar", "name_en", "category_id",
       "expected_life_years", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, c."id",
           s.life, CURRENT_TIMESTAMP
      FROM (VALUES
        ('hvac', 'وحدة تكييف مركزي', 'HVAC unit', 'ac', 15),
        ('pump', 'مضخة', 'Pump', 'plumbing', 10),
        ('water_tank', 'خزان مياه', 'Water tank', 'plumbing', 20),
        ('irrigation', 'نظام ري', 'Irrigation system', 'plumbing', 10),
        ('pool_equipment', 'معدات حمام السباحة', 'Pool equipment', 'plumbing', 10),
        ('generator', 'مولد كهرباء', 'Generator', 'electrical', 20),
        ('electrical_panel', 'لوحة كهرباء', 'Electrical panel', 'electrical', 25),
        ('lighting', 'إنارة', 'Lighting', 'electrical', 10),
        ('elevator', 'مصعد', 'Elevator', 'general', 25),
        ('fire_system', 'نظام إطفاء الحريق', 'Fire system', 'general', 15),
        ('gate_barrier', 'حاجز البوابة', 'Gate barrier', 'general', 10),
        ('meter', 'عداد', 'Meter', 'general', 15)
      ) AS s(key, name_ar, name_en, category_key, life)
      JOIN "ticket_categories" c
        ON c."tenant_id" = t."id" AND c."key" = s.category_key
    ON CONFLICT ("tenant_id", "key") DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
