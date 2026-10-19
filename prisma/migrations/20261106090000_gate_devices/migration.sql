-- ============================================================================
-- Guard devices (ADR 0057). A guard's phone keeps the gate working without
-- network: it registers an Ed25519 public key under the compound, and every
-- bundle it downloads and every batch it uploads later is tied to that key.
--
-- A device is the compound's, not a guard's: a phone kept at a gate serves
-- every guard who works there. `enrolled_by` says who registered it. The
-- management (`gate_devices.manage`) revokes one, once, with a code; a
-- revoked device downloads nothing, and what it uploads is quarantined for
-- the management to accept or reject.
--
-- The public key is kept as sent (the raw 32 bytes in base64url) and is
-- unique per compound; the private key never leaves the device. The label
-- is the management's own words ("Gate 1 phone"), never in the audit.
-- Never deleted: what a device recorded points at it.
-- ============================================================================

CREATE TABLE "gate_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "label" TEXT,
    "enrolled_by_account_id" UUID NOT NULL,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gate_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_devices_tenant_id_id_key"
  ON "gate_devices"("tenant_id", "id");
-- One device per key: a key registered twice is the same phone.
CREATE UNIQUE INDEX "gate_devices_public_key_key"
  ON "gate_devices"("tenant_id", "public_key");
-- The management's list, and the live count under the enrolment's lock.
CREATE INDEX "gate_devices_list_idx"
  ON "gate_devices"("tenant_id", "enrolled_at" DESC, "id" DESC);

ALTER TABLE "gate_devices"
  ADD CONSTRAINT "gate_devices_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_devices_enrolled_by_fkey"
    FOREIGN KEY ("tenant_id", "enrolled_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_devices_revoked_by_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_devices"
  -- The raw 32 bytes of an Ed25519 public key, base64url without padding.
  ADD CONSTRAINT "gate_devices_public_key_shape"
    CHECK ("public_key" ~ '^[A-Za-z0-9_-]{43}$'),
  ADD CONSTRAINT "gate_devices_label"
    CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 40),
  -- Revoked means when, by whom and why, all three or none.
  ADD CONSTRAINT "gate_devices_revoke_shape"
    CHECK (num_nonnulls("revoked_at", "revoked_by_account_id", "revoke_reason") IN (0, 3)
       AND ("revoked_at" IS NULL OR "revoked_at" >= "enrolled_at")),
  -- REASON_CODES.gateDeviceRevoke.
  ADD CONSTRAINT "gate_devices_revoke_reason"
    CHECK ("revoke_reason" IS NULL
        OR "revoke_reason" IN ('lost', 'stolen', 'replaced', 'retired', 'compromised', 'other'));

-- Its key and its enrolment never change; it is revoked once. Never deleted.
CREATE FUNCTION gate_device_is_kept() RETURNS trigger
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
              AND NEW."revoke_reason" = OLD."revoke_reason")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_devices: a device keeps its key and is revoked once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_devices_kept
  BEFORE UPDATE OR DELETE ON "gate_devices"
  FOR EACH ROW EXECUTE FUNCTION gate_device_is_kept();
CREATE TRIGGER gate_devices_kept_truncate
  BEFORE TRUNCATE ON "gate_devices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_devices" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_devices" TO jiwar_app;
ALTER TABLE "gate_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_devices"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
