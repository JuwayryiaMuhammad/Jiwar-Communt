-- ============================================================================
-- Phase R6a — online payment (ADR 0046). A checkout session pays a unit's
-- chosen invoices through the compound's own Paymob account (hosted
-- checkout): one live session per unit; its Paymob client secret is stored
-- sealed by the vault, never in plain text. The Paymob webhook is the only
-- thing that turns a session into a payment, after its HMAC and a mandatory
-- check with Paymob; every callback that passed the HMAC is logged.
-- ============================================================================

CREATE TYPE "payment_session_status" AS ENUM (
  'opening', 'open', 'succeeded', 'failed', 'expired', 'superseded'
);

CREATE TABLE "payment_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "payment_session_status" NOT NULL,
    "dedupe_key" CHAR(64) NOT NULL,
    "special_reference" TEXT NOT NULL,
    "intention_id" TEXT,
    "gateway_order_id" TEXT,
    "client_secret_enc" BYTEA,
    "key_version" INTEGER,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "payment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_sessions_tenant_id_id_key" ON "payment_sessions"("tenant_id", "id");
CREATE UNIQUE INDEX "payment_sessions_special_reference_key" ON "payment_sessions"("special_reference");
-- One live session per unit.
CREATE UNIQUE INDEX "payment_sessions_one_live_per_unit"
  ON "payment_sessions"("tenant_id", "unit_id") WHERE "status" IN ('opening', 'open');
CREATE UNIQUE INDEX "payment_sessions_payment_id_key" ON "payment_sessions"("tenant_id", "payment_id");
CREATE INDEX "payment_sessions_unit_idx" ON "payment_sessions"("tenant_id", "unit_id", "created_at");
CREATE INDEX "payment_sessions_expiry_idx" ON "payment_sessions"("expires_at") WHERE "status" = 'open';
ALTER TABLE "payment_sessions"
  ADD CONSTRAINT "payment_sessions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "payment_sessions_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_currency"
  CHECK ("currency" = 'EGP');
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_reference_shape"
  CHECK ("special_reference" ~ '^jw-[0-9a-f-]{36}$');
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_dedupe_shape"
  CHECK ("dedupe_key" ~ '^[0-9a-f]{64}$');
-- The sealed client secret and its key version, together.
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_secret_shape"
  CHECK (("client_secret_enc" IS NULL) = ("key_version" IS NULL));
-- Opening has nothing from Paymob yet; open and later states that went
-- through Paymob have the intention and its sealed secret; a success names
-- its payment; everything past open is resolved.
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_status_shape"
  CHECK (("status" = 'opening') <= ("intention_id" IS NULL AND "client_secret_enc" IS NULL)
     AND ("status" IN ('open', 'succeeded')) <= ("intention_id" IS NOT NULL AND "client_secret_enc" IS NOT NULL)
     AND ("status" = 'succeeded') = ("payment_id" IS NOT NULL)
     AND ("status" IN ('opening', 'open')) = ("resolved_at" IS NULL));

-- Only the status moves, along these edges; Paymob's fields are set once,
-- with the move to open; the payment once, with the success.
CREATE FUNCTION payment_session_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id" AND NEW."account_id" = OLD."account_id"
     AND NEW."amount" = OLD."amount" AND NEW."currency" = OLD."currency"
     AND NEW."dedupe_key" = OLD."dedupe_key"
     AND NEW."special_reference" = OLD."special_reference"
     AND NEW."expires_at" = OLD."expires_at" AND NEW."created_at" = OLD."created_at"
     AND (OLD."intention_id" IS NULL OR NEW."intention_id" IS NOT DISTINCT FROM OLD."intention_id")
     AND (OLD."gateway_order_id" IS NULL OR NEW."gateway_order_id" IS NOT DISTINCT FROM OLD."gateway_order_id")
     AND (OLD."client_secret_enc" IS NULL OR NEW."client_secret_enc" IS NOT DISTINCT FROM OLD."client_secret_enc")
     AND (OLD."key_version" IS NULL OR NEW."key_version" IS NOT DISTINCT FROM OLD."key_version")
     AND (OLD."payment_id" IS NULL OR NEW."payment_id" IS NOT DISTINCT FROM OLD."payment_id")
     AND (OLD."resolved_at" IS NULL OR NEW."resolved_at" IS NOT DISTINCT FROM OLD."resolved_at"
          OR (OLD."status" IN ('expired', 'superseded') AND NEW."status" = 'succeeded'))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'opening' AND NEW."status" IN ('open', 'failed', 'superseded'))
          OR (OLD."status" = 'open' AND NEW."status" IN ('succeeded', 'expired', 'superseded'))
          OR (OLD."status" IN ('expired', 'superseded') AND NEW."status" = 'succeeded')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment_sessions: % → % is not a move a session makes (%)', OLD."status", NEW."status", TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER payment_sessions_moves
  BEFORE UPDATE OR DELETE ON "payment_sessions"
  FOR EACH ROW EXECUTE FUNCTION payment_session_moves();
