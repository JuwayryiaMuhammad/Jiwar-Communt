-- ============================================================================
-- Phase R1 — consents (ADR 0036).
--
-- A closed catalog of codes in code (CONSENT_CATALOG), each with a version.
-- `consent_events` is append-only: every grant and revocation, with the
-- version of the text it answered, who acted (the account, a manager for it
-- with a reason code, or the system) — codes and ids only. The current state
-- is the projection `account_consents`, written in the same transaction as
-- each event and rebuildable from the events alone. A grant counts only
-- while its version is the catalog's current one, so bumping a version
-- makes earlier grants stop counting until granted again.
-- ============================================================================

CREATE TYPE "consent_action" AS ENUM ('grant', 'revoke');
CREATE TYPE "consent_actor_type" AS ENUM ('account', 'system');

CREATE TABLE "consent_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "consent_action" NOT NULL,
    "actor_type" "consent_actor_type" NOT NULL,
    "actor_account_id" UUID,
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "assist_reason_code" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_events_account_idx"
  ON "consent_events"("tenant_id", "account_id", "occurred_at", "id");
-- The catalog (a unit test keeps this list and CONSENT_CATALOG in step).
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_code_known"
  CHECK ("code" IN ('ticket_phone_share'));
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_version_positive"
  CHECK ("version" >= 1);
-- An assisted event names its reason, and was written by another account;
-- the account's own event names the account; the system names nobody.
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_actor_shape"
  CHECK ("assisted" = ("assist_reason_code" IS NOT NULL)
     AND (("actor_type" = 'system' AND "actor_account_id" IS NULL AND NOT "assisted")
       OR ("actor_type" = 'account' AND "actor_account_id" IS NOT NULL
           AND ("assisted" = ("actor_account_id" <> "account_id")))));

CREATE TRIGGER consent_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "consent_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER consent_events_immutable_truncate
  BEFORE TRUNCATE ON "consent_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "account_consents" (
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "granted_version" INTEGER,
    "granted_at" TIMESTAMPTZ(3),
    "last_event_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "account_consents_pkey" PRIMARY KEY ("tenant_id", "account_id", "code")
);
ALTER TABLE "account_consents"
  ADD CONSTRAINT "account_consents_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_consents" ADD CONSTRAINT "account_consents_code_known"
  CHECK ("code" IN ('ticket_phone_share'));
ALTER TABLE "account_consents" ADD CONSTRAINT "account_consents_granted_shape"
  CHECK (("granted_version" IS NULL) = ("granted_at" IS NULL)
     AND ("granted_version" IS NULL OR "granted_version" >= 1));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. The events: SELECT and INSERT only.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "consent_events", "account_consents" FROM jiwar_app;
GRANT SELECT, INSERT ON "consent_events" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_consents" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consent_events', 'account_consents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
