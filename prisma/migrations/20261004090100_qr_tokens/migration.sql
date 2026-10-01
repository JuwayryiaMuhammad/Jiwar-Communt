-- ============================================================================
-- Phase 4.1 — QR entry (ADR 0030). One random token per pass and per worker
-- engagement; the short code is derived from it. Only HMACs are stored:
-- - qr_token_hash = HMAC(pepper, "qr:<tenantId>:<token>"), the gate's lookup,
--   present exactly while the code is (and only on rows issued since 4.1);
-- - visitor_pass_links: a global pointer HMAC(pepper, "visitor-link:<token>")
--   → (compound, pass), read by the public visitor page before any tenant is
--   known, like invite_tokens. It outlives the code so the page can say the
--   pass was used, expired or cancelled; it is deleted 30 days after the end.
-- ============================================================================

ALTER TABLE "visitor_passes" ADD COLUMN "qr_token_hash" CHAR(64);
-- A token only next to a live code; legacy passes have a code and no token.
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_token_only_with_code"
  CHECK ("qr_token_hash" IS NULL OR ("status" = 'active' AND "code_hash" IS NOT NULL));
CREATE UNIQUE INDEX "visitor_passes_active_qr"
  ON "visitor_passes"("tenant_id", "qr_token_hash") WHERE "qr_token_hash" IS NOT NULL;

ALTER TABLE "worker_engagements" ADD COLUMN "qr_token_hash" CHAR(64);
-- Suspension keeps the token like it keeps the code; end and rejection clear both.
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_token_only_with_code"
  CHECK ("qr_token_hash" IS NULL
         OR ("status" IN ('active', 'suspended') AND "access_code_hash" IS NOT NULL));
CREATE UNIQUE INDEX "worker_engagements_active_qr"
  ON "worker_engagements"("tenant_id", "qr_token_hash") WHERE "status" = 'active';

-- A code is never rotated without its token: an old QR would otherwise keep
-- naming the row after a reissue. (A cleared code clears the token through
-- the CHECKs above.)
CREATE FUNCTION visitor_passes_code_rotates_with_token() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."code_hash" IS NOT NULL
     AND NEW."code_hash" IS DISTINCT FROM OLD."code_hash"
     AND OLD."qr_token_hash" IS NOT NULL
     AND NEW."qr_token_hash" IS NOT DISTINCT FROM OLD."qr_token_hash" THEN
    RAISE EXCEPTION 'a visitor pass code changed without its token';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visitor_passes_code_rotates_with_token
  BEFORE UPDATE OF "code_hash", "qr_token_hash" ON "visitor_passes"
  FOR EACH ROW EXECUTE FUNCTION visitor_passes_code_rotates_with_token();

CREATE FUNCTION worker_engagements_code_rotates_with_token() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."access_code_hash" IS NOT NULL
     AND NEW."access_code_hash" IS DISTINCT FROM OLD."access_code_hash"
     AND OLD."qr_token_hash" IS NOT NULL
     AND NEW."qr_token_hash" IS NOT DISTINCT FROM OLD."qr_token_hash" THEN
    RAISE EXCEPTION 'a worker access code changed without its token';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_engagements_code_rotates_with_token
  BEFORE UPDATE OF "access_code_hash", "qr_token_hash" ON "worker_engagements"
  FOR EACH ROW EXECUTE FUNCTION worker_engagements_code_rotates_with_token();

-- Global, like invite_tokens: no RLS, no personal data.
CREATE TABLE "visitor_pass_links" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pass_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visitor_pass_links_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "visitor_pass_links_pass_id_idx" ON "visitor_pass_links"("pass_id");
CREATE INDEX "visitor_pass_links_expires_at_idx" ON "visitor_pass_links"("expires_at");
ALTER TABLE "visitor_pass_links" ADD CONSTRAINT "visitor_pass_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Inserted with the pass, deleted when a link is reissued or retained no longer.
REVOKE UPDATE ON "visitor_pass_links" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "visitor_pass_links" TO jiwar_app;

ALTER TABLE "gate_entries" DROP CONSTRAINT "gate_entries_method_matches_direction";
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_method_matches_direction"
  CHECK (("direction" = 'in') = ("method" IN ('code', 'qr', 'approval')));

-- What the compound tells its visitors (the public page), set by managers.
ALTER TABLE "tenant_settings"
  ADD COLUMN "visitor_directions" TEXT,
  ADD COLUMN "emergency_phone" TEXT;
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_visitor_directions_length"
  CHECK ("visitor_directions" IS NULL OR char_length("visitor_directions") BETWEEN 1 AND 2000);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_emergency_phone_e164"
  CHECK ("emergency_phone" IS NULL OR "emergency_phone" ~ '^\+[1-9][0-9]{6,14}$');
