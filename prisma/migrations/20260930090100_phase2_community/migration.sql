-- AlterTable
ALTER TABLE "otp_challenges" ADD COLUMN     "purpose" "otp_purpose" NOT NULL DEFAULT 'login';


-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "ip" INET,
ADD COLUMN     "user_agent" TEXT;


-- AlterTable
ALTER TABLE "units" ADD COLUMN     "household_review_reason" TEXT,
ADD COLUMN     "needs_household_review" BOOLEAN NOT NULL DEFAULT false;


-- AlterTable
ALTER TABLE "unit_occupancies" ADD COLUMN     "is_primary" BOOLEAN NOT NULL DEFAULT false;


-- CreateTable
CREATE TABLE "invite_tokens" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("token_hash")
);


-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "family_join_requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "max_household_members" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);


-- CreateTable
CREATE TABLE "household_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID,
    "relation" "household_relation" NOT NULL,
    "is_minor" BOOLEAN NOT NULL,
    "full_name" TEXT,
    "national_id" TEXT,
    "birth_date" DATE NOT NULL,
    "status" "household_member_status" NOT NULL,
    "added_by" UUID NOT NULL,
    "removed_by" UUID,
    "removed_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "household_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "national_id" TEXT NOT NULL,
    "relation" "household_relation" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "household_invite_status" NOT NULL DEFAULT 'pending',
    "accepted_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "household_invites_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "household_delegations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "delegator_account_id" UUID NOT NULL,
    "delegate_account_id" UUID NOT NULL,
    "scopes" "delegation_scope"[],
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "end_reason" "delegation_end_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "household_delegations_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "domestic_workers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "national_id_hash" CHAR(64) NOT NULL,
    "national_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "birth_date" DATE NOT NULL,
    "preferred_language" TEXT NOT NULL DEFAULT 'ar',
    "banned_at" TIMESTAMPTZ(3),
    "banned_by" UUID,
    "ban_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "domestic_workers_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "worker_engagements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "capacity" "worker_capacity" NOT NULL,
    "schedule" JSONB NOT NULL,
    "valid_until" TIMESTAMPTZ(3),
    "status" "worker_engagement_status" NOT NULL DEFAULT 'pending_review',
    "status_reason" TEXT,
    "suspended_by_management" BOOLEAN NOT NULL DEFAULT false,
    "access_code_hash" CHAR(64),
    "code_issued_at" TIMESTAMPTZ(3),
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_engagements_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "worker_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "notice_key" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "worker_notice_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_notices_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "household_members_tenant_id_unit_id_idx" ON "household_members"("tenant_id", "unit_id");


-- CreateIndex
CREATE INDEX "household_members_tenant_id_account_id_idx" ON "household_members"("tenant_id", "account_id");


-- CreateIndex
CREATE UNIQUE INDEX "household_members_tenant_id_id_key" ON "household_members"("tenant_id", "id");


-- CreateIndex
CREATE UNIQUE INDEX "household_invites_token_hash_key" ON "household_invites"("token_hash");


-- CreateIndex
CREATE INDEX "household_invites_tenant_id_unit_id_idx" ON "household_invites"("tenant_id", "unit_id");


-- CreateIndex
CREATE INDEX "household_delegations_tenant_id_unit_id_idx" ON "household_delegations"("tenant_id", "unit_id");


-- CreateIndex
CREATE INDEX "household_delegations_tenant_id_delegate_account_id_idx" ON "household_delegations"("tenant_id", "delegate_account_id");


-- CreateIndex
CREATE UNIQUE INDEX "domestic_workers_tenant_id_national_id_hash_key" ON "domestic_workers"("tenant_id", "national_id_hash");


-- CreateIndex
CREATE UNIQUE INDEX "domestic_workers_tenant_id_id_key" ON "domestic_workers"("tenant_id", "id");


-- CreateIndex
CREATE INDEX "worker_engagements_tenant_id_unit_id_idx" ON "worker_engagements"("tenant_id", "unit_id");


-- CreateIndex
CREATE INDEX "worker_engagements_tenant_id_worker_id_idx" ON "worker_engagements"("tenant_id", "worker_id");


