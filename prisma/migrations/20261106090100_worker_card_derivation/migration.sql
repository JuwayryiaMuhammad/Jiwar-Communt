-- ============================================================================
-- A worker card's token is derived (ADR 0057), as a visitor pass's is
-- (ADR 0043): base64url(HMAC-SHA256(key_v, "engagement:<tenant>:<id>:<seq>")).
-- The gate's offline bundle derives it again to carry what a guard device
-- needs to know the card; the server still stores only the code's and the
-- token's HMACs, and no route shows a card again.
--
-- `token_seq` numbers the engagement's cards; `token_key_version` names the
-- key of ENGAGEMENT_TOKEN_KEYS it was derived with, so a rotation derives
-- new and reissued cards only and never kills a printed one. Both or
-- neither: a card issued before this migration is random and stays so
-- until it is reissued. Nothing is backfilled: those tokens were never
-- stored and cannot be.
-- ============================================================================

ALTER TABLE "worker_engagements"
  ADD COLUMN "token_seq" INTEGER,
  ADD COLUMN "token_key_version" SMALLINT;

ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "worker_engagements_token_derivation"
    CHECK ((("token_seq" IS NULL) = ("token_key_version" IS NULL))
       AND ("token_seq" IS NULL OR "token_seq" > 0)
       AND ("token_key_version" IS NULL OR "token_key_version" BETWEEN 1 AND 32767));
