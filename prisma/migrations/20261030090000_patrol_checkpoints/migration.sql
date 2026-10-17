-- ============================================================================
-- Patrols (ADR 0052): the checkpoints a patrol scans.
-- ============================================================================
--
-- A checkpoint belongs to a post (a gate, or a zone: one of the places,
-- ADR 0050), has English and Arabic names and may have a position and a
-- radius. Its QR (and NFC tag) carries `JWK1.<id>.<token>`; the token is
-- 256 random bits and only its SHA-256 is kept, so the payload is shown
-- once, at creation and at a reissue. A reissue replaces the hash, so the
-- old printout stops working in that transaction. Retired, never deleted:
-- scans point at it.

CREATE TABLE "patrol_checkpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "radius_m" INTEGER,
    "token_hash" CHAR(64) NOT NULL,
    "token_issued_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patrol_checkpoints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_checkpoints_tenant_id_id_key" ON "patrol_checkpoints"("tenant_id", "id");
-- Two checkpoints in service never share a name, in either language.
CREATE UNIQUE INDEX "patrol_checkpoints_active_name_en_key"
  ON "patrol_checkpoints"("tenant_id", lower("name_en")) WHERE "retired_at" IS NULL;
CREATE UNIQUE INDEX "patrol_checkpoints_active_name_ar_key"
  ON "patrol_checkpoints"("tenant_id", "name_ar") WHERE "retired_at" IS NULL;
CREATE INDEX "patrol_checkpoints_list_idx" ON "patrol_checkpoints"("tenant_id", "created_at", "id");

ALTER TABLE "patrol_checkpoints"
  ADD CONSTRAINT "patrol_checkpoints_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_checkpoints_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_checkpoints_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_checkpoints_tenant_id_retired_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_checkpoints_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_checkpoints"
  -- At a gate or in a zone: exactly one.
  ADD CONSTRAINT "patrol_checkpoints_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  ADD CONSTRAINT "patrol_checkpoints_names_length"
    CHECK (char_length("name_en") BETWEEN 1 AND 60 AND char_length("name_ar") BETWEEN 1 AND 60),
  -- A position is a latitude, a longitude and a radius, together.
  ADD CONSTRAINT "patrol_checkpoints_position_shape"
    CHECK (("lat" IS NULL) = ("lng" IS NULL) AND ("lat" IS NULL) = ("radius_m" IS NULL)),
  ADD CONSTRAINT "patrol_checkpoints_position_range"
    CHECK ("lat" IS NULL
           OR ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180
               AND "radius_m" BETWEEN 5 AND 500)),
  ADD CONSTRAINT "patrol_checkpoints_token_hash_shape"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "patrol_checkpoints_retired_shape"
    CHECK (("retired_at" IS NULL) = ("retired_by_account_id" IS NULL));

-- Where it is never changes; it is retired once, never brought back; its
-- token changes only while it is in service. Never deleted.
CREATE FUNCTION patrol_checkpoint_is_kept() RETURNS trigger
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
              AND NEW."name_ar" = OLD."name_ar"
              AND NEW."lat" IS NOT DISTINCT FROM OLD."lat"
              AND NEW."lng" IS NOT DISTINCT FROM OLD."lng"
              AND NEW."radius_m" IS NOT DISTINCT FROM OLD."radius_m"
              AND NEW."token_hash" = OLD."token_hash"
              AND NEW."token_issued_at" = OLD."token_issued_at"))
     AND (NEW."token_hash" = OLD."token_hash"
          OR NEW."token_issued_at" > OLD."token_issued_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_checkpoints: its post never changes; it is retired once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_checkpoints_kept
  BEFORE UPDATE OR DELETE ON "patrol_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION patrol_checkpoint_is_kept();
CREATE TRIGGER patrol_checkpoints_kept_truncate
  BEFORE TRUNCATE ON "patrol_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_checkpoints" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "patrol_checkpoints" TO jiwar_app;

ALTER TABLE "patrol_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_checkpoints"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
