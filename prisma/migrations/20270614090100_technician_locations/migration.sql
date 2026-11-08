-- ============================================================================
-- The field team, part b (ADR 0090): a technician's last known location.
-- ============================================================================
--
-- * `technician_location_consents`: a technician's consent, given by
--   themselves and revocable, by themselves or the system (when they
--   leave). One live at a time (a partial unique index behind the
--   account's lock). Kept as the record of consent: times only, no
--   coordinates, never deleted.
-- * `technician_locations`: where they were at three moments of one of
--   their tickets — on the way, at the door, starting the work — and only
--   under a live consent, which the point names. Never continuous. Kept 30
--   days, then purged by a sweep; removed with the consent's revocation and
--   with the person's erasure. Never changed.

CREATE TABLE "technician_location_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" TEXT,

    CONSTRAINT "technician_location_consents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_location_consents_tenant_id_id_key"
  ON "technician_location_consents" ("tenant_id", "id");
-- One live consent per technician.
CREATE UNIQUE INDEX "technician_location_consents_one_live_key"
  ON "technician_location_consents" ("tenant_id", "account_id")
  WHERE "revoked_at" IS NULL;
CREATE INDEX "technician_location_consents_account_idx"
  ON "technician_location_consents" ("tenant_id", "account_id", "granted_at" DESC);

ALTER TABLE "technician_location_consents"
  ADD CONSTRAINT "technician_location_consents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_location_consents_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_location_consents_revoked_shape"
    CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL)
       AND ("revoked_by" IS NULL OR "revoked_by" IN ('self', 'system'))
       AND ("revoked_at" IS NULL OR "revoked_at" >= "granted_at"));

-- A consent keeps who and when; it is revoked once, and never deleted.
CREATE FUNCTION technician_location_consent_revoked_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."granted_at" = OLD."granted_at"
     AND OLD."revoked_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'technician_location_consents: a consent is revoked once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER technician_location_consents_revoked_once
  BEFORE UPDATE OR DELETE ON "technician_location_consents"
  FOR EACH ROW EXECUTE FUNCTION technician_location_consent_revoked_once();
CREATE TRIGGER technician_location_consents_revoked_once_truncate
  BEFORE TRUNCATE ON "technician_location_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "technician_location_consents" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "technician_location_consents" TO jiwar_app;

ALTER TABLE "technician_location_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "technician_location_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "technician_location_consents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------

CREATE TABLE "technician_locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "consent_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "moment" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy_m" INTEGER,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_locations_tenant_id_id_key"
  ON "technician_locations" ("tenant_id", "id");
-- The last known one, and the technician's own.
CREATE INDEX "technician_locations_account_idx"
  ON "technician_locations" ("tenant_id", "account_id", "captured_at" DESC, "id" DESC);
-- The 30 days' purge.
CREATE INDEX "technician_locations_captured_idx"
  ON "technician_locations" ("tenant_id", "captured_at");

ALTER TABLE "technician_locations"
  ADD CONSTRAINT "technician_locations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_locations_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_locations_consent_fkey"
    FOREIGN KEY ("tenant_id", "consent_id") REFERENCES "technician_location_consents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_locations_ticket_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_locations_moment"
    CHECK ("moment" IN ('en_route', 'arrived', 'started')),
  ADD CONSTRAINT "technician_locations_coordinates"
    CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "technician_locations_accuracy"
    CHECK ("accuracy_m" IS NULL OR "accuracy_m" BETWEEN 0 AND 10000);

-- A point is never changed: kept as captured, then deleted.
CREATE FUNCTION technician_location_is_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'technician_locations: a point is never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER technician_locations_fixed
  BEFORE UPDATE ON "technician_locations"
  FOR EACH ROW EXECUTE FUNCTION technician_location_is_fixed();

REVOKE ALL ON "technician_locations" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "technician_locations" TO jiwar_app;

ALTER TABLE "technician_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "technician_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "technician_locations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
