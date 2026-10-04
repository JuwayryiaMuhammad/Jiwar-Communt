-- ============================================================================
-- Phase 5.2 — the dispatch engine (ADR 0033). Specialties, technician
-- availability, the dispatch settings and the engine's attempt log.
--
-- Only NEW tables and enums: no 5.1 table changes (ADR 0032 promised that).
-- `automatic` already exists in ticket_assignment_type and its CHECK fits.
--
-- Two history tables are append-only like ticket_assignments: SELECT and
-- INSERT for jiwar_app, triggers refuse UPDATE, DELETE and TRUNCATE for
-- every role, no foreign keys (a row outlives what it names).
-- ============================================================================

CREATE TYPE "technician_availability_state" AS ENUM ('available', 'unavailable');
CREATE TYPE "dispatch_trigger" AS ENUM
  ('created', 'declined', 'available', 'manual', 'sweep', 'role_lost', 'released');
CREATE TYPE "dispatch_outcome" AS ENUM ('assigned', 'no_candidate', 'skipped');

-- ----------------------------------------------------------------------------
-- Specialties: the compound's own data, like categories. Never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "specialties" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "specialties_tenant_id_id_key" ON "specialties"("tenant_id", "id");
CREATE UNIQUE INDEX "specialties_tenant_id_key_key" ON "specialties"("tenant_id", "key");
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);

-- Which specialties can handle a category (many to many). A category with
-- none can go to any technician.
CREATE TABLE "category_specialties" (
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "category_specialties_pkey" PRIMARY KEY ("tenant_id", "category_id", "specialty_id")
);
CREATE INDEX "category_specialties_specialty_idx"
  ON "category_specialties"("tenant_id", "specialty_id");
ALTER TABLE "category_specialties"
  ADD CONSTRAINT "category_specialties_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "category_specialties_tenant_id_specialty_id_fkey"
  FOREIGN KEY ("tenant_id", "specialty_id") REFERENCES "specialties"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- What a technician can do. Set by dispatchers; a row that is switched off
-- (active = false) is kept, so the set's history is not lost.
CREATE TABLE "technician_specialties" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "technician_specialties_pkey" PRIMARY KEY ("tenant_id", "account_id", "specialty_id")
);
CREATE INDEX "technician_specialties_specialty_idx"
  ON "technician_specialties"("tenant_id", "specialty_id");
ALTER TABLE "technician_specialties"
  ADD CONSTRAINT "technician_specialties_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_specialties_tenant_id_specialty_id_fkey"
  FOREIGN KEY ("tenant_id", "specialty_id") REFERENCES "specialties"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Availability: the current state (one row per technician; no row means
-- unavailable, so a technician opts in) and its append-only history.
-- ----------------------------------------------------------------------------
CREATE TABLE "technician_availability" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "state" "technician_availability_state" NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "technician_availability_pkey" PRIMARY KEY ("tenant_id", "account_id")
);
ALTER TABLE "technician_availability"
  ADD CONSTRAINT "technician_availability_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "technician_availability_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "from_state" "technician_availability_state",
    "to_state" "technician_availability_state" NOT NULL,
    -- The technician, a dispatcher, or NULL for the system (a deactivation).
    "changed_by_account_id" UUID,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "technician_availability_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "technician_availability_history_account_idx"
  ON "technician_availability_history"("tenant_id", "account_id", "created_at", "id");
ALTER TABLE "technician_availability_history"
  ADD CONSTRAINT "technician_availability_history_from_shape"
  CHECK ("from_state" IS NULL OR "from_state" <> "to_state");