-- CreateIndex
CREATE UNIQUE INDEX "worker_engagements_tenant_id_id_key" ON "worker_engagements"("tenant_id", "id");


-- CreateIndex
CREATE INDEX "worker_notices_tenant_id_engagement_id_idx" ON "worker_notices"("tenant_id", "engagement_id");


-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_tenant_id_added_by_fkey" FOREIGN KEY ("tenant_id", "added_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_tenant_id_removed_by_fkey" FOREIGN KEY ("tenant_id", "removed_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_tenant_id_invited_by_fkey" FOREIGN KEY ("tenant_id", "invited_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_tenant_id_accepted_account_id_fkey" FOREIGN KEY ("tenant_id", "accepted_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_delegations" ADD CONSTRAINT "household_delegations_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_delegations" ADD CONSTRAINT "household_delegations_tenant_id_delegator_account_id_fkey" FOREIGN KEY ("tenant_id", "delegator_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_delegations" ADD CONSTRAINT "household_delegations_tenant_id_delegate_account_id_fkey" FOREIGN KEY ("tenant_id", "delegate_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "household_delegations" ADD CONSTRAINT "household_delegations_tenant_id_revoked_by_fkey" FOREIGN KEY ("tenant_id", "revoked_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "domestic_workers" ADD CONSTRAINT "domestic_workers_tenant_id_banned_by_fkey" FOREIGN KEY ("tenant_id", "banned_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_tenant_id_worker_id_fkey" FOREIGN KEY ("tenant_id", "worker_id") REFERENCES "domestic_workers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_tenant_id_requested_by_fkey" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_tenant_id_reviewed_by_fkey" FOREIGN KEY ("tenant_id", "reviewed_by") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_notices" ADD CONSTRAINT "worker_notices_tenant_id_worker_id_fkey" FOREIGN KEY ("tenant_id", "worker_id") REFERENCES "domestic_workers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddForeignKey
ALTER TABLE "worker_notices" ADD CONSTRAINT "worker_notices_tenant_id_engagement_id_fkey" FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Hand-written: constraints Prisma cannot express
-- ============================================================================

-- Primary resident (ADR 0016) ------------------------------------------------
-- The review flag always carries its reason.
ALTER TABLE "units"
  ADD CONSTRAINT "units_household_review_has_reason"
  CHECK ("needs_household_review" = ("household_review_reason" IS NOT NULL));

-- Tenant settings --------------------------------------------------------------
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_max_household_members_range"
  CHECK ("max_household_members" BETWEEN 1 AND 100);

-- Household members --------------------------------------------------------------
-- Adults: an account holds the personal data. Minors: no account, and the
-- name and national ID live on the membership.
ALTER TABLE "household_members"
  ADD CONSTRAINT "household_members_minor_or_account"
  CHECK (
    ("is_minor" AND "account_id" IS NULL
      AND "full_name" IS NOT NULL AND "national_id" IS NOT NULL)
    OR
    (NOT "is_minor" AND "account_id" IS NOT NULL
      AND "full_name" IS NULL AND "national_id" IS NULL)
  );
ALTER TABLE "household_members"
  ADD CONSTRAINT "household_members_removed_matches_status"
  CHECK (("status" = 'removed') = ("removed_at" IS NOT NULL));
ALTER TABLE "household_members"
  ADD CONSTRAINT "household_members_removed_has_reason"
  CHECK ("status" <> 'removed' OR "removed_reason" IS NOT NULL);
-- One open (pending or active) membership per unit and account.
CREATE UNIQUE INDEX "household_members_one_open_per_unit_account"
  ON "household_members" ("unit_id", "account_id")
  WHERE "status" IN ('pending_approval', 'active') AND "account_id" IS NOT NULL;

-- Household invites ----------------------------------------------------------------
ALTER TABLE "household_invites"
  ADD CONSTRAINT "household_invites_accepted_has_account"
  CHECK (("status" = 'accepted') = ("accepted_account_id" IS NOT NULL));

-- Delegations -------------------------------------------------------------------------
ALTER TABLE "household_delegations" ALTER COLUMN "scopes" SET NOT NULL;
ALTER TABLE "household_delegations"
  ADD CONSTRAINT "household_delegations_scopes_not_empty"
  CHECK (cardinality("scopes") > 0);
-- Time-boxed: never permanent, never more than a year.
ALTER TABLE "household_delegations"
  ADD CONSTRAINT "household_delegations_expiry_within_a_year"
  CHECK ("expires_at" > "created_at"
         AND "expires_at" <= "created_at" + interval '1 year');
ALTER TABLE "household_delegations"
  ADD CONSTRAINT "household_delegations_end_has_reason"
  CHECK (("revoked_at" IS NULL) = ("end_reason" IS NULL));
ALTER TABLE "household_delegations"
  ADD CONSTRAINT "household_delegations_not_to_self"
  CHECK ("delegator_account_id" <> "delegate_account_id");
-- At most one live (not ended) delegation per unit and delegate.
CREATE UNIQUE INDEX "household_delegations_one_live_per_delegate"
  ON "household_delegations" ("unit_id", "delegate_account_id")
  WHERE "revoked_at" IS NULL;

-- Domestic workers ----------------------------------------------------------------------
ALTER TABLE "domestic_workers"
  ADD CONSTRAINT "domestic_workers_ban_is_complete"
  CHECK (("banned_at" IS NULL) = ("ban_reason" IS NULL)
     AND ("banned_at" IS NULL) = ("banned_by" IS NULL));

ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "worker_engagements_temporary_has_end"
  CHECK ("capacity" <> 'temporary' OR "valid_until" IS NOT NULL);
-- An active engagement always has a code; a suspended one keeps it (it just
-- stops working); ended, rejected and pending ones have none.
ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "worker_engagements_code_matches_status"
  CHECK (
    ("status" = 'active' AND "access_code_hash" IS NOT NULL)
    OR "status" = 'suspended'
    OR ("status" IN ('pending_review', 'ended', 'rejected')
        AND "access_code_hash" IS NULL)
  );
ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "worker_engagements_management_suspension"
  CHECK (NOT "suspended_by_management" OR "status" = 'suspended');
-- A code is unique among the compound's ACTIVE engagements.
CREATE UNIQUE INDEX "worker_engagements_active_code"
  ON "worker_engagements" ("tenant_id", "access_code_hash")
  WHERE "status" = 'active';
-- One open engagement per worker and unit.
CREATE UNIQUE INDEX "worker_engagements_one_open_per_unit"
  ON "worker_engagements" ("worker_id", "unit_id")
  WHERE "status" IN ('pending_review', 'active', 'suspended');

-- ============================================================================
-- Backfill (FORCE RLS applies to the migrator too: set the tenant per row set)
-- ============================================================================
-- Every compound gets its settings row; every unit with active occupancies
-- gets its oldest one as primary.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "tenant_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING;
    UPDATE "unit_occupancies" SET "is_primary" = true
     WHERE "id" IN (
       SELECT DISTINCT ON ("unit_id") "id" FROM "unit_occupancies"
        WHERE "status" = 'active'
        ORDER BY "unit_id", "started_at", "id");
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- One primary per unit among active occupancies (after the backfill).
CREATE UNIQUE INDEX "unit_occupancies_one_primary_per_unit"
  ON "unit_occupancies" ("unit_id")
  WHERE "status" = 'active' AND "is_primary";

-- ============================================================================
-- Privileges (ADR 0005)
-- ============================================================================
-- Household and worker records are never deleted (status changes only), so
-- the app gets no DELETE on them. invite_tokens rows are deleted on
-- acceptance or revocation.
REVOKE ALL ON
  "tenant_settings", "household_members", "household_invites",
  "household_delegations", "domestic_workers", "worker_engagements",
  "worker_notices", "invite_tokens"
FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON
  "tenant_settings", "household_members", "household_invites",
  "household_delegations", "domestic_workers", "worker_engagements",
  "worker_notices"
TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invite_tokens" TO jiwar_app;

-- ============================================================================
-- Row-level security on the new tenant tables (ADR 0005)
-- ============================================================================
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "household_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_members"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "household_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_invites"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "household_delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_delegations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_delegations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "domestic_workers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domestic_workers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "domestic_workers"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "worker_engagements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_engagements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_engagements"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "worker_notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_notices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_notices"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

