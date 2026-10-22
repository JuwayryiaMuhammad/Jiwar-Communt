-- ============================================================================
-- Phase P1 — the partner catalogue (ADR 0060). The compound's external
-- service partners: what they do (a closed list of categories in code, the
-- compound's named sub-categories), their announced prices, weekly hours in
-- the compound's time zone, where in the compound they serve, the business
-- phone residents see, and their standing. Residents' favourites, and the
-- compound's partner settings.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, provisioned with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_settings" (
    "tenant_id" UUID NOT NULL,
    "new_days" INTEGER NOT NULL DEFAULT 30,
    "late_from_minute" INTEGER NOT NULL DEFAULT 1320,
    "max_live_requests" INTEGER NOT NULL DEFAULT 5,
    "rating_days" INTEGER NOT NULL DEFAULT 14,
    "complaint_days" INTEGER NOT NULL DEFAULT 14,
    "desk_link_days" INTEGER NOT NULL DEFAULT 90,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "partner_settings" ADD CONSTRAINT "partner_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_settings" ADD CONSTRAINT "partner_settings_ranges"
  CHECK ("new_days" BETWEEN 1 AND 90
     AND "late_from_minute" BETWEEN 960 AND 1439
     AND "max_live_requests" BETWEEN 1 AND 20
     AND "rating_days" BETWEEN 1 AND 60
     AND "complaint_days" BETWEEN 1 AND 60
     AND "desk_link_days" BETWEEN 7 AND 365);

-- ----------------------------------------------------------------------------
-- Sub-categories: the compound's names under each category of the closed
-- list (PARTNER_CATEGORIES in src/partners/categories.ts; a unit test keeps
-- the CHECK in step). The key and the category never change; retired with
-- `active`, never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_subcategories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_subcategories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_subcategories_tenant_id_id_key" ON "partner_subcategories"("tenant_id", "id");
-- Backs the services' composite key: a sub-category is named under its own
-- category only.
CREATE UNIQUE INDEX "partner_subcategories_tenant_id_id_category_key"
  ON "partner_subcategories"("tenant_id", "id", "category");
CREATE UNIQUE INDEX "partner_subcategories_key_key" ON "partner_subcategories"("tenant_id", "key");
ALTER TABLE "partner_subcategories" ADD CONSTRAINT "partner_subcategories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_subcategories" ADD CONSTRAINT "partner_subcategories_category"
  CHECK ("category" IN ('gas_water', 'pharmacy', 'grocery', 'home_services', 'laundry',
    'gardening', 'beauty_at_home', 'repair', 'pets', 'events', 'moving_storage',
    'car_services', 'elderly_care'));
ALTER TABLE "partner_subcategories" ADD CONSTRAINT "partner_subcategories_key_format"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "partner_subcategories" ADD CONSTRAINT "partner_subcategories_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "partner_subcategories" ADD CONSTRAINT "partner_subcategories_position_range"
  CHECK ("position" BETWEEN 0 AND 1000);

CREATE FUNCTION partner_subcategory_keeps_its_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."category" = OLD."category"
     AND NEW."key" = OLD."key"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_subcategories: a sub-category keeps its key and category and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_subcategories_keep_key
  BEFORE UPDATE OR DELETE ON "partner_subcategories"
  FOR EACH ROW EXECUTE FUNCTION partner_subcategory_keeps_its_key();
CREATE TRIGGER partner_subcategories_keep_key_truncate
  BEFORE TRUNCATE ON "partner_subcategories"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Partners. Names and descriptions are the compound's words; the business
-- phone is the one contact residents see; the notify email is the staff's
-- alone. `service_buildings` names the buildings served as the units name
-- them; empty is the whole compound. Never deleted: suspended with a reason
-- code, reinstated.
-- ----------------------------------------------------------------------------
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "business_phone" TEXT NOT NULL,
    "notify_email" TEXT,
    "service_buildings" TEXT[] NOT NULL DEFAULT '{}',
    "home_visit" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "suspended_reason" TEXT,
    "suspended_at" TIMESTAMPTZ(3),
    "suspended_by_account_id" UUID,
    "listed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partners_tenant_id_id_key" ON "partners"("tenant_id", "id");
CREATE INDEX "partners_listed_idx" ON "partners"("tenant_id", "listed_at" DESC, "id");
ALTER TABLE "partners"
  ADD CONSTRAINT "partners_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partners_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partners_tenant_id_suspended_by_fkey"
  FOREIGN KEY ("tenant_id", "suspended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partners" ADD CONSTRAINT "partners_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "partners" ADD CONSTRAINT "partners_descriptions_length"
  CHECK (("description_en" IS NULL OR char_length("description_en") BETWEEN 1 AND 1000)
     AND ("description_ar" IS NULL OR char_length("description_ar") BETWEEN 1 AND 1000));
ALTER TABLE "partners" ADD CONSTRAINT "partners_business_phone_e164"
  CHECK ("business_phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "partners" ADD CONSTRAINT "partners_notify_email_shape"
  CHECK ("notify_email" IS NULL
      OR (char_length("notify_email") BETWEEN 3 AND 254 AND "notify_email" ~ '^[^@\s]+@[^@\s]+$'));
ALTER TABLE "partners" ADD CONSTRAINT "partners_service_buildings"
  CHECK (cardinality("service_buildings") <= 50 AND array_position("service_buildings", NULL) IS NULL);
-- A suspended partner has its reason, time and who; an active one none.
-- The reasons' list is REASON_CODES.partnerSuspend.
ALTER TABLE "partners" ADD CONSTRAINT "partners_status_shape"
  CHECK (("status" = 'active'
          AND "suspended_reason" IS NULL AND "suspended_at" IS NULL
          AND "suspended_by_account_id" IS NULL)
      OR ("status" = 'suspended'
          AND "suspended_reason" IS NOT NULL AND "suspended_at" IS NOT NULL
          AND "suspended_by_account_id" IS NOT NULL));
ALTER TABLE "partners" ADD CONSTRAINT "partners_suspended_reason"
  CHECK ("suspended_reason" IS NULL
      OR "suspended_reason" IN ('quality_complaints', 'licence_issue', 'contract_ended',
        'partner_request', 'safety', 'other'));

CREATE FUNCTION partner_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."listed_at" = OLD."listed_at"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partners: a partner keeps its listing and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partners_kept
  BEFORE UPDATE OR DELETE ON "partners"
  FOR EACH ROW EXECUTE FUNCTION partner_is_kept();
CREATE TRIGGER partners_kept_truncate
  BEFORE TRUNCATE ON "partners"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- What a partner does: a category, and optionally one of its named
-- sub-categories (the composite key holds the sub-category to its own
-- category). Replaced as a whole under the partner's row lock.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_services" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory_id" UUID,
    CONSTRAINT "partner_services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_services_once_key"
  ON "partner_services"("tenant_id", "partner_id", "category", "subcategory_id") NULLS NOT DISTINCT;
CREATE INDEX "partner_services_category_idx" ON "partner_services"("tenant_id", "category", "partner_id");
ALTER TABLE "partner_services"
  ADD CONSTRAINT "partner_services_tenant_id_partner_id_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_services_subcategory_fkey"
  FOREIGN KEY ("tenant_id", "subcategory_id", "category")
  REFERENCES "partner_subcategories"("tenant_id", "id", "category")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_services" ADD CONSTRAINT "partner_services_category"
  CHECK ("category" IN ('gas_water', 'pharmacy', 'grocery', 'home_services', 'laundry',
    'gardening', 'beauty_at_home', 'repair', 'pets', 'events', 'moving_storage',
    'car_services', 'elderly_care'));

-- ----------------------------------------------------------------------------
-- Weekly hours, in the compound's time zone (weekday 0 is Sunday; minutes
-- after local midnight). A window ends on its day; open past midnight is a
-- window to 1440 and the next day's from 0. Replaced as a whole.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_hours" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    CONSTRAINT "partner_hours_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_hours_window_key"
  ON "partner_hours"("tenant_id", "partner_id", "weekday", "start_minute");
ALTER TABLE "partner_hours" ADD CONSTRAINT "partner_hours_tenant_id_partner_id_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_hours" ADD CONSTRAINT "partner_hours_window"
  CHECK ("weekday" BETWEEN 0 AND 6
     AND "start_minute" BETWEEN 0 AND 1439
     AND "end_minute" BETWEEN 1 AND 1440
     AND "start_minute" < "end_minute");

-- ----------------------------------------------------------------------------
-- The announced price list, in EGP. Replaced as a whole: a
-- request keeps its own copy of what it named (ADR 0060). The units' list is
-- PARTNER_PRICE_UNITS; `visit_fee` is what a home visit costs.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_price_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "subcategory_id" UUID,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "partner_price_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_price_items_tenant_id_id_key" ON "partner_price_items"("tenant_id", "id");
CREATE INDEX "partner_price_items_partner_idx" ON "partner_price_items"("tenant_id", "partner_id", "position");
ALTER TABLE "partner_price_items"
  ADD CONSTRAINT "partner_price_items_tenant_id_partner_id_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_price_items_tenant_id_subcategory_id_fkey"
  FOREIGN KEY ("tenant_id", "subcategory_id") REFERENCES "partner_subcategories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_price_items" ADD CONSTRAINT "partner_price_items_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "partner_price_items" ADD CONSTRAINT "partner_price_items_price_range"
  CHECK ("price" >= 0 AND "price" <= 999999.99);
ALTER TABLE "partner_price_items" ADD CONSTRAINT "partner_price_items_unit"
  CHECK ("unit" IN ('fixed', 'per_visit', 'visit_fee', 'per_hour', 'per_item', 'per_kg', 'per_sqm'));
ALTER TABLE "partner_price_items" ADD CONSTRAINT "partner_price_items_position_range"
  CHECK ("position" BETWEEN 0 AND 99);

-- ----------------------------------------------------------------------------
-- A resident's favourite partners: the account's own, never shown to
-- anyone else.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_favourites" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_favourites_pkey" PRIMARY KEY ("tenant_id", "account_id", "partner_id")
);
CREATE INDEX "partner_favourites_partner_idx" ON "partner_favourites"("tenant_id", "partner_id", "account_id");
ALTER TABLE "partner_favourites"
  ADD CONSTRAINT "partner_favourites_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_favourites_tenant_id_partner_id_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Partners and sub-categories are never deleted;
-- services, hours, prices and favourites are replaced or removed. The
-- partner's and the settings' rows are locked FOR UPDATE and FOR SHARE,
-- which needs UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "partner_settings", "partner_subcategories", "partners", "partner_services",
  "partner_hours", "partner_price_items", "partner_favourites" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "partner_settings", "partner_subcategories", "partners" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "partner_services", "partner_hours", "partner_price_items",
  "partner_favourites" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_settings', 'partner_subcategories', 'partners',
    'partner_services', 'partner_hours', 'partner_price_items', 'partner_favourites'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds: their settings row and the seeded sub-categories
-- (DEFAULT_SUBCATEGORIES in src/partners/setup/defaults.ts; a unit test
-- keeps the two in step).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "partner_settings" ("tenant_id") VALUES (t);
    INSERT INTO "partner_subcategories" ("id", "tenant_id", "category", "key", "name_en", "name_ar", "position")
    SELECT gen_random_uuid(), t, s.category, s.key, s.name_en, s.name_ar, s.position
      FROM (VALUES
        ('gas_water', 'gas_cylinders', 'Gas cylinders', 'أنابيب البوتاجاز', 0),
        ('gas_water', 'drinking_water', 'Drinking water', 'مياه الشرب', 1),
        ('pharmacy', 'medicines', 'Medicines', 'أدوية', 0),
        ('grocery', 'groceries', 'Groceries', 'بقالة', 0),
        ('grocery', 'fruit_vegetables', 'Fruit and vegetables', 'خضار وفاكهة', 1),
        ('home_services', 'cleaning', 'Cleaning', 'تنظيف', 0),
        ('home_services', 'pest_control', 'Pest control', 'مكافحة الحشرات', 1),
        ('home_services', 'air_conditioning', 'Air conditioning', 'تكييف', 2),
        ('laundry', 'laundry', 'Laundry', 'مغسلة', 0),
        ('laundry', 'carpets', 'Carpets', 'سجاد', 1),
        ('gardening', 'gardening', 'Gardening', 'تنسيق حدائق', 0),
        ('beauty_at_home', 'barber', 'Barber', 'حلاق', 0),
        ('beauty_at_home', 'salon', 'Salon', 'صالون تجميل', 1),
        ('repair', 'appliances', 'Appliances', 'أجهزة منزلية', 0),
        ('repair', 'phones', 'Phones', 'هواتف', 1),
        ('pets', 'pet_grooming', 'Grooming', 'العناية بالحيوانات', 0),
        ('pets', 'vet_visits', 'Vet visits', 'طبيب بيطري', 1),
        ('events', 'event_setup', 'Event setup', 'تجهيز المناسبات', 0),
        ('moving_storage', 'moving', 'Moving', 'نقل أثاث', 0),
        ('moving_storage', 'storage', 'Storage', 'تخزين', 1),
        ('car_services', 'car_wash', 'Car wash', 'غسيل سيارات', 0),
        ('car_services', 'car_maintenance', 'Car maintenance', 'صيانة سيارات', 1),
        ('elderly_care', 'home_care', 'Home care', 'رعاية منزلية', 0),
        ('elderly_care', 'nursing', 'Nursing', 'تمريض', 1)
      ) AS s(category, key, name_en, name_ar, position);
  END LOOP;
END $$;
