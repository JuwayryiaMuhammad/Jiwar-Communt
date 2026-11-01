-- ============================================================================
-- A deputy (ADR 0073, amending ADR 0010's one-role rule): while the holder
-- of a decision is away, another staff or manager account decides in their
-- place, for at most 30 days. The deputy gains the permissions named, out of
-- the principal's own role and never finance, governance, appeals, roles or
-- deputies; the principal loses them while it runs, so the two never decide
-- the same thing. Every action taken through a gained permission is audited
-- "on behalf of" the principal.
--
-- No personal data here: accounts, permission keys and instants.
-- ============================================================================

CREATE TABLE "account_deputies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "principal_account_id" UUID NOT NULL,
    "deputy_account_id" UUID NOT NULL,
    "permissions" TEXT[] NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "ended_by_account_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_deputies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_deputies_tenant_id_id_key"
  ON "account_deputies"("tenant_id", "id");
-- One live deputy per principal, and one live deputyship per deputy.
CREATE UNIQUE INDEX "account_deputies_one_per_principal"
  ON "account_deputies"("tenant_id", "principal_account_id") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "account_deputies_one_per_deputy"
  ON "account_deputies"("tenant_id", "deputy_account_id") WHERE "ended_at" IS NULL;
CREATE INDEX "account_deputies_live_ends_idx"
  ON "account_deputies"("tenant_id", "ends_at") WHERE "ended_at" IS NULL;
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_principal_fkey"
  FOREIGN KEY ("tenant_id", "principal_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_deputy_fkey"
  FOREIGN KEY ("tenant_id", "deputy_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Two people; at least one permission and at most the catalog's; at most 30
-- days, ending after it starts.
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_shape"
  CHECK ("principal_account_id" <> "deputy_account_id"
     AND cardinality("permissions") BETWEEN 1 AND 200
     AND "ends_at" > "starts_at"
     AND "ends_at" <= "starts_at" + interval '30 days');
-- Live, or ended once with a reason (by someone, unless it ran out or its
-- people left).
ALTER TABLE "account_deputies" ADD CONSTRAINT "account_deputies_end_shape"
  CHECK (("ended_at" IS NULL AND "end_reason" IS NULL AND "ended_by_account_id" IS NULL)
      OR ("ended_at" IS NOT NULL AND "end_reason" IS NOT NULL
          AND "end_reason" IN ('ended', 'expired', 'account_left')
          AND (("end_reason" = 'ended') = ("ended_by_account_id" IS NOT NULL))));

CREATE FUNCTION account_deputies_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."principal_account_id" IS DISTINCT FROM OLD."principal_account_id"
     OR NEW."deputy_account_id" IS DISTINCT FROM OLD."deputy_account_id"
     OR NEW."permissions" IS DISTINCT FROM OLD."permissions"
     OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at"
     OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
     OR NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'account_deputies: the terms are fixed';
  END IF;
  IF OLD."ended_at" IS NOT NULL THEN
    RAISE EXCEPTION 'account_deputies: ended once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deputies_end_once
  BEFORE UPDATE ON "account_deputies"
  FOR EACH ROW EXECUTE FUNCTION account_deputies_end_once();
CREATE TRIGGER account_deputies_no_delete
  BEFORE DELETE ON "account_deputies"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER account_deputies_no_truncate
  BEFORE TRUNCATE ON "account_deputies"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Until when an account has a live deputyship, as principal or deputy: the
-- latest end of its live ones, kept in step by every appointment and end
-- under the account's lock. The guard reads the account on every request
-- and its deputyships only while this is ahead, so an account with none
-- pays nothing for them.
-- ----------------------------------------------------------------------------
ALTER TABLE "accounts" ADD COLUMN "deputy_until" TIMESTAMPTZ(3);

-- ----------------------------------------------------------------------------
-- The audit log says when an action was taken through a deputy's gained
-- permission: the principal it was taken for. Null for every other entry.
-- ----------------------------------------------------------------------------
ALTER TABLE "audit_log" ADD COLUMN "on_behalf_of_id" UUID;

-- ----------------------------------------------------------------------------
-- Grants and RLS. Made once, ended once under FOR UPDATE; never deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "account_deputies" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_deputies" TO jiwar_app;
ALTER TABLE "account_deputies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_deputies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_deputies"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