CREATE TRIGGER payment_sessions_moves_truncate
  BEFORE TRUNCATE ON "payment_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- What a session pays: its invoices and what each owed when it opened.
-- Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "payment_session_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "payment_session_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_session_invoices_tenant_id_id_key" ON "payment_session_invoices"("tenant_id", "id");
CREATE UNIQUE INDEX "payment_session_invoices_once"
  ON "payment_session_invoices"("tenant_id", "session_id", "invoice_id");
ALTER TABLE "payment_session_invoices"
  ADD CONSTRAINT "payment_session_invoices_tenant_id_session_id_fkey"
  FOREIGN KEY ("tenant_id", "session_id") REFERENCES "payment_sessions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "payment_session_invoices_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payment_session_invoices" ADD CONSTRAINT "payment_session_invoices_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
CREATE TRIGGER payment_session_invoices_immutable_rows
  BEFORE UPDATE OR DELETE ON "payment_session_invoices"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER payment_session_invoices_immutable_truncate
  BEFORE TRUNCATE ON "payment_session_invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Every Paymob callback that passed the HMAC, and what came of it. Signed
-- scalar fields only: no card digits, no billing data. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "payment_gateway_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID,
    "gateway_transaction_id" TEXT NOT NULL,
    "gateway_order_id" TEXT,
    "amount_cents" BIGINT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "pending" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_gateway_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_gateway_events_tenant_id_id_key" ON "payment_gateway_events"("tenant_id", "id");
CREATE INDEX "payment_gateway_events_session_idx" ON "payment_gateway_events"("tenant_id", "session_id", "created_at");
CREATE INDEX "payment_gateway_events_created_idx" ON "payment_gateway_events"("tenant_id", "created_at", "id");
CREATE INDEX "payment_gateway_events_pending_idx" ON "payment_gateway_events"("created_at")
  WHERE "outcome" = 'verification_pending';
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_tenant_id_session_id_fkey"
  FOREIGN KEY ("tenant_id", "session_id") REFERENCES "payment_sessions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_transaction_shape"
  CHECK ("gateway_transaction_id" ~ '^[0-9]{1,20}$');
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_order_shape"
  CHECK ("gateway_order_id" IS NULL OR "gateway_order_id" ~ '^[0-9]{1,20}$');
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_outcome"
  CHECK ("outcome" IN ('applied', 'duplicate', 'failed_attempt', 'not_final',
                       'verification_pending', 'contradicted', 'order_mismatch',
                       'amount_mismatch', 'unknown_reference'));
CREATE TRIGGER payment_gateway_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "payment_gateway_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER payment_gateway_events_immutable_truncate
  BEFORE TRUNCATE ON "payment_gateway_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An online payment: card or wallet, its checkout and Paymob's transaction
-- (once per compound: the claim that makes a replayed callback a no-op), its
-- payer; nobody records it.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_payments"
  ADD COLUMN "session_id" UUID,
  ADD COLUMN "gateway_transaction_id" TEXT,
  ADD COLUMN "payer_account_id" UUID;
ALTER TABLE "finance_payments"
  ADD CONSTRAINT "finance_payments_tenant_id_session_id_fkey"
  FOREIGN KEY ("tenant_id", "session_id") REFERENCES "payment_sessions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_payments_tenant_id_payer_fkey"
  FOREIGN KEY ("tenant_id", "payer_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "finance_payments_gateway_transaction_key"
  ON "finance_payments"("tenant_id", "gateway_transaction_id")
  WHERE "gateway_transaction_id" IS NOT NULL;
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_online_shape"
  CHECK (("channel" = 'online') IS NOT TRUE
      OR ("method" IN ('card', 'wallet') AND "session_id" IS NOT NULL
          AND "gateway_transaction_id" IS NOT NULL AND "payer_account_id" IS NOT NULL
          AND "recorded_by_account_id" IS NULL));
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_offline_shape"
  CHECK (("channel" = 'online') IS TRUE
      OR ("session_id" IS NULL AND "gateway_transaction_id" IS NULL AND "payer_account_id" IS NULL));
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_transaction_shape"
  CHECK ("gateway_transaction_id" IS NULL OR "gateway_transaction_id" ~ '^[0-9]{1,20}$');
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_tenant_id_payment_id_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted; a session's status moves.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "payment_sessions", "payment_session_invoices", "payment_gateway_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "payment_sessions" TO jiwar_app;
GRANT SELECT, INSERT ON "payment_session_invoices", "payment_gateway_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_sessions', 'payment_session_invoices', 'payment_gateway_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
