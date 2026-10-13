-- ============================================================================
-- The welcome (ADR 0042): when a household starts living in a unit, its
-- primary is greeted once with the compound's own text: its rules, the
-- office hours and the emergency numbers, in English, Arabic or both.
-- The managers write it and may turn it off. No personal data here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The template: one row per compound, created with it and backfilled
-- below, empty. A language is whole or absent: all three texts or none.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_welcome_templates" (
    "tenant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rules_en" TEXT,
    "office_hours_en" TEXT,
    "emergency_en" TEXT,
    "rules_ar" TEXT,
    "office_hours_ar" TEXT,
    "emergency_ar" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "neighbour_welcome_templates_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "neighbour_welcome_templates" ADD CONSTRAINT "neighbour_welcome_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "neighbour_welcome_templates" ADD CONSTRAINT "neighbour_welcome_templates_whole_per_language"
  CHECK (("rules_en" IS NULL) = ("office_hours_en" IS NULL)
     AND ("rules_en" IS NULL) = ("emergency_en" IS NULL)
     AND ("rules_ar" IS NULL) = ("office_hours_ar" IS NULL)
     AND ("rules_ar" IS NULL) = ("emergency_ar" IS NULL));
ALTER TABLE "neighbour_welcome_templates" ADD CONSTRAINT "neighbour_welcome_templates_text_length"
  CHECK (("rules_en" IS NULL OR char_length("rules_en") BETWEEN 1 AND 4000)
     AND ("office_hours_en" IS NULL OR char_length("office_hours_en") BETWEEN 1 AND 1000)
     AND ("emergency_en" IS NULL OR char_length("emergency_en") BETWEEN 1 AND 1000)
     AND ("rules_ar" IS NULL OR char_length("rules_ar") BETWEEN 1 AND 4000)
     AND ("office_hours_ar" IS NULL OR char_length("office_hours_ar") BETWEEN 1 AND 1000)
     AND ("emergency_ar" IS NULL OR char_length("emergency_ar") BETWEEN 1 AND 1000));

-- ----------------------------------------------------------------------------
-- A welcome sent: one per household, which is to say one per occupancy
-- that began as its unit's primary. The unique index is what makes "once"
-- hold. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "neighbour_welcomes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occupancy_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "neighbour_welcomes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbour_welcomes_once_per_household"
  ON "neighbour_welcomes"("tenant_id", "occupancy_id");
CREATE INDEX "neighbour_welcomes_account_idx"
  ON "neighbour_welcomes"("tenant_id", "account_id");
ALTER TABLE "neighbour_welcomes"
  ADD CONSTRAINT "neighbour_welcomes_tenant_id_occupancy_id_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_welcomes_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "neighbour_welcomes_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER neighbour_welcomes_immutable_rows
  BEFORE UPDATE OR DELETE ON "neighbour_welcomes"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_welcomes_immutable_truncate
  BEFORE TRUNCATE ON "neighbour_welcomes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "neighbour_welcome_templates", "neighbour_welcomes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "neighbour_welcome_templates" TO jiwar_app;
GRANT SELECT, INSERT ON "neighbour_welcomes" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neighbour_welcome_templates', 'neighbour_welcomes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get the empty template a new one gets: on, and with
-- nothing to send until a manager writes it. FORCE RLS applies here too:
-- one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "neighbour_welcome_templates" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
