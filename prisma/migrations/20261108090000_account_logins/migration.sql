-- ============================================================================
-- Login history and known devices (ADR 0058).
--
-- A known device gains its coarse label (the OS family and the client: the
-- app or a browser family) and a revocation by its holder. A session names
-- the device it was started on, so revoking a device ends exactly its
-- sessions. `account_logins` records each login (never an IP, a user agent
-- or a place) for the holder's history; it is kept 90 days.
-- ============================================================================

ALTER TABLE "known_devices"
  ADD COLUMN "os" TEXT,
  ADD COLUMN "client" TEXT,
  ADD COLUMN "revoked_at" TIMESTAMPTZ(3);
-- Devices recorded before this phase: the app's are known to be the app;
-- the rest is read again at their next login.
UPDATE "known_devices"
   SET "os" = CASE "device_type" WHEN 'ios' THEN 'ios' WHEN 'android' THEN 'android' ELSE 'other' END,
       "client" = CASE "source" WHEN 'app' THEN 'app' ELSE 'other' END;
ALTER TABLE "known_devices"
  ALTER COLUMN "os" SET NOT NULL,
  ALTER COLUMN "client" SET NOT NULL;
ALTER TABLE "known_devices"
  ADD CONSTRAINT "known_devices_os_known"
    CHECK ("os" IN ('ios', 'android', 'windows', 'macos', 'linux', 'other')),
  ADD CONSTRAINT "known_devices_client_known"
    CHECK ("client" IN ('app', 'edge', 'opera', 'samsung', 'firefox', 'chrome', 'safari', 'other')),
  ADD CONSTRAINT "known_devices_client_source"
    CHECK (("client" = 'app') = ("source" = 'app'));

-- A session names its device (null for sessions started before this phase).
-- Sessions are global: the device is reached by the session's own tenant.
ALTER TABLE "sessions" ADD COLUMN "known_device_id" UUID;
CREATE UNIQUE INDEX "sessions_tenant_id_id_key" ON "sessions"("tenant_id", "id");
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_known_device_fkey"
  FOREIGN KEY ("tenant_id", "known_device_id") REFERENCES "known_devices"("tenant_id", "id")
  ON DELETE SET NULL ("known_device_id") ON UPDATE RESTRICT;
CREATE INDEX "sessions_known_device_id_idx" ON "sessions"("known_device_id")
  WHERE "known_device_id" IS NOT NULL;

CREATE TABLE "account_logins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "known_device_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_logins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_logins_tenant_id_id_key" ON "account_logins"("tenant_id", "id");
CREATE UNIQUE INDEX "account_logins_session_key" ON "account_logins"("tenant_id", "session_id");
CREATE INDEX "account_logins_account_idx"
  ON "account_logins"("tenant_id", "account_id", "created_at" DESC, "id" DESC);
CREATE INDEX "account_logins_created_idx" ON "account_logins"("tenant_id", "created_at");
ALTER TABLE "account_logins"
  ADD CONSTRAINT "account_logins_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- An erasure deletes the devices and the sessions, and the history with them.
  ADD CONSTRAINT "account_logins_device_fkey"
    FOREIGN KEY ("tenant_id", "known_device_id") REFERENCES "known_devices"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_logins_session_fkey"
    FOREIGN KEY ("tenant_id", "session_id") REFERENCES "sessions"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

-- A login happened once: the row never changes (it is deleted by the
-- retention sweep or with the account).
CREATE OR REPLACE FUNCTION account_login_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account_logins: a login is recorded once and never changed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER account_logins_immutable
  BEFORE UPDATE ON "account_logins"
  FOR EACH ROW EXECUTE FUNCTION account_login_is_immutable();

REVOKE ALL ON "account_logins" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "account_logins" TO jiwar_app;
ALTER TABLE "account_logins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_logins" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_logins"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
