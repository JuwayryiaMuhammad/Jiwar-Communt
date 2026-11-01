-- ============================================================================
-- Weighted polls (ADR 0075).
--
-- The manager records each unit's ownership share (a percentage, up to four
-- decimals; the shares need not add up to 100). A poll is weighted by unit
-- (one unit, one vote: the default, and always for an election) or by
-- share, fixed when it is created. A poll weighted by share is never
-- secret: a share can be unique to its unit, so a weight next to a secret
-- ballot would name the unit (ADR 0051's secret box). When it opens, each
-- elector's weight is the unit's share then (zero when none was recorded);
-- the poll keeps the electorate's total weight, and at the close the
-- turnout's and each option's. Quorum and threshold are reckoned on those.
-- ============================================================================

CREATE TABLE "governance_unit_shares" (
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "share" DECIMAL(9,4) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_unit_shares_pkey" PRIMARY KEY ("tenant_id", "unit_id")
);
ALTER TABLE "governance_unit_shares"
  ADD CONSTRAINT "governance_unit_shares_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_unit_shares_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_unit_shares_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- UNIT_SHARE_LIMITS; a unit test keeps them in step.
ALTER TABLE "governance_unit_shares" ADD CONSTRAINT "governance_unit_shares_share"
  CHECK ("share" > 0 AND "share" <= 100);

-- The poll's weighting, fixed at creation.
ALTER TABLE "governance_polls"
  ADD COLUMN "weighting" TEXT NOT NULL DEFAULT 'unit',
  ADD COLUMN "electorate_weight" DECIMAL(14,4),
  ADD COLUMN "turnout_weight" DECIMAL(14,4);
-- POLL_WEIGHTINGS; a unit test keeps them in step. The weights only on a
-- poll weighted by share: the electorate's at the open, the turnout's with
-- the result.
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_weighting"
  CHECK ("weighting" IN ('unit', 'share')
     AND ("electorate_weight" IS NULL OR ("weighting" = 'share' AND "electorate_weight" >= 0))
     AND ("turnout_weight" IS NULL OR ("electorate_weight" IS NOT NULL AND "turnout_weight" >= 0
                                       AND "turnout_weight" <= "electorate_weight")));
ALTER TABLE "governance_poll_options" ADD COLUMN "final_weight" DECIMAL(14,4);
ALTER TABLE "governance_poll_options" ADD CONSTRAINT "governance_poll_options_final_weight"
  CHECK ("final_weight" IS NULL OR ("final_count" IS NOT NULL AND "final_weight" >= 0));
-- Each elector's weight, taken with the electorate; null on a contest
-- weighted by unit.
ALTER TABLE "governance_electors" ADD COLUMN "weight" DECIMAL(9,4);
ALTER TABLE "governance_electors" ADD CONSTRAINT "governance_electors_weight"
  CHECK ("weight" IS NULL OR ("weight" >= 0 AND "weight" <= 100));

-- A poll weighted by share is never secret, and its weighting never
-- changes. Checked when it is written (its contest is written first).
CREATE FUNCTION governance_poll_weighting_open() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."weighting" <> OLD."weighting" THEN
    RAISE EXCEPTION 'governance_polls: the weighting is fixed at creation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."weighting" = 'share' AND EXISTS (
       SELECT 1 FROM "governance_contests" c
        WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = NEW."contest_id" AND c."secret") THEN
    RAISE EXCEPTION 'governance_polls: a poll weighted by share is never secret'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER governance_polls_weighting_open
  BEFORE INSERT OR UPDATE ON "governance_polls"
  FOR EACH ROW EXECUTE FUNCTION governance_poll_weighting_open();

-- The poll's moves (ADR 0051), now with its weights: the electorate's
-- written once (at the open), the turnout's once with the result.
CREATE OR REPLACE FUNCTION governance_poll_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  opened boolean;
BEGIN
  SELECT c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL INTO opened
    FROM "governance_contests" c
   WHERE c."tenant_id" = OLD."tenant_id" AND c."id" = OLD."contest_id";
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contest_id" = OLD."contest_id" AND NEW."number" = OLD."number"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."weighting" = OLD."weighting"
     AND ((NEW."kind" = OLD."kind"
           AND NEW."title_en" IS NOT DISTINCT FROM OLD."title_en"
           AND NEW."title_ar" IS NOT DISTINCT FROM OLD."title_ar"
           AND NEW."body_en" IS NOT DISTINCT FROM OLD."body_en"
           AND NEW."body_ar" IS NOT DISTINCT FROM OLD."body_ar"
           AND NEW."quorum_pct" = OLD."quorum_pct"
           AND NEW."threshold_pct" = OLD."threshold_pct")
          OR NOT opened)
     AND (NEW."electorate_weight" IS NOT DISTINCT FROM OLD."electorate_weight"
          OR OLD."electorate_weight" IS NULL)
     AND ((NEW."result" IS NOT DISTINCT FROM OLD."result"
           AND NEW."winning_option_id" IS NOT DISTINCT FROM OLD."winning_option_id"
           AND NEW."turnout_weight" IS NOT DISTINCT FROM OLD."turnout_weight")
          OR OLD."result" IS NULL)
     AND ((NEW."cancel_reason_code" IS NOT DISTINCT FROM OLD."cancel_reason_code"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id")
          OR OLD."cancel_reason_code" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_polls: once open, a poll is only cancelled or counted, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- An option's count and weight, once each, at the close.
CREATE OR REPLACE FUNCTION governance_poll_option_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
  opened boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN r := NEW; ELSE r := OLD; END IF;
  SELECT c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL INTO opened
    FROM "governance_polls" p
    JOIN "governance_contests" c ON c."tenant_id" = p."tenant_id" AND c."id" = p."contest_id"
   WHERE p."tenant_id" = r."tenant_id" AND p."id" = r."poll_id";
  IF NOT opened THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."poll_id" = OLD."poll_id" AND NEW."position" = OLD."position"
     AND NEW."key" IS NOT DISTINCT FROM OLD."key"
     AND NEW."label_en" IS NOT DISTINCT FROM OLD."label_en"
     AND NEW."label_ar" IS NOT DISTINCT FROM OLD."label_ar"
     AND (NEW."final_count" IS NOT DISTINCT FROM OLD."final_count"
          OR OLD."final_count" IS NULL)
     AND (NEW."final_weight" IS NOT DISTINCT FROM OLD."final_weight"
          OR OLD."final_weight" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_poll_options: fixed once the poll opened, but for its count (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON "governance_unit_shares" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "governance_unit_shares" TO jiwar_app;
ALTER TABLE "governance_unit_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance_unit_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "governance_unit_shares"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
