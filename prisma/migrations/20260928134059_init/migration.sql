-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('resident', 'staff', 'manager');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "identifier_type" AS ENUM ('email', 'phone');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_identifiers" (
    "identifier_hash" CHAR(64) NOT NULL,
    "identifier_type" "identifier_type" NOT NULL,
    "account_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_type" "account_type" NOT NULL,
    "status" "account_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_identifiers_pkey" PRIMARY KEY ("identifier_hash","account_id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "identifier_hash" CHAR(64) NOT NULL,
    "account_ids" UUID[],
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "account_type" NOT NULL,
    "full_name" TEXT NOT NULL,
    "national_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "account_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "building" TEXT,
    "floor" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_identifiers_account_id_idx" ON "login_identifiers"("account_id");

-- CreateIndex
CREATE INDEX "otp_challenges_identifier_hash_idx" ON "otp_challenges"("identifier_hash");

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "sessions"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_type_email_key" ON "accounts"("tenant_id", "type", "email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_type_phone_key" ON "accounts"("tenant_id", "type", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_code_key" ON "units"("tenant_id", "code");

-- AddForeignKey
ALTER TABLE "login_identifiers" ADD CONSTRAINT "login_identifiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_identifiers" ADD CONSTRAINT "login_identifiers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Privileges (ADR 0005)
-- ============================================================================
-- Explicit here as well as in init.sql's default privileges, so the grants do
-- not depend on how the database was created (e.g. the shadow database).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "tenants", "login_identifiers", "otp_challenges", "sessions",
  "accounts", "units"
TO jiwar_app;

-- Migration history is the migrator's business only. (Guarded: the shadow
-- database of `migrate dev` has no history table.)
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM jiwar_app;
  END IF;
END $$;

-- ============================================================================
-- Row-level security (ADR 0005)
-- ============================================================================
-- FORCE makes the policy apply to the table owner too. The tenant is set per
-- transaction with set_config('app.tenant_id', <id>, true); when it is unset
-- the comparison is against NULL, so reads return nothing and writes fail
-- WITH CHECK.
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "accounts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "units" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "units"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