-- Only the technician changes their own state without a reason: a
-- dispatcher's change and the system's carry a code. Guarded against the
-- NULL trap: a NULL actor must not satisfy the first branch.
ALTER TABLE "technician_availability_history"
  ADD CONSTRAINT "technician_availability_history_reason_shape"
  CHECK (("changed_by_account_id" IS NOT NULL AND "changed_by_account_id" = "account_id")
      OR "reason_code" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- Dispatch settings: one row per compound. Automatic dispatch is OFF in
-- every compound until the manager turns it on, so a deploy never changes
-- how an existing compound works and a new one (with no technician
-- specialties yet) does not fill with unassignable notices.
-- ----------------------------------------------------------------------------
CREATE TABLE "maintenance_dispatch_settings" (
    "tenant_id" UUID NOT NULL,
    "auto_dispatch_enabled" BOOLEAN NOT NULL DEFAULT false,
    "weight_assigned" NUMERIC(5,2) NOT NULL DEFAULT 1,
    "weight_in_progress" NUMERIC(5,2) NOT NULL DEFAULT 2,
    "weight_on_hold" NUMERIC(5,2) NOT NULL DEFAULT 0,
    "multiplier_normal" NUMERIC(5,2) NOT NULL DEFAULT 1,
    "multiplier_urgent" NUMERIC(5,2) NOT NULL DEFAULT 1.5,
    "multiplier_emergency" NUMERIC(5,2) NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_dispatch_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "maintenance_dispatch_settings"
  ADD CONSTRAINT "maintenance_dispatch_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_dispatch_settings"
  ADD CONSTRAINT "maintenance_dispatch_settings_ranges"
  CHECK ("weight_assigned" BETWEEN 0 AND 100
     AND "weight_in_progress" BETWEEN 0 AND 100
     AND "weight_on_hold" BETWEEN 0 AND 100
     AND "multiplier_normal" BETWEEN 0.1 AND 100
     AND "multiplier_urgent" BETWEEN 0.1 AND 100
     AND "multiplier_emergency" BETWEEN 0.1 AND 100);

-- ----------------------------------------------------------------------------
-- Every run of the engine on a ticket: why it was (not) assigned. Append-only.
-- `notified` marks the one row per ticket and cycle that told the
-- dispatchers the ticket is unassignable; the partial unique index makes
-- "once per cycle" a fact of the table, not only of the service.
-- ----------------------------------------------------------------------------
CREATE TABLE "ticket_dispatch_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "trigger" "dispatch_trigger" NOT NULL,
    "outcome" "dispatch_outcome" NOT NULL,
    "candidate_count" INTEGER NOT NULL,
    "technician_account_id" UUID,
    -- Only for `skipped`: why the engine did nothing.
    "reason_code" TEXT,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_dispatch_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_dispatch_attempts_ticket_idx"
  ON "ticket_dispatch_attempts"("tenant_id", "ticket_id", "created_at", "id");
CREATE UNIQUE INDEX "ticket_dispatch_attempts_one_notice_per_cycle"
  ON "ticket_dispatch_attempts"("tenant_id", "ticket_id", "cycle") WHERE "notified";
ALTER TABLE "ticket_dispatch_attempts" ADD CONSTRAINT "ticket_dispatch_attempts_shape"
  CHECK ("cycle" >= 1 AND "candidate_count" >= 0
     AND ("outcome" = 'assigned') = ("technician_account_id" IS NOT NULL)
     AND ("outcome" <> 'assigned' OR "candidate_count" >= 1)
     AND ("outcome" <> 'no_candidate' OR "candidate_count" = 0)
     AND ("outcome" = 'skipped') = ("reason_code" IS NOT NULL)
     AND (NOT "notified" OR "outcome" = 'no_candidate'));

CREATE TRIGGER technician_availability_history_immutable_rows
  BEFORE UPDATE OR DELETE ON "technician_availability_history"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER technician_availability_history_immutable_truncate
  BEFORE TRUNCATE ON "technician_availability_history"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_dispatch_attempts_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_dispatch_attempts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_dispatch_attempts_immutable_truncate
  BEFORE TRUNCATE ON "ticket_dispatch_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "specialties", "category_specialties", "technician_specialties",
  "technician_availability", "technician_availability_history",
  "maintenance_dispatch_settings", "ticket_dispatch_attempts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "specialties", "technician_specialties",
  "technician_availability", "maintenance_dispatch_settings" TO jiwar_app;
-- A pure link table: replacing a category's set deletes and inserts.
GRANT SELECT, INSERT, DELETE ON "category_specialties" TO jiwar_app;
GRANT SELECT, INSERT ON "technician_availability_history",
  "ticket_dispatch_attempts" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['specialties', 'category_specialties',
    'technician_specialties', 'technician_availability',
    'technician_availability_history', 'maintenance_dispatch_settings',
    'ticket_dispatch_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_SPECIALTIES and
-- DEFAULT_CATEGORY_SPECIALTIES in src/maintenance/specialties/
-- default-specialties.ts; a unit test keeps the two in step), with
-- automatic dispatch off. FORCE RLS applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "maintenance_dispatch_settings"
      ("tenant_id", "auto_dispatch_enabled", "updated_at")
      VALUES (t."id", false, CURRENT_TIMESTAMP);
    INSERT INTO "specialties" ("id", "tenant_id", "key", "name_ar", "name_en", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, CURRENT_TIMESTAMP
      FROM (VALUES
        ('plumbing', 'سباكة', 'Plumbing'),
        ('electrical', 'كهرباء', 'Electrical'),
        ('ac', 'تكييف', 'Air conditioning'),
        ('carpentry', 'نجارة', 'Carpentry'),
        ('general', 'أعمال عامة', 'General')
      ) AS s(key, name_ar, name_en);
    INSERT INTO "category_specialties" ("tenant_id", "category_id", "specialty_id")
    SELECT t."id", c."id", s."id"
      FROM "ticket_categories" c
      JOIN "specialties" s ON s."tenant_id" = c."tenant_id" AND s."key" = c."key"
     WHERE c."key" IN ('plumbing', 'electrical', 'ac', 'carpentry', 'general');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
