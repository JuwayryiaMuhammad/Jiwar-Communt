-- CreateEnum
CREATE TYPE "locale" AS ENUM ('ar', 'en');

-- CreateEnum
CREATE TYPE "occupancy_type" AS ENUM ('owner', 'tenant');

-- CreateEnum
CREATE TYPE "occupancy_status" AS ENUM ('active', 'ended');

-- CreateEnum
CREATE TYPE "platform_admin_status" AS ENUM ('active', 'disabled');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "preferred_locale" "locale" NOT NULL DEFAULT 'ar',
ADD COLUMN     "role_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "status" "platform_admin_status" NOT NULL DEFAULT 'active',
    "preferred_locale" "locale" NOT NULL DEFAULT 'ar',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "kind" "account_type" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "permissions_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "tenant_permission_catalog" (
    "tenant_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_permission_catalog_pkey" PRIMARY KEY ("tenant_id","permission")
);

-- CreateTable
CREATE TABLE "unit_occupancies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "occupancy_type" "occupancy_type" NOT NULL,
    "status" "occupancy_status" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_sessions_admin_id_idx" ON "platform_sessions"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_id_kind_key" ON "roles"("tenant_id", "id", "kind");

-- CreateIndex
CREATE INDEX "role_permissions_tenant_id_idx" ON "role_permissions"("tenant_id");

-- CreateIndex
CREATE INDEX "unit_occupancies_tenant_id_account_id_idx" ON "unit_occupancies"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "unit_occupancies_tenant_id_unit_id_idx" ON "unit_occupancies"("tenant_id", "unit_id");

-- CreateIndex
CREATE INDEX "accounts_tenant_id_role_id_idx" ON "accounts"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_id_key" ON "accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_id_key" ON "units"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_role_id_type_fkey" FOREIGN KEY ("tenant_id", "role_id", "type") REFERENCES "roles"("tenant_id", "id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_permission_catalog" ADD CONSTRAINT "tenant_permission_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_tenant_id_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Hand-written: constraints Prisma cannot express
-- ============================================================================

-- ADR 0012: at most one ACTIVE occupancy per (unit, account); ended ones stay.
CREATE UNIQUE INDEX "unit_occupancies_one_active_per_unit_account"
  ON "unit_occupancies" ("unit_id", "account_id")
  WHERE "status" = 'active';

-- ended_at is set exactly when the occupancy is ended.
ALTER TABLE "unit_occupancies"
  ADD CONSTRAINT "unit_occupancies_ended_at_matches_status"
  CHECK (("status" = 'ended') = ("ended_at" IS NOT NULL));

-- ============================================================================
-- Privileges (ADR 0005)
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "roles", "role_permissions", "tenant_permission_catalog", "unit_occupancies",
  "platform_admins", "platform_sessions"
TO jiwar_app;

-- ============================================================================
-- Row-level security on the new tenant tables (ADR 0005)
-- ============================================================================
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "roles"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role_permissions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_permission_catalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_permission_catalog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_permission_catalog"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "unit_occupancies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_occupancies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_occupancies"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
