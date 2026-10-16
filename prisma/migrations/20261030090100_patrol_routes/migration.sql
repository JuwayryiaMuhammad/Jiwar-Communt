-- ============================================================================
-- Patrols (ADR 0052): routes and their versions.
-- ============================================================================
--
-- A route is walked from a post (a gate, or a zone) and has English and
-- Arabic names. What it asks — its checkpoints in order, whether that
-- order is enforced, how long it takes, and its weekly start times — is a
-- version: changing any of it makes a new version, and a run keeps the
-- version it was made with. One version is current per route. Retired,
-- never deleted.

CREATE TABLE "patrol_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patrol_routes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_routes_tenant_id_id_key" ON "patrol_routes"("tenant_id", "id");
-- Two routes in service never share a name, in either language.
CREATE UNIQUE INDEX "patrol_routes_active_name_en_key"
  ON "patrol_routes"("tenant_id", lower("name_en")) WHERE "retired_at" IS NULL;
CREATE UNIQUE INDEX "patrol_routes_active_name_ar_key"
  ON "patrol_routes"("tenant_id", "name_ar") WHERE "retired_at" IS NULL;
CREATE INDEX "patrol_routes_list_idx" ON "patrol_routes"("tenant_id", "created_at", "id");

ALTER TABLE "patrol_routes"
  ADD CONSTRAINT "patrol_routes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_routes_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_routes_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_routes_tenant_id_retired_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_routes_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_routes"
  -- Walked from a gate or a zone: exactly one.
  ADD CONSTRAINT "patrol_routes_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  ADD CONSTRAINT "patrol_routes_names_length"
    CHECK (char_length("name_en") BETWEEN 1 AND 60 AND char_length("name_ar") BETWEEN 1 AND 60),
  ADD CONSTRAINT "patrol_routes_retired_shape"
    CHECK (("retired_at" IS NULL) = ("retired_by_account_id" IS NULL));

-- Its post never changes; renamed while in service; retired once, and then
-- nothing changes. Never deleted.
CREATE FUNCTION patrol_route_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."retired_at" IS NULL
          OR (NEW."retired_at" = OLD."retired_at"
              AND NEW."retired_by_account_id" = OLD."retired_by_account_id"
              AND NEW."name_en" = OLD."name_en"
              AND NEW."name_ar" = OLD."name_ar")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_routes: its post never changes; it is retired once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_routes_kept
  BEFORE UPDATE OR DELETE ON "patrol_routes"
  FOR EACH ROW EXECUTE FUNCTION patrol_route_is_kept();
CREATE TRIGGER patrol_routes_kept_truncate
  BEFORE TRUNCATE ON "patrol_routes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "patrol_route_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "ordered" BOOLEAN NOT NULL,
    "expected_minutes" INTEGER NOT NULL,
    -- `{"days": [0..6], "times": ["HH:MM", ...]}`, or none: runs only when
    -- a guard starts one.
    "schedule" JSONB,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "patrol_route_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_route_versions_tenant_id_id_key" ON "patrol_route_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "patrol_route_versions_number_key"
  ON "patrol_route_versions"("tenant_id", "route_id", "number");
-- One current version per route.
CREATE UNIQUE INDEX "patrol_route_versions_current_key"
  ON "patrol_route_versions"("tenant_id", "route_id") WHERE "superseded_at" IS NULL;

ALTER TABLE "patrol_route_versions"
  ADD CONSTRAINT "patrol_route_versions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_route_versions_tenant_id_route_id_fkey"
    FOREIGN KEY ("tenant_id", "route_id") REFERENCES "patrol_routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_route_versions_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_route_versions"
  ADD CONSTRAINT "patrol_route_versions_number_positive"
    CHECK ("number" >= 1),
  ADD CONSTRAINT "patrol_route_versions_expected_range"
    CHECK ("expected_minutes" BETWEEN 5 AND 480),
  ADD CONSTRAINT "patrol_route_versions_schedule_shape"
    CHECK ("schedule" IS NULL
           OR (jsonb_typeof("schedule") = 'object'
               AND jsonb_typeof("schedule" -> 'days') = 'array'
               AND jsonb_typeof("schedule" -> 'times') = 'array'));

-- What a version says never changes; it is superseded once.
CREATE FUNCTION patrol_route_version_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."route_id" = OLD."route_id"
     AND NEW."number" = OLD."number"
     AND NEW."ordered" = OLD."ordered"
     AND NEW."expected_minutes" = OLD."expected_minutes"
     AND NEW."schedule" IS NOT DISTINCT FROM OLD."schedule"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."superseded_at" IS NOT DISTINCT FROM OLD."superseded_at"
          OR (OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_route_versions: what a version says never changes; it is superseded once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_route_versions_kept
  BEFORE UPDATE OR DELETE ON "patrol_route_versions"
  FOR EACH ROW EXECUTE FUNCTION patrol_route_version_is_kept();
CREATE TRIGGER patrol_route_versions_kept_truncate
  BEFORE TRUNCATE ON "patrol_route_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "patrol_route_checkpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "checkpoint_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patrol_route_checkpoints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_route_checkpoints_tenant_id_id_key" ON "patrol_route_checkpoints"("tenant_id", "id");
CREATE UNIQUE INDEX "patrol_route_checkpoints_position_key"
  ON "patrol_route_checkpoints"("tenant_id", "version_id", "position");
CREATE UNIQUE INDEX "patrol_route_checkpoints_checkpoint_key"
  ON "patrol_route_checkpoints"("tenant_id", "version_id", "checkpoint_id");
CREATE INDEX "patrol_route_checkpoints_used_idx"
  ON "patrol_route_checkpoints"("tenant_id", "checkpoint_id");

ALTER TABLE "patrol_route_checkpoints"
  ADD CONSTRAINT "patrol_route_checkpoints_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_route_checkpoints_tenant_id_version_id_fkey"
    FOREIGN KEY ("tenant_id", "version_id") REFERENCES "patrol_route_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_route_checkpoints_tenant_id_checkpoint_id_fkey"
    FOREIGN KEY ("tenant_id", "checkpoint_id") REFERENCES "patrol_checkpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_route_checkpoints_position_range"
    CHECK ("position" BETWEEN 1 AND 50);
CREATE TRIGGER patrol_route_checkpoints_immutable
  BEFORE UPDATE OR DELETE ON "patrol_route_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER patrol_route_checkpoints_immutable_truncate
  BEFORE TRUNCATE ON "patrol_route_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_routes", "patrol_route_versions", "patrol_route_checkpoints" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "patrol_routes", "patrol_route_versions" TO jiwar_app;
GRANT SELECT, INSERT ON "patrol_route_checkpoints" TO jiwar_app;

ALTER TABLE "patrol_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_routes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "patrol_route_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_route_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_route_versions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "patrol_route_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_route_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_route_checkpoints"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
