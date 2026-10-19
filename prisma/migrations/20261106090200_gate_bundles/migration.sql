-- ============================================================================
-- The gate bundle (ADR 0057). A guard device on duty at a gate downloads
-- what the gate needs to decide entries without network: today's passes and
-- worker cards as tags it can check but not reverse, the lockdown state,
-- the banned and watched plates. The server signs it (Ed25519, its key's
-- version the key id); it is valid until the shift's planned end, 24 hours
-- at most; each device's bundles are numbered.
--
-- The server never keeps a bundle: `gate_offline_bundles` holds its number,
-- validity, key id, the SHA-256 of what was sent and how many of each
-- section, so an upload can name the bundle it decided with. Append-only.
--
-- `gate_device_envelopes` is the replay guard of what devices sign: the
-- SHA-256 of an envelope's signature, once per device. A row goes once
-- both its receipt and the time the device wrote in it are a day old (an
-- envelope is refused beyond a day either way).
-- ============================================================================

ALTER TABLE "gate_devices"
  ADD COLUMN "bundle_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_bundle_at" TIMESTAMPTZ(3);
ALTER TABLE "gate_devices"
  ADD CONSTRAINT "gate_devices_bundle_shape"
    CHECK ("bundle_version" >= 0
       AND (("bundle_version" = 0) = ("last_bundle_at" IS NULL)));

-- What a device has downloaded only grows.
CREATE OR REPLACE FUNCTION gate_device_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."public_key" = OLD."public_key"
     AND NEW."label" IS NOT DISTINCT FROM OLD."label"
     AND NEW."enrolled_by_account_id" = OLD."enrolled_by_account_id"
     AND NEW."enrolled_at" = OLD."enrolled_at"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."revoked_at" IS NULL
          OR (NEW."revoked_at" = OLD."revoked_at"
              AND NEW."revoked_by_account_id" = OLD."revoked_by_account_id"
              AND NEW."revoke_reason" = OLD."revoke_reason"))
     AND NEW."bundle_version" >= OLD."bundle_version"
     AND (OLD."last_bundle_at" IS NULL OR NEW."last_bundle_at" >= OLD."last_bundle_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_devices: a device keeps its key and is revoked once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TABLE "gate_offline_bundles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "shift_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "key_version" SMALLINT NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "counts" JSONB NOT NULL,
    CONSTRAINT "gate_offline_bundles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_offline_bundles_tenant_id_id_key"
  ON "gate_offline_bundles"("tenant_id", "id");
-- A device's bundles are numbered once each.
CREATE UNIQUE INDEX "gate_offline_bundles_version_key"
  ON "gate_offline_bundles"("tenant_id", "device_id", "version");
CREATE INDEX "gate_offline_bundles_shift_idx"
  ON "gate_offline_bundles"("tenant_id", "shift_id");

ALTER TABLE "gate_offline_bundles"
  ADD CONSTRAINT "gate_offline_bundles_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_bundles_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id") REFERENCES "gate_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_bundles_shift_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_bundles_gate_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_bundles_guard_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_offline_bundles"
  ADD CONSTRAINT "gate_offline_bundles_version_positive" CHECK ("version" > 0),
  -- Valid after it is issued, a day at most.
  ADD CONSTRAINT "gate_offline_bundles_validity"
    CHECK ("valid_until" > "issued_at"
       AND "valid_until" <= "issued_at" + interval '24 hours'),
  ADD CONSTRAINT "gate_offline_bundles_key_version"
    CHECK ("key_version" BETWEEN 1 AND 32767),
  ADD CONSTRAINT "gate_offline_bundles_sha256"
    CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  -- How many of each section: counts, never what they count.
  ADD CONSTRAINT "gate_offline_bundles_counts"
    CHECK (jsonb_typeof("counts") = 'object');

CREATE TRIGGER gate_offline_bundles_immutable_rows
  BEFORE UPDATE OR DELETE ON "gate_offline_bundles"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_offline_bundles_immutable_truncate
  BEFORE TRUNCATE ON "gate_offline_bundles"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_offline_bundles" FROM jiwar_app;
GRANT SELECT, INSERT ON "gate_offline_bundles" TO jiwar_app;
ALTER TABLE "gate_offline_bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_offline_bundles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_offline_bundles"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "gate_device_envelopes" (
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "signature_sha256" CHAR(64) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_device_envelopes_pkey" PRIMARY KEY ("tenant_id", "device_id", "signature_sha256")
);
-- The sweep's due rows.
CREATE INDEX "gate_device_envelopes_purge_idx"
  ON "gate_device_envelopes"(GREATEST("sent_at", "received_at"));

ALTER TABLE "gate_device_envelopes"
  ADD CONSTRAINT "gate_device_envelopes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_device_envelopes_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id") REFERENCES "gate_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_device_envelopes"
  ADD CONSTRAINT "gate_device_envelopes_sha256"
    CHECK ("signature_sha256" ~ '^[0-9a-f]{64}$');

-- Written once, deleted by the sweep; never changed.
CREATE FUNCTION gate_device_envelope_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gate_device_envelopes: an envelope is never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_device_envelopes_kept
  BEFORE UPDATE ON "gate_device_envelopes"
  FOR EACH ROW EXECUTE FUNCTION gate_device_envelope_is_kept();
CREATE TRIGGER gate_device_envelopes_kept_truncate
  BEFORE TRUNCATE ON "gate_device_envelopes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_device_envelopes" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "gate_device_envelopes" TO jiwar_app;
ALTER TABLE "gate_device_envelopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_device_envelopes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_device_envelopes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
