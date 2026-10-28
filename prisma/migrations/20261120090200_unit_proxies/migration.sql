-- ============================================================================
-- Unit proxies (ADR 0063)
-- ============================================================================
--
-- An active owner occupancy (never a delegate) appoints a proxy for the
-- unit: an outside person, by name, email, phone and identity document
-- (their account's, as a household invite's), with scopes and an
-- end (a year at most). The owner gets a link once; the person opens it,
-- receives a code at that email, and accepts: their own `proxy` account
-- holds them from then on, and the invite's personal data goes. At most
-- two live (invited or active) per unit, under the unit's lock.
--
-- A proxy acts only while the unit is closed or has no primary, and ends
-- once: revoked by an owner, expired, at an ownership transfer or the
-- household's end, when the owner who appointed it leaves, or with the
-- erasure of either account. An unanswered invite ends after 7 days.
--
-- The invite's pointer is global (the link is read before the compound is
-- known): the HMAC of its token, deleted when the invite is accepted or
-- ends.

CREATE TABLE "unit_proxies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "appointed_by_occupancy_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "full_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "id_document_type" "id_document_type",
    "id_document_number" TEXT,
    "nationality" CHAR(2),
    "birth_date" DATE,
    "invite_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "account_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "ended_by" UUID,
    CONSTRAINT "unit_proxies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_proxies_tenant_id_id_key" ON "unit_proxies"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_proxies_one_active_per_account"
  ON "unit_proxies"("unit_id", "account_id") WHERE "status" = 'active';
CREATE INDEX "unit_proxies_unit_idx" ON "unit_proxies"("tenant_id", "unit_id", "created_at" DESC);
CREATE INDEX "unit_proxies_account_idx" ON "unit_proxies"("tenant_id", "account_id")
  WHERE "account_id" IS NOT NULL;
CREATE INDEX "unit_proxies_live_idx" ON "unit_proxies"("tenant_id", "expires_at")
  WHERE "status" IN ('invited', 'active');
ALTER TABLE "unit_proxies"
  ADD CONSTRAINT "unit_proxies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_proxies_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_proxies_appointed_by_fkey"
  FOREIGN KEY ("tenant_id", "appointed_by_occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_proxies_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_proxies_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_proxies_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Its scopes are a closed list (REASON-like, PROXY_SCOPES in code), one to five.
ALTER TABLE "unit_proxies" ADD CONSTRAINT "unit_proxies_scopes"
  CHECK (cardinality("scopes") BETWEEN 1 AND 5
     AND "scopes" <@ ARRAY['inspections', 'tickets', 'visitors_invite', 'works', 'requests']::text[]);
-- A year at most; the invite answered within its 7 days.
ALTER TABLE "unit_proxies" ADD CONSTRAINT "unit_proxies_dates"
  CHECK ("expires_at" > "created_at"
     AND "expires_at" <= "created_at" + interval '366 days'
     AND "invite_expires_at" > "created_at"
     AND ("accepted_at" IS NULL OR "accepted_at" >= "created_at")
     AND ("ended_at" IS NULL OR "ended_at" >= "created_at"));
-- Invited: the person's details, no account. Active: the account, the
-- details gone. Ended: why and when; the details gone.
ALTER TABLE "unit_proxies" ADD CONSTRAINT "unit_proxies_state_shape"
  CHECK ("status" IN ('invited', 'active', 'ended')
     AND ("status" = 'invited') = ("full_name" IS NOT NULL)
     AND ("full_name" IS NULL) = ("email" IS NULL)
     AND ("full_name" IS NULL) = ("phone" IS NULL)
     AND ("full_name" IS NULL) = ("id_document_type" IS NULL)
     AND ("full_name" IS NULL) = ("id_document_number" IS NULL)
     AND ("full_name" IS NULL) = ("nationality" IS NULL)
     AND ("birth_date" IS NULL OR "full_name" IS NOT NULL)
     AND ("status" <> 'invited' OR ("account_id" IS NULL AND "accepted_at" IS NULL))
     AND ("status" <> 'active' OR ("account_id" IS NOT NULL AND "accepted_at" IS NOT NULL))
     AND ("account_id" IS NULL) = ("accepted_at" IS NULL)
     AND ("status" = 'ended') = ("ended_at" IS NOT NULL)
     AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("ended_by" IS NULL OR "ended_at" IS NOT NULL)
     AND ("end_reason" IS NULL OR "end_reason" IN (
           'revoked', 'expired', 'invite_expired', 'ownership_transferred',
           'household_ended', 'appointer_left', 'erased')));
CREATE FUNCTION unit_proxy_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."appointed_by_occupancy_id" = OLD."appointed_by_occupancy_id"
     AND NEW."created_by" = OLD."created_by"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."scopes" = OLD."scopes"
     AND NEW."expires_at" = OLD."expires_at"
     AND NEW."invite_expires_at" = OLD."invite_expires_at"
     -- Invited, then accepted or ended; accepted, then ended; once each.
     AND ((OLD."status" = 'invited' AND NEW."status" IN ('active', 'ended'))
          OR (OLD."status" = 'active' AND NEW."status" = 'ended'
              AND NEW."account_id" = OLD."account_id"
              AND NEW."accepted_at" = OLD."accepted_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_proxies: a proxy is invited, accepted and ended once each, and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_proxies_move_forward
  BEFORE UPDATE OR DELETE ON "unit_proxies"
  FOR EACH ROW EXECUTE FUNCTION unit_proxy_moves_forward();
CREATE TRIGGER unit_proxies_no_truncate
  BEFORE TRUNCATE ON "unit_proxies"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
GRANT SELECT, INSERT, UPDATE ON "unit_proxies" TO jiwar_app;
ALTER TABLE "unit_proxies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_proxies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_proxies"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- The invite link's pointer: global, the HMAC of its token, one per invite.
-- ----------------------------------------------------------------------------
CREATE TABLE "proxy_invite_tokens" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "proxy_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "proxy_invite_tokens_pkey" PRIMARY KEY ("token_hash")
);
CREATE UNIQUE INDEX "proxy_invite_tokens_one_per_proxy"
  ON "proxy_invite_tokens"("tenant_id", "proxy_id");
ALTER TABLE "proxy_invite_tokens"
  ADD CONSTRAINT "proxy_invite_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "proxy_invite_tokens_proxy_fkey"
  FOREIGN KEY ("tenant_id", "proxy_id") REFERENCES "unit_proxies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "proxy_invite_tokens" ADD CONSTRAINT "proxy_invite_tokens_token_hash_hex"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
REVOKE ALL ON "proxy_invite_tokens" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "proxy_invite_tokens" TO jiwar_app;
