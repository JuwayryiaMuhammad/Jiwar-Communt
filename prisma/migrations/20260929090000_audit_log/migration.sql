-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('account', 'platform_admin', 'system');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "changes" JSONB,
    "request_id" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "metadata" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "target_tenant_id" UUID,
    "changes" JSONB,
    "request_id" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "metadata" JSONB,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "identifier_hash" CHAR(64),
    "account_id" UUID,
    "tenant_id" UUID,
    "platform_admin_id" UUID,
    "ip" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_occurred_at_id_idx" ON "audit_log"("tenant_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_target_type_target_id_idx" ON "audit_log"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_actor_id_idx" ON "audit_log"("tenant_id", "actor_id");

-- CreateIndex
CREATE INDEX "platform_audit_log_occurred_at_id_idx" ON "platform_audit_log"("occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_log_target_tenant_id_idx" ON "platform_audit_log"("target_tenant_id");

-- CreateIndex
CREATE INDEX "platform_audit_log_target_type_target_id_idx" ON "platform_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "security_events_occurred_at_id_idx" ON "security_events"("occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "security_events_event_idx" ON "security_events"("event");

-- CreateIndex
CREATE INDEX "security_events_identifier_hash_idx" ON "security_events"("identifier_hash");


-- ============================================================================
-- Hand-written (ADR 0014)
-- ============================================================================

-- Only the system actor has no id.
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_id_matches_type"
  CHECK (("actor_type" = 'system') = ("actor_id" IS NULL));
ALTER TABLE "platform_audit_log"
  ADD CONSTRAINT "platform_audit_log_actor_id_matches_type"
  CHECK (("actor_type" = 'system') = ("actor_id" IS NULL));

-- Privileges: the schema's default privileges would hand jiwar_app
-- UPDATE/DELETE on new tables, so start from nothing and grant only what an
-- append-only log needs.
REVOKE ALL ON "audit_log", "platform_audit_log", "security_events" FROM jiwar_app;
GRANT SELECT, INSERT ON "audit_log", "platform_audit_log", "security_events" TO jiwar_app;

-- Immutability for every role, the owner included. (The owner can still
-- disable a trigger with DDL — a documented limit, see ADR 0014.)
CREATE FUNCTION audit_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are immutable (%, %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_immutable_rows
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_is_immutable();
CREATE TRIGGER audit_log_immutable_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_immutable();

CREATE TRIGGER platform_audit_log_immutable_rows
  BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_is_immutable();
CREATE TRIGGER platform_audit_log_immutable_truncate
  BEFORE TRUNCATE ON "platform_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_immutable();

CREATE TRIGGER security_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION audit_is_immutable();
CREATE TRIGGER security_events_immutable_truncate
  BEFORE TRUNCATE ON "security_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_immutable();

-- Row-level security on the tenant table (ADR 0005).
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
